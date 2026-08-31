#!/usr/bin/env node
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createModelCall } from "./bedrock.js";
import { createConfig } from "./config.js";
import { localDateParts } from "./parse.js";
import { openIndex, SESSION_STARTS_WITH_THE_FACTS_PREFIX } from "./search-index.js";
import { recordedProjectsUnder, salientTermsQuery } from "./search.js";
import { indexedSessions } from "./session-index.js";
import { createStateStore, START_OF_TRANSCRIPT, transcriptHasUnreadTurns } from "./state.js";
import { createSpendLog } from "./spend.js";
import { createSweeper, EXTRACTION_PROMPT_MARKER } from "./sweep.js";
import { createTopicStore } from "./toc.js";

export const CANDIDATE_TOPICS_IN_A_PROMPT = 10;
export const KNOWN_FACTS_IN_A_PROMPT = 20;

const FACTS_SCANNED_FOR_CANDIDATES = 200;
const SAME_PROJECT_BOOST = 2;
const CHARS_PER_MODEL_CALL = 300_000;
const CHARS_PER_RETRIED_MODEL_CALL = 60_000;

const EXTRACTION_MODEL_THEN_FALLBACK = [
  "global.anthropic.claude-sonnet-5",
  "global.anthropic.claude-opus-5",
];
const SHORTEST_MEANINGFUL_TURN = 5;
const TURNS_WORTH_EXTRACTING = 2;

// --- The transcript slice ---

const NEWLINE = 0x0a;
const NOTHING_UNREAD = { turns: [], text: "", lastTurnAt: null };

export function unreadSlice(transcriptPath, offset) {
  const fd = openSync(transcriptPath, "r");
  try {
    const { size } = fstatSync(fd);
    const from = transcriptWasRotated(size, offset) ? START_OF_TRANSCRIPT : offset;
    const nothingUnread = { ...NOTHING_UNREAD, offset: from };
    if (from >= size) return nothingUnread;

    const buffer = Buffer.allocUnsafe(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    if (read <= 0) return nothingUnread;

    const endOfLastCompleteLine = buffer.lastIndexOf(NEWLINE, read - 1);
    if (endOfLastCompleteLine === -1) return nothingUnread;

    const { turns, lastTurnAt } = turnsFrom(buffer.toString("utf-8", 0, endOfLastCompleteLine));
    return {
      turns,
      lastTurnAt,
      text: turnsToText(turns),
      offset: from + endOfLastCompleteLine + 1,
    };
  } finally {
    closeSync(fd);
  }
}

function transcriptWasRotated(size, offset) {
  return offset > size;
}

function turnsFrom(jsonLines) {
  const turns = [];
  let lastTurnAt = null;

  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof entry?.timestamp === "string") lastTurnAt = entry.timestamp;

    const role = entry?.role || entry?.type;
    const content = entry?.message?.content;

    if (role === "human" || role === "user") {
      if (typeof content === "string" && content.trim()) {
        turns.push({ role: "user", text: content.trim() });
        continue;
      }
      pushTextBlocks(turns, "user", content);
    } else if (role === "assistant") {
      pushTextBlocks(turns, "assistant", content);
    }
  }

  return { turns, lastTurnAt };
}

function pushTextBlocks(turns, role, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "text" && block.text?.trim()) {
      turns.push({ role, text: block.text.trim() });
    }
  }
}

function renderTurn(turn) {
  return `${turn.role === "user" ? "USER" : "ASSISTANT"}: ${turn.text}`;
}

function turnsToText(turns) {
  return turns.map(renderTurn).join("\n\n");
}

export function chunkTurns(turns, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join("\n\n"));
    current = [];
    size = 0;
  };

  for (const turn of turns) {
    const piece = renderTurn(turn);
    if (size && size + piece.length > maxChars) flush();

    if (piece.length > maxChars) {
      flush();
      chunks.push(...splitOversizedTurn(piece, maxChars));
      continue;
    }

    current.push(piece);
    size += piece.length + "\n\n".length;
  }
  flush();

  return chunks;
}

function splitOversizedTurn(piece, maxChars) {
  const pieces = [];
  for (let at = 0; at < piece.length; at += maxChars) {
    pieces.push(piece.slice(at, at + maxChars));
  }
  return pieces;
}

// --- The prompt ---

const SCHEMA_INSTRUCTIONS = `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation and extract structured information.

Return ONLY valid JSON with this exact schema:
{
  "topic": {
    "id": "snake_case_topic_name",
    "keywords": ["keyword1", "keyword2"],
    "summary": "one sentence summary"
  },
  "context": ["durable fact 1", "durable fact 2"],
  "decisions": ["decision 1", "decision 2"]
}

Rules:
- topic.id: short reusable identifier (e.g. "broadcast_variants", "resume_project")
- keywords: words that would appear in future messages about this topic
- context: durable truths learned (e.g. "ALCS uses DynamoDB for broadcast variants")
- decisions: choices made (e.g. "will use topic-scoped memory instead of flat summarization")
- if the conversation has no meaningful content, return {"skip": true}
- deduplicate — don't extract things that are essentially the same fact reworded
`;

export function buildExtractPrompt({ candidates = [], knownFacts = [] } = {}) {
  let prompt = SCHEMA_INSTRUCTIONS;

  if (candidates.length) {
    prompt += `\nCandidate topics (the closest matches in memory, not the whole corpus):\n`;
    for (const candidate of candidates) {
      prompt += `- ${candidate.topic}: ${candidate.summary || "no summary"}`;
      prompt += candidate.keywords ? ` (keywords: ${candidate.keywords})` : "";
      prompt += `\n`;
    }
    prompt +=
      `\nIf this conversation belongs to one of those topics, use that topic's id exactly.\n` +
      `Only invent a new topic.id if none of them fits.\n`;
  }

  if (knownFacts.length) {
    prompt += `\nAlready known about those topics — do not repeat these:\n`;
    for (const fact of knownFacts) {
      prompt += `- (${fact.topic}/${fact.section}) ${fact.text}\n`;
    }
  }

  return `${prompt}\nCONVERSATION:\n`;
}

// --- The model call ---

export function bedrockBilledToOurOwnProfile(config, options = {}) {
  const spend = createSpendLog(config);
  return createModelCall(config, { onUsage: (usage) => spend.record(usage), ...options });
}

const FENCE = /^```[\w-]*\n?|\n?```$/g;
const OUTERMOST_OBJECT = /\{[\s\S]*\}/;

export class MalformedOutput extends Error {}

export function parseModelOutput(output) {
  const raw = String(output ?? "").trim();

  const asWritten = extractionFrom(raw);
  if (asWritten) return asWritten;

  const unfenced = raw.replace(FENCE, "");
  const afterStrippingFences =
    extractionFrom(unfenced) ?? extractionFrom(OUTERMOST_OBJECT.exec(unfenced)?.[0] ?? "");
  if (afterStrippingFences) return afterStrippingFences;

  throw new MalformedOutput(`model returned malformed output: ${asEvidence(raw)}`);
}

const ENOUGH_OUTPUT_TO_DIAGNOSE_A_FAILURE = 400;

function asEvidence(output) {
  const collapsed = output.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(it returned nothing)";
  return collapsed.length > ENOUGH_OUTPUT_TO_DIAGNOSE_A_FAILURE
    ? `${collapsed.slice(0, ENOUGH_OUTPUT_TO_DIAGNOSE_A_FAILURE)}…`
    : collapsed;
}

function extractionFrom(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.skip) return { skip: true };
  if (typeof parsed.topic?.id !== "string" || !parsed.topic.id.trim()) return null;

  return {
    topic: {
      id: parsed.topic.id,
      keywords: Array.isArray(parsed.topic.keywords) ? parsed.topic.keywords : [],
      summary: typeof parsed.topic.summary === "string" ? parsed.topic.summary : "",
    },
    context: stringsOnly(parsed.context),
    decisions: stringsOnly(parsed.decisions),
  };
}

function stringsOnly(value) {
  return (Array.isArray(value) ? value : []).filter(
    (item) => typeof item === "string" && item.trim()
  );
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

// --- CLI ---

function reportExtraction(session, result) {
  const short = String(session.session_id ?? "unknown").slice(0, 8);
  console.log(`\nExtracting: ${short} (${session.started ?? "undated"})`);

  if (result.status === "extracted") {
    console.log(`  → topic: ${result.topics.join(", ")}`);
    console.log(`  → ${result.context} facts, ${result.decisions} decisions`);
    console.log(`  → ${result.candidates.length} candidate topic(s), ${result.chunks} chunk(s)`);
    return;
  }
  if (result.status === "failed") {
    console.log(`  failed (attempt ${result.attempts}): ${result.error}`);
    return;
  }
  if (result.status === "quarantined") {
    console.log(`  quarantined: ${result.error ?? "already quarantined"}`);
    return;
  }
  console.log(`  ${result.status}`);
}

function sessionsWithUnreadTranscript(sessions, state) {
  return sessions.filter((session) => hasUnreadTranscript(session, state));
}

function hasUnreadTranscript(session, state) {
  if (state.isQuarantined(session.session_id)) return false;
  if (!session.transcript || !existsSync(session.transcript)) return false;
  return transcriptHasUnreadTurns(
    statSync(session.transcript).size,
    state.extractionOffset(session.session_id)
  );
}

function listSessions(sessions, state) {
  const unread = sessionsWithUnreadTranscript(sessions, state);
  console.log(`Sessions: ${sessions.length} total, ${unread.length} unextracted`);

  for (const session of sessions) {
    const record = state.processedRecord(session.session_id);
    console.log(
      `  ${String(session.session_id).slice(0, 8)}  ${session.started}  ` +
        `${record ? `✓ ${record.topic || "skipped"}` : "pending"}`
    );
  }
  if (unread.length) console.log(`\nRun the extractor with --all to process them.`);
}

function reportDedup(config) {
  const { merges, remaining } = createTopicStore(config).dedupTopics();
  for (const { winnerId, loserId, score } of merges) {
    console.log(`Merged ${loserId} → ${winnerId} (score: ${score.toFixed(2)})`);
  }
  console.log(`Merged ${merges.length} topic pair(s). ${remaining} topics remain.`);
}

function extractEach(config, sessions, options = {}) {
  const extractor = createExtractor(config, { log: (line) => console.log(line), ...options });
  try {
    for (const session of sessions) {
      reportExtraction(session, extractor.extractSession(session));
    }
  } finally {
    extractor.close();
  }
}

function retry(config, state, sessions, prefix) {
  if (!prefix) {
    console.log("Usage: toc-extract --retry <session-id-prefix>");
    return 2;
  }

  const chosen = sessions.filter((session) => String(session.session_id).startsWith(prefix));
  if (!chosen.length) {
    console.log(`No session matching "${prefix}"`);
    return 1;
  }

  for (const session of chosen) {
    const released = state.releaseQuarantine(session.session_id);
    console.log(`${session.session_id}: ${released ? "quarantine released" : "was not quarantined"}`);
  }

  extractEach(config, chosen, { maxChunkChars: CHARS_PER_RETRIED_MODEL_CALL });
  return 0;
}

function main(argv) {
  const config = createConfig();
  const arg = argv[0];

  if (arg === "--dedup") {
    reportDedup(config);
    return 0;
  }

  const state = createStateStore(config);

  if (arg === "--sweep") {
    const swept = createSweeper(config, state).candidates();
    if (!swept.length) {
      console.log("No session is idle enough to sweep.");
      return 0;
    }
    extractEach(config, swept);
    return 0;
  }

  const sessions = indexedSessions(config);
  if (!sessions) {
    console.log("No sessions indexed yet.");
    return 0;
  }

  if (arg === "--retry") {
    return retry(config, state, sessions, argv[1]);
  }

  if (!arg) {
    listSessions(sessions, state);
    return 0;
  }

  const chosen =
    arg === "--all"
      ? sessionsWithUnreadTranscript(sessions, state)
      : sessions.filter((session) => String(session.session_id).startsWith(arg));

  if (!chosen.length) {
    console.log(arg === "--all" ? "Nothing unread to extract." : `No session matching "${arg}"`);
    return arg === "--all" ? 0 : 1;
  }

  extractEach(config, chosen);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } finally {
    const lockSession = process.env.TOC_LOCK_SESSION;
    if (lockSession) {
      createStateStore(createConfig()).releaseExtraction(lockSession);
    }
  }
}
