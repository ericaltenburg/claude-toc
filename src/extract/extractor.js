import { existsSync } from "node:fs";

import { SECTIONS } from "../corpus/format.js";
import { createTopicStore } from "../corpus/topics.js";
import { localDateParts } from "../local-time.js";
import { openIndex } from "../index/open.js";
import { salientTermsQuery } from "../index/terms.js";
import { createStateStore } from "../sessions/progress.js";
import { chunkTurns, unreadSlice } from "../sessions/transcript.js";
import { createModelCall } from "./bedrock.js";
import { buildExtractPrompt, MalformedOutput, parseModelOutput } from "./prompt.js";
import { createSpendLog } from "./spend.js";

export const CANDIDATE_TOPICS_IN_A_PROMPT = 10;
export const KNOWN_FACTS_IN_A_PROMPT = 20;

// A session is extracted a slice at a time, so what the model is likeliest to write again,
// reworded, is what its earlier slices already produced: 93% of close duplicate pairs came from
// one session. Those facts lead the known facts whatever topic they were filed under. The cap is
// for the session that runs for days, and past it the newest are kept, since they sit closest to
// the unread slice.
export const SAME_SESSION_FACTS_IN_A_PROMPT = 100;

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

    const context = promptContextFromAFreshIndex(slice.text, project, sessionId);
    const { candidates } = context;
    const chunks = chunkTurns(turns, maxChunkChars);

    const results = [];
    try {
      for (const chunk of chunks) {
        const knownFacts = knownFactsFor(context, results);
        const prompt = buildExtractPrompt({ candidates, knownFacts });
        results.push(withSupersededFactsNamed(extractChunk(prompt, chunk, sessionId), knownFacts));
      }
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
    const appended = extracted.map((merged) => ({
      merged,
      ...appendToCorpus(merged, sessionId, candidates, happenedOn),
    }));
    const written = appended.map(({ merged, topicId }) => ({
      ...merged,
      topic: { ...merged.topic, id: topicId },
    }));

    // Only once every fact is written, since a fact can supersede one filed under a topic whose
    // facts are appended after its own.
    let superseded = 0;
    for (const fact of appended.flatMap((entry) => entry.supersedes)) {
      if (topics.markSuperseded(fact.topic, fact, sessionId, happenedOn)) superseded++;
    }

    state.recordExtraction(sessionId, {
      offset: slice.offset,
      result: everythingWritten(written),
    });

    return outcome("extracted", {
      sessionId,
      topic: written[0].topic.id,
      topics: written.map((merged) => merged.topic.id),
      candidates,
      knownFacts: context.ownFacts.length + context.rankedFacts.length,
      chunks: chunks.length,
      ...countsBySection(written),
      superseded,
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

  function promptContextFromAFreshIndex(text, project, sessionId) {
    index.refresh();

    const own = index.factsFromSession(sessionId, SAME_SESSION_FACTS_IN_A_PROMPT);
    const ownFacts = own.map(asKnownFact);
    const match = salientTermsQuery(text);
    if (!match) return { candidates: [], ownFacts, rankedFacts: [] };

    const ranked = index.factsRankedAgainst(match, FACTS_SCANNED_FOR_CANDIDATES);
    const candidates = rankedCandidates(ranked, project);
    const chosen = new Set(candidates.map((candidate) => candidate.topic));
    const listed = new Set(own.map((row) => row.id));
    // A superseded fact still says what its topic is about, so it counts toward choosing the
    // candidates, but it is not offered as known: a value that changed back is news again.
    const rankedFacts = ranked
      .filter((row) => chosen.has(row.topic) && !listed.has(row.id) && !row.superseded_date)
      .slice(0, factLimit)
      .map(asKnownFact);

    return { candidates, ownFacts, rankedFacts };
  }

  // What the earlier chunks of this run returned is the session's newest, not yet written, so
  // it leads the session's own facts and shares their cap, newest kept. Each is listed under the
  // topic its chunk will be written to, which is also where a supersession will look for it.
  function knownFactsFor({ candidates, ownFacts, rankedFacts }, earlierChunks) {
    const fromThisRun = earlierChunks
      .filter((result) => !result.skip)
      .flatMap((result) => {
        const topic = resolveTopicId(result.topic.id, candidates);
        return SECTIONS.flatMap((section) =>
          result[keyOf(section)].map(({ text }) => ({ topic, section, text }))
        );
      })
      .reverse();

    return [
      ...[...fromThisRun, ...ownFacts].slice(0, SAME_SESSION_FACTS_IN_A_PROMPT),
      ...rankedFacts,
    ];
  }

  function rankedCandidates(ranked, project) {
    const nearby = index.topicsOfProject(project);
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
      .map((candidate) => ({ ...candidate, ...index.describeTopic(candidate.topic) }));
  }

  function appendToCorpus(merged, sessionId, candidates, happenedOn) {
    const topicId = resolveTopicId(merged.topic.id, candidates);

    topics.upsertTopic(topicId, {
      keywords: merged.topic.keywords,
      summary: merged.topic.summary,
    });
    // A fact marks the ones it supersedes only if it landed. One the section already held is a
    // restatement, and marking what it restates would leave no current line saying it.
    const supersedes = [];
    for (const section of SECTIONS) {
      for (const fact of merged[keyOf(section)]) {
        if (topics.appendToTopic(topicId, section, fact.text, sessionId, happenedOn)) {
          supersedes.push(...fact.supersedes);
        }
      }
    }

    return { topicId, supersedes };
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

    const existing = index.topicIds().find(sameSubject);
    return existing ?? normalized;
  }

  return { extractSession, refresh: () => index.refresh(), close: () => index.close() };
}

function firstParsable(candidates) {
  for (const candidate of candidates) {
    const at = Date.parse(candidate ?? "");
    if (Number.isFinite(at)) return at;
  }
  return null;
}

function asKnownFact(row) {
  return { topic: row.topic, section: row.section, text: row.text };
}

function normalizedTopicId(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// The model's reply names each section's facts by the section's name in lower case.
const keyOf = (section) => section.toLowerCase();
const KEYS = SECTIONS.map(keyOf);
const perKey = (valueFor) => Object.fromEntries(KEYS.map((key) => [key, valueFor(key)]));
const factCount = (merged) => KEYS.reduce((total, key) => total + merged[key].length, 0);

function everythingWritten(written) {
  return {
    topic: written[0].topic,
    topics: written.map((merged) => merged.topic.id),
    ...perKey((key) => written.flatMap((merged) => merged[key])),
  };
}

function countsBySection(written) {
  return perKey((key) => written.reduce((total, merged) => total + merged[key].length, 0));
}

function outcome(status, extra = {}) {
  return { status, ...extra };
}

// A reply names what a fact supersedes by its number in the known facts its prompt listed, so the
// numbers become those facts before the chunk's results meet any other chunk's. A number that
// names no listed fact is dropped, and the fact is still appended.
function withSupersededFactsNamed(result, knownFacts) {
  if (result.skip) return result;
  return {
    ...result,
    ...perKey((key) =>
      result[key].map(({ text, supersedes }) => ({
        text,
        supersedes: supersedes.flatMap((number) => knownFacts[number] ?? []),
      }))
    ),
  };
}

function mergedByTopic(results) {
  const byTopic = new Map();

  for (const result of results.filter((entry) => entry && !entry.skip)) {
    const merged = byTopic.get(result.topic.id) ?? {
      topic: { id: result.topic.id, keywords: [], summary: "" },
      ...perKey(() => []),
    };
    merged.topic.keywords = [...new Set([...merged.topic.keywords, ...result.topic.keywords])];
    merged.topic.summary = merged.topic.summary || result.topic.summary;
    for (const key of KEYS) merged[key] = distinct([...merged[key], ...result[key]]);
    byTopic.set(result.topic.id, merged);
  }

  return [...byTopic.values()].sort((a, b) => factCount(b) - factCount(a));
}

// One entry per text, carrying everything any copy of it superseded.
function distinct(facts) {
  const byText = new Map();
  for (const { text, supersedes } of facts) {
    const said = text.trim();
    byText.set(said, { text: said, supersedes: [...(byText.get(said)?.supersedes ?? []), ...supersedes] });
  }
  return [...byText.values()];
}

