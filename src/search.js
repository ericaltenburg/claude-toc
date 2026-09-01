import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { parseJsonLine } from "./parse.js";
import { openIndex, SESSION_STARTS_WITH_THE_FACTS_PREFIX } from "./search-index.js";
import { createStateStore } from "./state.js";

export const FACT_LIMIT = 20;
export const PROMPT_LIMIT = 10;

const CLAUDES_OWN_JUDGEMENT = "automatic";
export const SOURCES_A_CALLER_MAY_ASK_FOR = [CLAUDES_OWN_JUDGEMENT, "explicit"];
export const SOURCES = [...SOURCES_A_CALLER_MAY_ASK_FOR, "smoke"];

// --- Query terms ---

const STOPWORDS = new Set(
  `a an and the of to in on for with about from by at or is are was were be been
   what when why how who which did do does done have has had i we my our it its
   that this these those there here so if then than as into over under again
   please can could should would will just not no yes any some all`
    .split(/\s+/)
    .filter(Boolean)
);

const FTS5_OPERATOR_OR_PREFIX_SEARCH = /\b(?:AND|OR|NOT|NEAR)\b|[\p{L}\p{N}]\*/u;
const TERM = /[\p{L}\p{N}_]+/gu;
const SHORTEST_USABLE_TERM = 2;
const SHORTEST_SALIENT_TERM = 3;
const MOST_REPEATED_TERMS_QUERIED = 24;

const MATCH_EVERY_ROW_THE_FILTERS_ALLOW = { match: null, matchesNothing: false };
const MATCH_NOTHING = { match: null, matchesNothing: true };
const NO_ROWS = { rows: [], total: 0, match: null };

function quoted(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

export function termsQuery(text) {
  const terms = String(text ?? "").match(TERM) ?? [];
  const usable = terms.filter((term) => term.length >= SHORTEST_USABLE_TERM);
  const meaningful = usable.filter((term) => !STOPWORDS.has(term.toLowerCase()));
  const chosen = meaningful.length ? meaningful : usable;
  if (!chosen.length) return null;
  return chosen.map(quoted).join(" OR ");
}

export function salientTermsQuery(text) {
  const counts = new Map();
  for (const raw of String(text ?? "").match(TERM) ?? []) {
    const term = raw.toLowerCase();
    if (term.length < SHORTEST_SALIENT_TERM || STOPWORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  if (!counts.size) return null;

  const ranked = [...counts.entries()]
    .sort(([termA, countA], [termB, countB]) => countB - countA || termA.localeCompare(termB))
    .slice(0, MOST_REPEATED_TERMS_QUERIED);
  return ranked.map(([term]) => quoted(term)).join(" OR ");
}

export function ftsQuery(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (FTS5_OPERATOR_OR_PREFIX_SEARCH.test(trimmed)) return trimmed;
  return termsQuery(trimmed);
}

function matchFor(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return MATCH_EVERY_ROW_THE_FILTERS_ALLOW;

  const match = ftsQuery(trimmed);
  return match ? { match, matchesNothing: false } : MATCH_NOTHING;
}

// --- Search ---

function theCurrentProject() {
  return process.env.CLAUDE_PROJECT_DIR || repositoryRootAt(process.cwd()) || process.cwd();
}

function repositoryRootAt(start) {
  let directory = resolvedPath(start);
  for (let parent = dirname(directory); ; parent = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return directory;
    if (parent === directory) return null;
    directory = parent;
  }
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

export function recordedProjectsUnder(db, path) {
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

export function createSearch(
  config,
  { timeZone, now = () => new Date(), currentProject = theCurrentProject() } = {}
) {
  const index = openIndex(config, { timeZone });
  const db = index.db;

  function refresh() {
    return index.refresh();
  }

  function search({
    query = "",
    mode = "both",
    limit = FACT_LIMIT,
    promptLimit = PROMPT_LIMIT,
    project = null,
    since = null,
    until = null,
    date = null,
    topic = null,
    section = null,
    session = null,
    source = "explicit",
    allProjects = false,
    log = true,
  } = {}) {
    checkedSource(source, { allowed: SOURCES, label: "source" });
    refresh();

    const scope = scopeFor({ project, source, allProjects });
    const filters = {
      projects: scope.projects,
      since: date ?? since,
      until: date ?? until,
      topic,
      section,
      session,
    };

    const result = { query, mode, facts: null, prompts: null, overview: null, rows: 0 };
    if (mode === "facts" || mode === "both") {
      result.facts = factRows(query, { ...filters, limit });
    }
    if (mode === "prompts" || mode === "both") {
      result.prompts = promptRows(query, { ...filters, limit: promptLimit });
    }
    if (mode === "overview") {
      result.overview = overviewRows(query, { ...filters, limit });
    }
    result.rows =
      (result.facts?.rows.length ?? 0) +
      (result.prompts?.rows.length ?? 0) +
      (result.overview?.rows.length ?? 0);

    const fellBackFrom =
      result.facts?.fellBackFrom ?? result.prompts?.fellBackFrom ?? result.overview?.fellBackFrom;
    if (log) {
      logSearchBestEffort(config, now, {
        query,
        mode,
        rows: result.rows,
        source,
        project: scope.scopedTo,
        allProjects: scope.widened,
        fellBackFrom,
      });
    }
    return result;
  }

  function scopeFor({ project, source, allProjects }) {
    const boundedBy = (path) => ({ projects: projectValuesUnder(path), scopedTo: path });
    if (project) return boundedBy(project);
    if (source !== CLAUDES_OWN_JUDGEMENT) return { projects: null, scopedTo: null };
    if (allProjects) return { projects: null, scopedTo: null, widened: true };
    return boundedBy(currentProject);
  }

  function projectValuesUnder(path) {
    return recordedProjectsUnder(db, path);
  }

  function factRows(query, filters) {
    return resultClass(query, filters, factPlan, [
      "f.topic",
      "f.section",
      "f.text",
      "f.session",
      "f.date",
      "f.line",
    ]);
  }

  function promptRows(query, filters) {
    return resultClass(query, filters, promptPlan, [
      "p.local_date",
      "p.local_time",
      "p.session",
      "p.project",
      "p.text",
      "p.is_command",
    ]);
  }

  function overviewRows(query, filters) {
    const { match, matchesNothing } = matchFor(query);
    if (matchesNothing) return NO_ROWS;

    const run = (effective) => {
      const plan = factPlan(effective, filters);
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
      return { rows, total: topicsMatching, match: effective };
    };

    return withTermsFallback(query, match, run);
  }

  function resultClass(query, filters, plan, columns) {
    const { match, matchesNothing } = matchFor(query);
    if (matchesNothing) return NO_ROWS;

    const run = (effective) => {
      const built = plan(effective, filters);
      const total = countRows(
        `select count(*) as c from ${built.from} ${built.where}`,
        built.params
      );
      const rows = db
        .prepare(
          `select ${columns.join(", ")} from ${built.from} ${built.where}
           order by ${built.order} limit ?`
        )
        .all(...built.params, filters.limit)
        .map(withoutNullPrototype);
      return { rows, total, match: effective };
    };

    return withTermsFallback(query, match, run);
  }

  function countRows(sql, params) {
    return db.prepare(sql).get(...params).c;
  }

  function withTermsFallback(query, match, run) {
    try {
      return run(match);
    } catch (error) {
      if (!isFts5SyntaxError(error)) throw error;
      const terms = termsQuery(query);
      if (!terms) return NO_ROWS;
      return { ...run(terms), fellBackFrom: match };
    }
  }

  function sql(statement, params = [], { source = "explicit" } = {}) {
    checkedSource(source, { allowed: SOURCES, label: "source" });
    assertReadOnly(statement);
    refresh();
    const rows = db.prepare(statement).all(...params).map(withoutNullPrototype);
    logSearchBestEffort(config, now, {
      query: statement,
      mode: "sql",
      rows: rows.length,
      source,
      allProjects: loggedAsUnscoped(source),
    });
    return rows;
  }

  function quarantined() {
    refresh();
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

  function smoke({ log = true } = {}) {
    const queries = loadSmokeQueries(config);
    if (!queries) {
      return {
        passed: false,
        reason: `no smoke queries at ${config.smokeQueriesPath}`,
        results: [],
      };
    }

    const results = queries.map((entry) => {
      const result = search({ ...entry, source: "smoke", log });
      const topics = new Set(
        [...(result.facts?.rows ?? []), ...(result.overview?.rows ?? [])].map((row) => row.topic)
      );
      const reason = smokeFailure(result, entry, topics);
      return { query: entry.query, mode: result.mode, rows: result.rows, passed: !reason, reason };
    });

    return { passed: results.every((result) => result.passed), results };
  }

  return { db, index, refresh, search, sql, quarantined, smoke, close: () => index.close() };
}

function smokeFailure(result, entry, topics) {
  if (result.rows === 0) return "no rows";
  if (entry.expectTopic && !topics.has(entry.expectTopic)) {
    return `expected topic ${entry.expectTopic} not among ${[...topics].join(", ") || "none"}`;
  }
  return null;
}

function loadSmokeQueries(config) {
  if (!existsSync(config.smokeQueriesPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(config.smokeQueriesPath, "utf-8"));
    const queries = Array.isArray(parsed) ? parsed : parsed?.queries;
    return Array.isArray(queries) && queries.length ? queries : null;
  } catch {
    return null;
  }
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

export function checkedSource(value, { allowed, label }) {
  if (allowed.includes(value)) return value;
  throw new Error(`${label} takes ${allowed.join(" or ")}, got ${JSON.stringify(value)}`);
}

function loggedAsUnscoped(source) {
  return source === CLAUDES_OWN_JUDGEMENT;
}

const READ_STATEMENT = /^\s*(?:select|with)\b/i;

function assertReadOnly(statement) {
  if (!READ_STATEMENT.test(String(statement))) {
    throw new Error("the read path is read-only: only select and with statements are allowed");
  }
}

function isFts5SyntaxError(error) {
  return /fts5/i.test(String(error?.message));
}

function withoutNullPrototype(row) {
  return row ? { ...row } : row;
}

// --- The search log ---

function logSearchBestEffort(
  config,
  now,
  { query, mode, rows, source, project, allProjects, fellBackFrom }
) {
  try {
    mkdirSync(config.corpusDir, { recursive: true });
    appendFileSync(
      config.searchLogPath,
      `${JSON.stringify({
        ts: now().toISOString(),
        query: String(query ?? ""),
        rows,
        mode,
        source,
        ...(project ? { project } : {}),
        ...(allProjects ? { allProjects: true } : {}),
        ...(fellBackFrom ? { fellBackFrom } : {}),
      })}\n`
    );
  } catch {}
}

export function searchLogEntries(config) {
  if (!existsSync(config.searchLogPath)) return [];
  return readFileSync(config.searchLogPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map(parseJsonLine)
    .filter(Boolean);
}

