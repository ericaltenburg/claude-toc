import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { parsePromptRecord, parseSessionRecord, parseTopic } from "./parse.js";
import { createStateStore } from "./state.js";
import { createTopicStore } from "./toc.js";

// Bump this whenever the schema below changes. A mismatch throws the whole index
// away and rebuilds it, which is always safe: every row here is derived from
// markdown, and markdown is the source of truth.
export const SCHEMA_VERSION = 1;

const SCHEMA = `
create table meta (key text primary key, value text not null);

create table topics (
  id text primary key,
  summary text,
  keywords text,
  mtime_ms integer,
  size integer
);

create table facts (
  id integer primary key,
  topic text not null references topics(id),
  section text not null,
  text text not null,
  session text,
  date text,
  line integer
);

create table prompts (
  id integer primary key,
  ts integer not null,
  local_date text not null,
  local_time text not null,
  session text,
  project text,
  text text not null,
  is_command integer not null
);

create table sessions (
  session_id text primary key,
  transcript_path text,
  project text,
  started_at text,
  extracted_at text,
  topic text,
  -- How far into a transcript extraction has read. Written by the sweep, which
  -- does not exist yet; the column is here because the schema is versioned and
  -- adding it later would cost a rebuild of everything.
  extraction_offset integer
);

create virtual table facts_fts using fts5(
  text, content='facts', content_rowid='id', tokenize='porter unicode61'
);
create virtual table prompts_fts using fts5(
  text, content='prompts', content_rowid='id', tokenize='porter unicode61'
);

create trigger facts_ai after insert on facts begin
  insert into facts_fts(rowid, text) values (new.id, new.text);
end;
create trigger facts_ad after delete on facts begin
  insert into facts_fts(facts_fts, rowid, text) values ('delete', old.id, old.text);
end;
create trigger prompts_ai after insert on prompts begin
  insert into prompts_fts(rowid, text) values (new.id, new.text);
end;
create trigger prompts_ad after delete on prompts begin
  insert into prompts_fts(prompts_fts, rowid, text) values ('delete', old.id, old.text);
end;

create index facts_date on facts(date);
create index facts_topic on facts(topic);
create index facts_session on facts(session);
create index prompts_local_date on prompts(local_date);
create index prompts_session on prompts(session);
create index prompts_project on prompts(project);
`;

const PROMPT_OFFSET = "prompt_log_offset";
const SESSION_OFFSET = "session_log_offset";

export function openIndex(config, { timeZone } = {}) {
  mkdirSync(config.corpusDir, { recursive: true });

  let db;
  let rebuilt;
  try {
    db = connect(config);
    rebuilt = ensureSchema(db);
  } catch {
    // An unreadable or corrupt index is not a problem worth diagnosing: throw
    // the file away and build a new one from the markdown.
    db?.close();
    rmSync(config.indexPath, { force: true });
    db = connect(config);
    rebuilt = ensureSchema(db);
  }

  let rebuiltPending = rebuilt;

  function refresh() {
    db.exec("begin");
    try {
      const stats = {
        rebuilt: rebuiltPending,
        ...refreshTopics(db, config),
        ...refreshPrompts(db, config, timeZone),
        ...refreshSessions(db, config),
      };
      db.exec("commit");
      rebuiltPending = false;
      return stats;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  return { db, refresh, close: () => db.close() };
}

function connect(config) {
  const db = new DatabaseSync(config.indexPath);
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  return db;
}

function ensureSchema(db) {
  if (storedVersion(db) === SCHEMA_VERSION) return false;

  dropEverything(db);
  db.exec(SCHEMA);
  db.prepare("insert into meta(key, value) values ('schema_version', ?)").run(
    String(SCHEMA_VERSION)
  );
  return true;
}

function storedVersion(db) {
  try {
    const row = db.prepare("select value from meta where key = 'schema_version'").get();
    return row ? Number(row.value) : null;
  } catch {
    return null;
  }
}

function dropEverything(db) {
  // Dropping a parent table before its children would otherwise have to fight
  // foreign key enforcement. Nothing here is worth preserving, so switch it off.
  db.exec("pragma foreign_keys = off");
  const objects = db
    .prepare("select type, name from sqlite_master where name not like 'sqlite_%'")
    .all();

  for (const kind of ["trigger", "view", "table"]) {
    for (const object of objects.filter((o) => o.type === kind)) {
      db.exec(`drop ${kind} if exists "${object.name}"`);
    }
  }
  db.exec("pragma foreign_keys = on");
}

// --- Topics and facts ---

function refreshTopics(db, config) {
  const files = existsSync(config.topicsDir)
    ? readdirSync(config.topicsDir).filter(
        (file) => file.endsWith(".md") && !file.endsWith(".merged.md")
      )
    : [];

  const known = new Map(
    db.prepare("select id, mtime_ms, size from topics").all().map((row) => [row.id, row])
  );

  const toc = loadToc(config);
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

  for (const file of files) {
    const id = basename(file, ".md");
    seen.add(id);

    const path = join(config.topicsDir, file);
    const stat = statSync(path);
    const previous = known.get(id);
    const unchanged =
      previous && previous.mtime_ms === Math.floor(stat.mtimeMs) && previous.size === stat.size;

    // The summary and keywords live in the table of contents rather than in the
    // topic file, so they are refreshed even when the file itself is untouched.
    const entry = toc[id] ?? {};
    upsertTopic.run(
      id,
      entry.summary ?? null,
      keywordText(entry),
      Math.floor(stat.mtimeMs),
      stat.size
    );
    if (unchanged) continue;

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

function keywordText(entry) {
  return Array.isArray(entry.keywords) ? entry.keywords.join(" ") : null;
}

// The table of contents is the topic store's file, so it is read through the
// topic store. A corrupt one costs summaries and keywords, not the refresh.
function loadToc(config) {
  try {
    return createTopicStore(config).loadToc().topics ?? {};
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

// Which sessions have been extracted, and into which topic, lives in the state
// file rather than the session log, so it is overlaid on every refresh. The file
// holds one small record per session, so re-reading it whole costs nothing.
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

// Reads the bytes of an append-only log that arrived since the last refresh,
// stopping at the last complete line so a half-written record is left for next
// time. A log shorter than the recorded offset has been truncated or rotated, so
// the caller's reset runs and reading starts again from the beginning.
function readAppendedLines(db, { path, offsetKey, onReset, onLine }) {
  if (!existsSync(path)) return;

  let offset = storedOffset(db, offsetKey);
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (size < offset) {
      onReset();
      offset = 0;
      // Recorded straight away: an emptied log leaves nothing to read below, and
      // a stale offset would make the next refresh skip its first records.
      storeOffset(db, offsetKey, 0);
    }
    if (size === offset) return;

    const buffer = Buffer.allocUnsafe(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    if (read <= 0) return;

    const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
    if (lastNewline === -1) return;

    const text = buffer.toString("utf-8", 0, lastNewline);
    for (const line of text.split("\n")) {
      if (line.trim()) onLine(line);
    }
    storeOffset(db, offsetKey, offset + lastNewline + 1);
  } finally {
    closeSync(fd);
  }
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
