import { existsSync } from "node:fs";

import { createModelCall } from "./bedrock.js";
import { buildExtractPrompt, MalformedOutput, parseModelOutput } from "./extract-prompt.js";
import { localDateParts } from "./parse.js";
import { openIndex, SESSION_STARTS_WITH_THE_FACTS_PREFIX } from "./search-index.js";
import { recordedProjectsUnder, salientTermsQuery } from "./search.js";
import { createStateStore } from "./state.js";
import { createSpendLog } from "./spend.js";
import { createTopicStore } from "./toc.js";
import { chunkTurns, unreadSlice } from "./transcript.js";

export const CANDIDATE_TOPICS_IN_A_PROMPT = 10;
export const KNOWN_FACTS_IN_A_PROMPT = 20;

const FACTS_SCANNED_FOR_CANDIDATES = 200;
const SAME_PROJECT_BOOST = 2;
const CHARS_PER_MODEL_CALL = 300_000;

const EXTRACTION_MODEL_THEN_FALLBACK = [
  "global.anthropic.claude-sonnet-5",
  "global.anthropic.claude-opus-5",
];
const SHORTEST_MEANINGFUL_TURN = 5;
const TURNS_WORTH_EXTRACTING = 2;

// --- The model call ---

export function bedrockBilledToOurOwnProfile(config, options = {}) {
  const spend = createSpendLog(config);
  return createModelCall(config, { onUsage: (usage) => spend.record(usage), ...options });
}

// --- Extraction ---

export function createExtractor(
  config,
  {
    callModel = bedrockBilledToOurOwnProfile(config),
    maxChunkChars = CHARS_PER_MODEL_CALL,
    candidateLimit = CANDIDATE_TOPICS_IN_A_PROMPT,
    factLimit = KNOWN_FACTS_IN_A_PROMPT,
    timeZone,
    log = () => {},
  } = {}
) {
  const index = openIndex(config, { timeZone });
  const db = index.db;
  const state = createStateStore(config);
  const topics = createTopicStore(config);

  function extractSession(session) {
    const { session_id: sessionId, transcript: transcriptPath, cwd: project = null } = session;

    if (!sessionId) return outcome("unidentified");
    if (state.isQuarantined(sessionId)) return outcome("quarantined", { sessionId });
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return outcome("no-transcript", { sessionId });
    }

    const slice = unreadSlice(transcriptPath, state.extractionOffset(sessionId));
    const turns = slice.turns.filter((turn) => turn.text.length > SHORTEST_MEANINGFUL_TURN);
    if (turns.length < TURNS_WORTH_EXTRACTING) {
      state.recordExtraction(sessionId, { offset: slice.offset });
      return outcome("nothing-to-extract", { sessionId, offset: slice.offset });
    }

    const { candidates, knownFacts } = promptContextFromAFreshIndex(slice.text, project);
    const prompt = buildExtractPrompt({ candidates, knownFacts });
    const chunks = chunkTurns(turns, maxChunkChars);

    let results;
    try {
      results = chunks.map((chunk) => extractChunk(prompt, chunk, sessionId));
    } catch (error) {
      const failure = state.recordFailure(sessionId, error.message);
      return outcome(failure.quarantined ? "quarantined" : "failed", {
        sessionId,
        candidates,
        chunks: chunks.length,
        attempts: failure.attempts,
        error: error.message,
      });
    }

    const extracted = mergedByTopic(results);
    if (!extracted.length) {
      state.recordExtraction(sessionId, { offset: slice.offset });
      return outcome("nothing-to-extract", { sessionId, offset: slice.offset });
    }

    const happenedOn = whenTheConversationHappened(slice, session);
    const written = extracted.map((merged) => ({
      ...merged,
      topic: { ...merged.topic, id: appendToCorpus(merged, sessionId, candidates, happenedOn) },
    }));

    state.recordExtraction(sessionId, {
      offset: slice.offset,
      result: everythingWritten(written),
    });

    return outcome("extracted", {
      sessionId,
      topic: written[0].topic.id,
      topics: written.map((merged) => merged.topic.id),
      candidates,
      knownFacts: knownFacts.length,
      chunks: chunks.length,
      context: written.reduce((total, merged) => total + merged.context.length, 0),
      decisions: written.reduce((total, merged) => total + merged.decisions.length, 0),
      offset: slice.offset,
    });
  }

  function extractChunk(prompt, chunk, sessionId) {
    let lastError;
    for (const model of EXTRACTION_MODEL_THEN_FALLBACK) {
      try {
        return parseModelOutput(callModel({ prompt: prompt + chunk, model, chunk, sessionId }));
      } catch (error) {
        log(`  ${model} failed: ${error.message}`);
        if (error instanceof MalformedOutput) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  function promptContextFromAFreshIndex(text, project) {
    index.refresh();

    const match = salientTermsQuery(text);
    if (!match) return { candidates: [], knownFacts: [] };

    const ranked = factsRankedAgainst(match);
    const candidates = rankedCandidates(ranked, project);
    const chosen = new Set(candidates.map((candidate) => candidate.topic));
    const knownFacts = ranked
      .filter((row) => chosen.has(row.topic))
      .slice(0, factLimit)
      .map((row) => ({ topic: row.topic, section: row.section, text: row.text }));

    return { candidates, knownFacts };
  }

  function factsRankedAgainst(match) {
    return db
      .prepare(
        `select f.topic as topic, f.section as section, f.text as text, bm25(facts_fts) as rank
         from facts_fts join facts f on f.id = facts_fts.rowid
         where facts_fts match ?
         order by bm25(facts_fts), f.date desc limit ?`
      )
      .all(match, FACTS_SCANNED_FOR_CANDIDATES);
  }

  function rankedCandidates(ranked, project) {
    const nearby = topicsOfProject(project);
    const byTopic = new Map();

    for (const row of ranked) {
      const entry = byTopic.get(row.topic) ?? {
        topic: row.topic,
        facts: 0,
        bestFactScore: 0,
        sameProject: nearby.has(row.topic),
      };
      entry.facts++;
      entry.bestFactScore = Math.max(entry.bestFactScore, -row.rank);
      byTopic.set(row.topic, entry);
    }

    return [...byTopic.values()]
      .map((entry) => ({
        ...entry,
        score: entry.bestFactScore * (entry.sameProject ? SAME_PROJECT_BOOST : 1),
      }))
      .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic))
      .slice(0, candidateLimit)
      .map((candidate) => ({ ...candidate, ...describeTopic(candidate.topic) }));
  }

  function describeTopic(id) {
    const row = db.prepare("select summary, keywords from topics where id = ?").get(id);
    return { summary: row?.summary ?? null, keywords: row?.keywords ?? null };
  }

  function topicsOfProject(project) {
    if (!project) return new Set();
    const projects = recordedProjectsUnder(db, project);
    const marks = projects.map(() => "?").join(", ");

    const rows = db
      .prepare(
        `select distinct f.topic as topic from facts f join sessions s
           on f.session is not null and ${SESSION_STARTS_WITH_THE_FACTS_PREFIX}
          where s.project in (${marks})
         union
         select distinct topic from sessions
          where topic is not null and project in (${marks})`
      )
      .all(...projects, ...projects);

    return new Set(rows.map((row) => row.topic));
  }

  function appendToCorpus(merged, sessionId, candidates, happenedOn) {
    const topicId = resolveTopicId(merged.topic.id, candidates);

    topics.upsertTopic(topicId, {
      keywords: merged.topic.keywords,
      summary: merged.topic.summary,
    });
    for (const fact of merged.context) {
      topics.appendToTopic(topicId, "Context", fact, sessionId, happenedOn);
    }
    for (const decision of merged.decisions) {
      topics.appendToTopic(topicId, "Decisions", decision, sessionId, happenedOn);
    }

    return topicId;
  }

  function whenTheConversationHappened(slice, session) {
    const at = firstParsable([slice.lastTurnAt, session.started]) ?? Date.now();
    return localDateParts(at, timeZone).date;
  }

  function resolveTopicId(returned, candidates) {
    const normalized = normalizedTopicId(returned);
    const sameSubject = (id) => normalizedTopicId(id) === normalized;

    const candidate = candidates.find((entry) => sameSubject(entry.topic));
    if (candidate) return candidate.topic;

    const existing = db
      .prepare("select id from topics")
      .all()
      .map((row) => row.id)
      .find(sameSubject);
    return existing ?? normalized;
  }

  return { extractSession, index, refresh: () => index.refresh(), close: () => index.close() };
}

function firstParsable(candidates) {
  for (const candidate of candidates) {
    const at = Date.parse(candidate ?? "");
    if (Number.isFinite(at)) return at;
  }
  return null;
}

function normalizedTopicId(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function everythingWritten(written) {
  return {
    topic: written[0].topic,
    topics: written.map((merged) => merged.topic.id),
    context: written.flatMap((merged) => merged.context),
    decisions: written.flatMap((merged) => merged.decisions),
  };
}

function outcome(status, extra = {}) {
  return { status, ...extra };
}

function mergedByTopic(results) {
  const byTopic = new Map();

  for (const result of results.filter((entry) => entry && !entry.skip)) {
    const merged = byTopic.get(result.topic.id) ?? {
      topic: { id: result.topic.id, keywords: [], summary: "" },
      context: [],
      decisions: [],
    };
    merged.topic.keywords = [...new Set([...merged.topic.keywords, ...result.topic.keywords])];
    merged.topic.summary = merged.topic.summary || result.topic.summary;
    merged.context = distinct([...merged.context, ...result.context]);
    merged.decisions = distinct([...merged.decisions, ...result.decisions]);
    byTopic.set(result.topic.id, merged);
  }

  return [...byTopic.values()].sort(
    (a, b) => b.context.length + b.decisions.length - (a.context.length + a.decisions.length)
  );
}

function distinct(values) {
  return [...new Set(values.map((value) => value.trim()))];
}

