// Every question anyone asks the index. Outside the schema and refresh, this is the only SQL in
// the project: search, the extractor and the status report call these functions by what they
// want to know, and none of them holds a statement or a connection (ADR 0017).

import { realpathSync } from "node:fs";
import { sep } from "node:path";

import { createStateStore } from "../sessions/progress.js";

// A fact carries only the first eight characters of its session id, so the join from a fact to
// its session is equality on a computed prefix. Never LIKE, whose wildcards the session field
// can contain (ADR 0008).
const SESSION_STARTS_WITH_THE_FACTS_PREFIX =
  "substr(s.session_id, 1, length(f.session)) = f.session";

const FACT_COLUMNS = ["f.topic", "f.section", "f.text", "f.session", "f.date", "f.line"];
const PROMPT_COLUMNS = [
  "p.local_date",
  "p.local_time",
  "p.session",
  "p.project",
  "p.text",
  "p.is_command",
];

export function createQueries(db, config) {
  // --- Search's result classes ---

  // Each takes a MATCH expression, or null for every row the filters allow, and throws what
  // SQLite throws for an expression it cannot parse: falling back to bare terms is the read
  // path's decision, not the index's.
  function facts(match, filters) {
    return resultClass(factPlan(match, filters), FACT_COLUMNS, filters.limit);
  }

  function prompts(match, filters) {
    return resultClass(promptPlan(match, filters), PROMPT_COLUMNS, filters.limit);
  }

  function overview(match, filters) {
    const plan = factPlan(match, filters);
    const topicsMatching = countRows(
      `select count(distinct f.topic) as c from ${plan.from} ${plan.where}`,
      plan.params
    );
    const rows = db
      .prepare(
        `select f.topic as topic, t.summary as summary, count(*) as hits
           from ${plan.from} left join topics t on t.id = f.topic
           ${plan.where} group by f.topic order by hits desc, f.topic limit ?`
      )
      .all(...plan.params, filters.limit)
      .map(withoutNullPrototype);
    return { rows, total: topicsMatching };
  }

  function resultClass(built, columns, limit) {
    const total = countRows(
      `select count(*) as c from ${built.from} ${built.where}`,
      built.params
    );
    const rows = db
      .prepare(
        `select ${columns.join(", ")} from ${built.from} ${built.where}
           order by ${built.order} limit ?`
      )
      .all(...built.params, limit)
      .map(withoutNullPrototype);
    return { rows, total };
  }

  function countRows(sql, params) {
    return db.prepare(sql).get(...params).c;
  }

  // --- Project scoping ---

  // ADR 0006 and 0008: every recorded project path that resolves to the given one or to
  // something under it, compared in JavaScript and segment by segment rather than by LIKE.
  function recordedProjectsUnder(path) {
    const root = resolvedPath(path);
    const recorded = db
      .prepare(
        `select project from prompts where project is not null
       union select project from sessions where project is not null`
      )
      .all()
      .map((row) => row.project);

    const matching = recorded.filter((value) => isAtOrUnder(resolvedPath(value), root));
    return matching.length ? matching : [path];
  }

  // --- Quarantine ---

  function quarantinedSessions() {
    const state = createStateStore(config).load();
    const sessions = new Map(
      db
        .prepare("select session_id, project, transcript_path from sessions")
        .all()
        .map((row) => [row.session_id, row])
    );

    return Object.entries(state.quarantined ?? {})
      .map(([sessionId, record]) => ({
        sessionId,
        ts: record?.ts ?? null,
        attempts: record?.attempts ?? null,
        error: record?.error ?? null,
        project: sessions.get(sessionId)?.project ?? null,
        transcriptPath: sessions.get(sessionId)?.transcript_path ?? null,
      }))
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  // --- The --sql escape hatch ---

  // The read path's keyword check is only the friendly refusal: "with x as (select 1) delete
  // from facts" starts with a read and passes it. SQLite itself refuses the write under
  // query_only. It matters because Claude runs --sql on its own, and a deleted row stays gone
  // until its topic file changes, since refresh is incremental. The pragma goes back off
  // because the same connection refreshes the index next.
  function readOnlyQuery(statement, params = []) {
    db.exec("pragma query_only = on");
    try {
      return db.prepare(statement).all(...params).map(withoutNullPrototype);
    } finally {
      db.exec("pragma query_only = off");
    }
  }

  // --- The extractor's questions ---

  // The facts a session's earlier slices already produced, newest first, wherever they were
  // filed. A fact's session is a prefix of the full id, matched the same way
  // SESSION_STARTS_WITH_THE_FACTS_PREFIX joins the two tables.
  function factsFromSession(sessionId, limit) {
    return db
      .prepare(
        `select id, topic, section, text from facts
          where session is not null and substr(?, 1, length(session)) = session
          order by date desc, id desc limit ?`
      )
      .all(sessionId, limit);
  }

  // One flat ranked scan, because bm25 is usable only there and not inside an aggregate, a
  // subquery or a CTE (ADR 0002). The caller groups the rows into topics.
  function factsRankedAgainst(match, limit) {
    return db
      .prepare(
        `select f.id as id, f.topic as topic, f.section as section, f.text as text,
                bm25(facts_fts) as rank
         from facts_fts join facts f on f.id = facts_fts.rowid
         where facts_fts match ?
         order by bm25(facts_fts), f.date desc limit ?`
      )
      .all(match, limit);
  }

  // Every topic a session in the project fed, either through a fact attributed to one of its
  // sessions or through the topic extraction recorded for it.
  function topicsOfProject(project) {
    if (!project) return new Set();
    const projects = recordedProjectsUnder(project);
    const marks = placeholders(projects);

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

  function describeTopic(id) {
    const row = db.prepare("select summary, keywords from topics where id = ?").get(id);
    return { summary: row?.summary ?? null, keywords: row?.keywords ?? null };
  }

  function topicIds() {
    return db
      .prepare("select id from topics")
      .all()
      .map((row) => row.id);
  }

  return {
    facts,
    prompts,
    overview,
    recordedProjectsUnder,
    quarantinedSessions,
    readOnlyQuery,
    factsFromSession,
    factsRankedAgainst,
    topicsOfProject,
    describeTopic,
    topicIds,
  };
}

// --- Query plans ---

function conditions() {
  const clauses = [];
  const params = [];
  return {
    add(clause, value) {
      clauses.push(clause);
      params.push(value);
    },
    addAll(clause, values) {
      clauses.push(clause);
      params.push(...values);
    },
    params,
    where: () => (clauses.length ? `where ${clauses.join(" and ")}` : ""),
  };
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function factBelongsToOneOf(projects) {
  return `exists (
  select 1 from sessions s
  where s.project in (${placeholders(projects)})
    and ((f.session is not null and ${SESSION_STARTS_WITH_THE_FACTS_PREFIX})
      or (f.session is null and s.topic = f.topic)))`;
}

function factPlan(match, { projects, since, until, topic, section, session }) {
  const filter = conditions();
  let from = "facts f";

  if (match) {
    from = "facts_fts join facts f on f.id = facts_fts.rowid";
    filter.add("facts_fts match ?", match);
  }
  if (since) filter.add("f.date >= ?", since);
  if (until) filter.add("f.date <= ?", until);
  if (topic) filter.add("f.topic = ?", topic);
  if (section) filter.add("lower(f.section) = lower(?)", section);
  if (session) filter.add("f.session = ?", session);
  if (projects?.length) filter.addAll(factBelongsToOneOf(projects), projects);

  return {
    from,
    where: filter.where(),
    params: filter.params,
    order: match ? "bm25(facts_fts), f.date desc" : "f.date desc, f.topic, f.line",
  };
}

function promptPlan(match, { projects, since, until, session }) {
  const filter = conditions();
  let from = "prompts p";

  if (match) {
    from = "prompts_fts join prompts p on p.id = prompts_fts.rowid";
    filter.add("prompts_fts match ?", match);
  }
  if (since) filter.add("p.local_date >= ?", since);
  if (until) filter.add("p.local_date <= ?", until);
  if (session) filter.add("p.session = ?", session);
  if (projects?.length) filter.addAll(`p.project in (${placeholders(projects)})`, projects);

  return {
    from,
    where: filter.where(),
    params: filter.params,
    order: match ? "bm25(prompts_fts), p.ts desc" : "p.ts desc",
  };
}

function resolvedPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isAtOrUnder(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function withoutNullPrototype(row) {
  return row ? { ...row } : row;
}
