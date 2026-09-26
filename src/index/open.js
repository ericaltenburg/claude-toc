import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";

import { createQueries } from "./queries.js";
import { refreshEverything } from "./refresh.js";

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

export function openIndex(config, { timeZone } = {}) {
  mkdirSync(config.corpusDir, { recursive: true });

  let db;
  let rebuilt;
  try {
    db = connect(config);
    rebuilt = ensureSchema(db);
  } catch {
    db?.close();
    rmSync(config.indexPath, { force: true });
    db = connect(config);
    rebuilt = ensureSchema(db);
  }

  let rebuiltPending = rebuilt;

  function refresh() {
    // Immediate, because refresh reads before it writes. A deferred transaction would take a
    // read snapshot first and upgrade to a write later, and in WAL mode an upgrade blocked by
    // another writer fails with SQLITE_BUSY at once: the busy timeout never retries it.
    db.exec("begin immediate");
    try {
      const stats = { rebuilt: rebuiltPending, ...refreshEverything(db, config, timeZone) };
      db.exec("commit");
      rebuiltPending = false;
      return stats;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  // The connection stays in here. What callers get is refresh and the questions in
  // queries.js, so no layer above this one writes SQL of its own.
  return { refresh, close: () => db.close(), ...createQueries(db, config) };
}

// More than one process refreshes the index: the extractor after every session, and a
// toc-search or toc-status that may run in the same moment. Without a busy timeout SQLite
// fails the second writer at once with "database is locked"; with one it waits its turn.
const WAIT_FOR_ANOTHER_WRITER_MS = 5000;

function connect(config) {
  const db = new DatabaseSync(config.indexPath);
  db.exec(`pragma busy_timeout = ${WAIT_FOR_ANOTHER_WRITER_MS}`);
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
