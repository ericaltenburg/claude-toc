// Bringing the index up to date with what it derives from: the corpus's topic files and
// toc.json, Claude Code's prompt log, the session index and the extraction state. It reads
// the corpus and the sessions layer through their own modules, and it writes nothing but
// the index.
//
// Refresh is incremental. A topic file is reparsed only when its modification time or size
// changed, and the two logs are read only past the byte offset already consumed.

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";

import { parseTopic } from "../corpus/format.js";
import { createTopicStore } from "../corpus/topics.js";
import { parseJsonLine } from "../json-lines.js";
import { localDateParts } from "../local-time.js";
import { createStateStore } from "../sessions/progress.js";
import { parseSessionRecord } from "../sessions/registry.js";

const PROMPT_OFFSET = "prompt_log_offset";
const SESSION_OFFSET = "session_log_offset";

export function refreshEverything(db, config, timeZone) {
  return {
    ...refreshTopics(db, config),
    ...refreshPrompts(db, config, timeZone),
    ...refreshSessions(db, config),
  };
}

// --- Topics and facts ---

function refreshTopics(db, config) {
  const topics = createTopicStore(config);

  const known = new Map(
    db.prepare("select id, mtime_ms, size from topics").all().map((row) => [row.id, row])
  );

  const toc = tocEntries(topics);
  const upsertTopic = db.prepare(
    `insert into topics(id, summary, keywords, mtime_ms, size) values (?, ?, ?, ?, ?)
     on conflict(id) do update set
       summary = excluded.summary,
       keywords = excluded.keywords,
       mtime_ms = excluded.mtime_ms,
       size = excluded.size`
  );
  const deleteFacts = db.prepare("delete from facts where topic = ?");
  const insertFact = db.prepare(
    "insert into facts(topic, section, text, session, date, line) values (?, ?, ?, ?, ?, ?)"
  );

  const seen = new Set();
  let parsed = 0;
  let factsIndexed = 0;

  for (const { id, path } of topics.topicFiles()) {
    seen.add(id);

    const stat = statSync(path);
    const factsUnchanged = matchesIndexedFile(known.get(id), stat);

    const entryFromToc = toc[id] ?? {};
    upsertTopic.run(
      id,
      entryFromToc.summary ?? null,
      keywordText(entryFromToc),
      Math.floor(stat.mtimeMs),
      stat.size
    );
    if (factsUnchanged) continue;

    deleteFacts.run(id);
    for (const fact of parseTopic(readFileSync(path, "utf-8"))) {
      insertFact.run(id, fact.section, fact.text, fact.session, fact.date, fact.line);
      factsIndexed++;
    }
    parsed++;
  }

  for (const id of known.keys()) {
    if (seen.has(id)) continue;
    deleteFacts.run(id);
    db.prepare("delete from topics where id = ?").run(id);
  }

  return { topicsParsed: parsed, factsIndexed };
}

function matchesIndexedFile(previous, stat) {
  return Boolean(
    previous && previous.mtime_ms === Math.floor(stat.mtimeMs) && previous.size === stat.size
  );
}

function keywordText(entry) {
  return Array.isArray(entry.keywords) ? entry.keywords.join(" ") : null;
}

function tocEntries(topics) {
  try {
    return topics.loadToc().topics ?? {};
  } catch {
    return {};
  }
}

// --- Prompts ---

function refreshPrompts(db, config, timeZone) {
  const insert = db.prepare(
    `insert into prompts(ts, local_date, local_time, session, project, text, is_command)
     values (?, ?, ?, ?, ?, ?, ?)`
  );

  let count = 0;
  readAppendedLines(db, {
    path: config.promptLog,
    offsetKey: PROMPT_OFFSET,
    onReset: () => db.exec("delete from prompts"),
    onLine: (line) => {
      const record = parsePromptRecord(line, timeZone);
      if (!record) return;
      insert.run(
        record.ts,
        record.localDate,
        record.localTime,
        record.session,
        record.project,
        record.text,
        record.isCommand
      );
      count++;
    },
  });

  return { promptsIndexed: count };
}

// The prompt log is Claude Code's history.jsonl, and the index is the only thing that reads
// it, so its record shape is known here and nowhere else.
export function parsePromptRecord(line, timeZone) {
  const record = parseJsonLine(line);
  if (!record) return null;

  const text = typeof record.display === "string" ? record.display.trim() : "";
  if (!text) return null;

  const ts = typeof record.timestamp === "number" ? record.timestamp : NaN;
  if (!Number.isFinite(ts)) return null;

  const { date, time } = localDateParts(ts, timeZone);

  return {
    ts,
    localDate: date,
    localTime: time,
    session: typeof record.sessionId === "string" ? record.sessionId : null,
    project: typeof record.project === "string" ? record.project : null,
    text,
    isCommand: text.startsWith("/") ? 1 : 0,
  };
}

// --- Sessions ---

function refreshSessions(db, config) {
  const upsert = db.prepare(
    `insert into sessions(session_id, transcript_path, project, started_at)
     values (?, ?, ?, ?)
     on conflict(session_id) do update set
       transcript_path = excluded.transcript_path,
       project = excluded.project,
       started_at = excluded.started_at`
  );

  let count = 0;
  readAppendedLines(db, {
    path: config.sessionIndexPath,
    offsetKey: SESSION_OFFSET,
    onReset: () => db.exec("delete from sessions"),
    onLine: (line) => {
      const record = parseSessionRecord(line);
      if (!record) return;
      upsert.run(record.sessionId, record.transcriptPath, record.project, record.startedAt);
      count++;
    },
  });

  applyExtractionState(db, config);
  return { sessionsIndexed: count };
}

function applyExtractionState(db, config) {
  const processed = createStateStore(config).load().processed;
  const upsert = db.prepare(
    `insert into sessions(session_id, extracted_at, topic) values (?, ?, ?)
     on conflict(session_id) do update set
       extracted_at = excluded.extracted_at,
       topic = excluded.topic`
  );

  for (const [sessionId, record] of Object.entries(processed)) {
    upsert.run(sessionId, record?.ts ?? null, record?.topic ?? null);
  }
}

// --- Incremental reading ---

const NEWLINE = 0x0a;
const START_OF_LOG = 0;

function readAppendedLines(db, { path, offsetKey, onReset, onLine }) {
  if (!existsSync(path)) return;

  let offset = storedOffset(db, offsetKey);
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (logWasTruncated(size, offset)) {
      onReset();
      offset = START_OF_LOG;
      storeOffset(db, offsetKey, offset);
    }
    if (size === offset) return;

    const buffer = Buffer.allocUnsafe(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    if (read <= 0) return;

    const endOfLastCompleteLine = buffer.lastIndexOf(NEWLINE, read - 1);
    if (endOfLastCompleteLine === -1) return;

    for (const line of buffer.toString("utf-8", 0, endOfLastCompleteLine).split("\n")) {
      if (line.trim()) onLine(line);
    }
    storeOffset(db, offsetKey, offset + endOfLastCompleteLine + 1);
  } finally {
    closeSync(fd);
  }
}

function logWasTruncated(size, offset) {
  return size < offset;
}

function storedOffset(db, key) {
  const row = db.prepare("select value from meta where key = ?").get(key);
  return row ? Number(row.value) : 0;
}

function storeOffset(db, key, value) {
  db.prepare(
    "insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value"
  ).run(key, String(value));
}
