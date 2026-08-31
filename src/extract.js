#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

import { createConfig } from "./config.js";
import { openIndex } from "./search-index.js";
import { recordedProjectsUnder, salientTermsQuery } from "./search.js";
import { createStateStore } from "./state.js";
import { createTopicStore } from "./toc.js";

// See docs/adr/0002: the prompt is bounded by these two caps, not by the corpus.
export const CANDIDATE_TOPICS = 10;
export const KNOWN_FACTS = 20;

// The facts scanned to build the candidate list. Bounded, and generous enough that a
// same-project topic outside the top ten can still be promoted into it by the boost.
const RANKED_FACTS_SCANNED = 200;
const SAME_PROJECT_BOOST = 2;

// ~75K tokens of conversation per call, comfortably inside the extraction model's window.
const CHUNK_CHARS = 300_000;

// Sonnet 5 for every extraction, with the larger model as the fallback for a chunk it
// cannot take. Tried in order.
const MODELS = ["global.anthropic.claude-sonnet-5", "global.anthropic.claude-opus-5"];
const MODEL_TIMEOUT_MS = 120_000;
const MODEL_OUTPUT_LIMIT = 2 * 1024 * 1024;

const SHORTEST_MEANINGFUL_TURN = 5;
const TURNS_WORTH_EXTRACTING = 2;

// --- The transcript slice ---

const NEWLINE = 0x0a;
const START_OF_TRANSCRIPT = 0;

// The unread slice: bytes past the offset extraction already paid for. A transcript that
// shrank was rotated under us, so the only honest offset is the start of the file.
export function unreadSlice(transcriptPath, offset) {
  const fd = openSync(transcriptPath, "r");
  try {
    const { size } = fstatSync(fd);
    const from = offset > size ? START_OF_TRANSCRIPT : offset;
    const nothingUnread = { turns: [], text: "", offset: from };
    if (from >= size) return nothingUnread;

    const buffer = Buffer.allocUnsafe(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    if (read <= 0) return nothingUnread;

    const endOfLastCompleteLine = buffer.lastIndexOf(NEWLINE, read - 1);
    if (endOfLastCompleteLine === -1) return nothingUnread;

    const turns = turnsFrom(buffer.toString("utf-8", 0, endOfLastCompleteLine));
    return { turns, text: turnsToText(turns), offset: from + endOfLastCompleteLine + 1 };
  } finally {
    closeSync(fd);
  }
}

function turnsFrom(jsonLines) {
  const turns = [];

  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

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

  return turns;
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

// A slice can exceed the context window, so it goes to the model in pieces. Turn
// boundaries first; a single turn bigger than the budget is split where it must be.
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
      for (let at = 0; at < piece.length; at += maxChars) {
        chunks.push(piece.slice(at, at + maxChars));
      }
      continue;
    }

    current.push(piece);
    size += piece.length + "\n\n".length;
  }
  flush();

  return chunks;
}

// --- The prompt ---

const SCHEMA_INSTRUCTIONS = `You are a memory extraction system. Analyze this conversation and extract structured information.

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

// The one injectable model call: tests substitute this and nothing else about extraction.
function callClaude({ prompt, model }) {
  return execFileSync("claude", ["-p"], {
    input: prompt,
    encoding: "utf-8",
    maxBuffer: MODEL_OUTPUT_LIMIT,
    timeout: MODEL_TIMEOUT_MS,
    env: {
      ...process.env,
      AWS_PROFILE: "claudecode",
      CLAUDE_CODE_USE_BEDROCK: "1",
      DISABLE_PROMPT_CACHING: "1",
      ANTHROPIC_MODEL: model,
    },
  });
}

const FENCE = /^```[\w-]*\n?|\n?```$/g;
const OUTERMOST_OBJECT = /\{[\s\S]*\}/;

export class MalformedOutput extends Error {}

// One retry, on the output rather than the model: a fenced block is the one malformation
// that is certainly recoverable, and re-asking would cost another call to find that out.
export function parseModelOutput(output) {
  const raw = String(output ?? "");

  const strict = extractionFrom(raw.trim());
  if (strict) return strict;

  const unfenced = raw.trim().replace(FENCE, "");
  const retried =
    extractionFrom(unfenced) ?? extractionFrom(OUTERMOST_OBJECT.exec(unfenced)?.[0] ?? "");
  if (retried) return retried;

  throw new MalformedOutput("model returned malformed output");
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
    callModel = callClaude,
    maxChunkChars = CHUNK_CHARS,
    candidateLimit = CANDIDATE_TOPICS,
    factLimit = KNOWN_FACTS,
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

    // A topic created minutes ago is invisible to a stale index, and an invisible topic
    // gets recreated under a second name. So the index is refreshed before it is queried.
    index.refresh();

    const { candidates, knownFacts } = boundedContextFor(slice.text, project);
    const prompt = buildExtractPrompt({ candidates, knownFacts });
    const chunks = chunkTurns(turns, maxChunkChars);

    let results;
    try {
      results = chunks.map((chunk) => extractChunk(prompt, chunk));
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

    // Everything above is reversible; from here the corpus changes. Writing only after
    // every model call has returned is what keeps a crash from halving a fact (ADR 0001).
    const written = extracted.map((merged) => ({
      ...merged,
      topic: { ...merged.topic, id: writeFacts(merged, sessionId, candidates) },
    }));

    state.recordExtraction(sessionId, { offset: slice.offset, result: written[0] });

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

  // A chunk the extraction model cannot take is escalated rather than dropped: the corpus
  // is written once and cannot be re-extracted, so a lost chunk is lost knowledge. Output
  // that came back malformed is not escalated — the retry for that already happened on the
  // output, and a second model is no more likely to answer in JSON.
  function extractChunk(prompt, chunk) {
    let lastError;
    for (const model of MODELS) {
      try {
        return parseModelOutput(callModel({ prompt: prompt + chunk, model, chunk }));
      } catch (error) {
        log(`  ${model} failed: ${error.message}`);
        if (error instanceof MalformedOutput) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  // Everything the prompt knows about the corpus comes from this one bounded query: the
  // candidate topics to choose between, and the facts those topics already hold.
  function boundedContextFor(text, project) {
    const match = salientTermsQuery(text);
    if (!match) return { candidates: [], knownFacts: [] };

    // bm25 is usable only in a flat query over the full-text table, so the ranked facts
    // come back one row at a time and are grouped into topics here.
    const ranked = db
      .prepare(
        `select f.topic as topic, f.section as section, f.text as text, bm25(facts_fts) as rank
         from facts_fts join facts f on f.id = facts_fts.rowid
         where facts_fts match ?
         order by bm25(facts_fts), f.date desc limit ?`
      )
      .all(match, RANKED_FACTS_SCANNED);

    const candidates = rankedCandidates(ranked, project);
    const chosen = new Set(candidates.map((candidate) => candidate.topic));
    const knownFacts = ranked
      .filter((row) => chosen.has(row.topic))
      .slice(0, factLimit)
      .map((row) => ({ topic: row.topic, section: row.section, text: row.text }));

    return { candidates, knownFacts };
  }

  // A topic's score is its best-matching fact, not the sum of them: topic size is lumpy, so
  // summing would make the largest topics permanent candidates (docs/adr/0002).
  function rankedCandidates(ranked, project) {
    const nearby = topicsOfProject(project);
    const byTopic = new Map();

    for (const row of ranked) {
      const entry = byTopic.get(row.topic) ?? {
        topic: row.topic,
        facts: 0,
        score: 0,
        sameProject: nearby.has(row.topic),
      };
      entry.facts++;
      entry.score = Math.max(entry.score, -row.rank);
      byTopic.set(row.topic, entry);
    }

    return [...byTopic.values()]
      .map((entry) => ({
        ...entry,
        score: entry.score * (entry.sameProject ? SAME_PROJECT_BOOST : 1),
      }))
      .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic))
      .slice(0, candidateLimit)
      .map((candidate) => ({ ...candidate, ...describeTopic(candidate.topic) }));
  }

  function describeTopic(id) {
    const row = db.prepare("select summary, keywords from topics where id = ?").get(id);
    return { summary: row?.summary ?? null, keywords: row?.keywords ?? null };
  }

  // A topic belongs to a project when a session in that project contributed a fact to it.
  // A fact carries only the first eight characters of its session id, and that field comes
  // from hand-editable markdown, so the session is matched by prefix rather than by LIKE,
  // where an underscore in the stored text would be a wildcard.
  function topicsOfProject(project) {
    if (!project) return new Set();
    const projects = recordedProjectsUnder(db, project);
    const marks = projects.map(() => "?").join(", ");

    const rows = db
      .prepare(
        `select distinct f.topic as topic from facts f join sessions s
           on f.session is not null and substr(s.session_id, 1, length(f.session)) = f.session
          where s.project in (${marks})
         union
         select distinct topic from sessions
          where topic is not null and project in (${marks})`
      )
      .all(...projects, ...projects);

    return new Set(rows.map((row) => row.topic));
  }

  function writeFacts(merged, sessionId, candidates) {
    const topicId = resolveTopicId(merged.topic.id, candidates);

    topics.upsertTopic(topicId, {
      keywords: merged.topic.keywords,
      summary: merged.topic.summary,
    });
    for (const fact of merged.context) {
      topics.appendToTopic(topicId, "Context", fact, sessionId);
    }
    for (const decision of merged.decisions) {
      topics.appendToTopic(topicId, "Decisions", decision, sessionId);
    }

    return topicId;
  }

  // The candidate list is how a session joins an existing topic, so a returned id that
  // differs from a candidate only in shape must not open a second file for one subject.
  function resolveTopicId(returned, candidates) {
    const normalized = normalizedTopicId(returned);
    const candidate = candidates.find(
      (entry) => normalizedTopicId(entry.topic) === normalized
    );
    if (candidate) return candidate.topic;

    const existing = db
      .prepare("select id from topics where lower(id) = ?")
      .get(normalized);
    return existing?.id ?? normalized;
  }

  return { extractSession, index, refresh: () => index.refresh(), close: () => index.close() };
}

function normalizedTopicId(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function outcome(status, extra = {}) {
  return { status, ...extra };
}

// Chunks usually describe one subject, but a long session can genuinely turn to another,
// so facts go to the topic their own chunk named rather than to a majority vote. Ordered by
// how much of the session each topic accounts for, and identical text counts once.
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

function loadSessions(config) {
  if (!existsSync(config.sessionIndexPath)) return null;
  return readFileSync(config.sessionIndexPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

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

// A session is worth extracting while any of its transcript is unread, which is not the same
// as never having been extracted: a session extracted an hour ago has since said more.
function withUnreadTranscript(sessions, state) {
  return sessions.filter((session) => {
    if (state.isQuarantined(session.session_id)) return false;
    if (!session.transcript || !existsSync(session.transcript)) return false;
    return statSync(session.transcript).size > state.extractionOffset(session.session_id);
  });
}

function listSessions(sessions, state) {
  const unread = withUnreadTranscript(sessions, state);
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

function main(argv) {
  const config = createConfig();
  const arg = argv[0];

  if (arg === "--dedup") {
    reportDedup(config);
    return 0;
  }

  const sessions = loadSessions(config);
  if (!sessions) {
    console.log("No sessions indexed yet.");
    return 0;
  }

  const state = createStateStore(config);
  if (!arg) {
    listSessions(sessions, state);
    return 0;
  }

  const chosen =
    arg === "--all"
      ? withUnreadTranscript(sessions, state)
      : sessions.filter((session) => String(session.session_id).startsWith(arg));

  if (!chosen.length) {
    console.log(arg === "--all" ? "Nothing unread to extract." : `No session matching "${arg}"`);
    return arg === "--all" ? 0 : 1;
  }

  const extractor = createExtractor(config, { log: (line) => console.log(line) });
  try {
    for (const session of chosen) {
      reportExtraction(session, extractor.extractSession(session));
    }
  } finally {
    extractor.close();
  }
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
