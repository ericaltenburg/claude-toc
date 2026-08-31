#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createConfig } from "./config.js";
import { openIndex } from "./search-index.js";
import { createStateStore } from "./state.js";

export const FACT_LIMIT = 20;
export const PROMPT_LIMIT = 10;

// See docs/adr/0006 for why the source of a search also decides its project scope.
const CLAUDES_OWN_JUDGEMENT = "automatic";
const SOURCES_A_CALLER_MAY_ASK_FOR = [CLAUDES_OWN_JUDGEMENT, "explicit"];
const SOURCES = [...SOURCES_A_CALLER_MAY_ASK_FOR, "smoke"];

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

// A session's working directory is often a subdirectory of the project, so the project is
// the repository that contains it. Without this, an automatic search comes back empty and
// reads as "nothing recorded" — the silent, plausible failure ADR 0006 exists to remove.
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

  // One decision, in one place: what the search is bounded by, the path to record for it,
  // and whether an automatic search was deliberately widened past the current project.
  function scopeFor({ project, source, allProjects }) {
    const boundedBy = (path) => ({ projects: projectValuesUnder(path), scopedTo: path });
    if (project) return boundedBy(project);
    if (source !== CLAUDES_OWN_JUDGEMENT) return { projects: null, scopedTo: null };
    if (allProjects) return { projects: null, scopedTo: null, widened: true };
    return boundedBy(currentProject);
  }

  // Every recorded project path at or under this one, so a session started in a
  // subdirectory still counts, and a sibling that merely shares a prefix does not.
  function projectValuesUnder(path) {
    const root = resolvedPath(path);
    const matching = recordedProjects().filter((value) => isAtOrUnder(resolvedPath(value), root));
    return matching.length ? matching : [path];
  }

  function recordedProjects() {
    return db
      .prepare(
        `select project from prompts where project is not null
         union select project from sessions where project is not null`
      )
      .all()
      .map((row) => row.project);
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
      // A hand-written statement carries its own where clause, so nothing here can bound it
      // to a project. An automatic one is logged as unscoped rather than presumed scoped.
      allProjects: source === CLAUDES_OWN_JUDGEMENT,
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

  function smoke() {
    const queries = loadSmokeQueries(config);
    if (!queries) {
      return {
        passed: false,
        reason: `no smoke queries at ${config.smokeQueriesPath}`,
        results: [],
      };
    }

    const results = queries.map((entry) => {
      const result = search({ ...entry, source: "smoke" });
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
    and ((f.session is not null and s.session_id like f.session || '%')
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

// One rule, two audiences: the library knows its own three sources, the command line offers
// the two a caller may ask for. A typo must not become a third source in the log.
function checkedSource(value, { allowed, label }) {
  if (allowed.includes(value)) return value;
  throw new Error(`${label} takes ${allowed.join(" or ")}, got ${JSON.stringify(value)}`);
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

// --- CLI ---

const USAGE = `toc-search [options] [query]

  --facts | --prompts | --overview   result classes to return (default: both)
  --limit N                          facts to return (default: ${FACT_LIMIT})
  --prompt-limit N                   prompts to return (default: ${PROMPT_LIMIT})
  --date YYYY-MM-DD                  one local day
  --since / --until YYYY-MM-DD       a local date range
  --project PATH                     scope to one project directory and what is under it
  --all-projects                     undo the scoping an automatic search applies
  --topic ID / --section NAME        scope to one topic or section
  --session ID                       scope to one session
  --source automatic|explicit        recorded in the search log; automatic scopes
                                     itself to the current project
  --sql "select ..."                 anything the flags cannot express
  --quarantined                      sessions extraction gave up on
  --smoke                            run the corpus's smoke queries
  --json                             machine-readable output`;

const FLAGS = new Map([
  ["--limit", "limit"],
  ["--prompt-limit", "promptLimit"],
  ["--date", "date"],
  ["--since", "since"],
  ["--until", "until"],
  ["--project", "project"],
  ["--topic", "topic"],
  ["--section", "section"],
  ["--session", "session"],
  ["--source", "source"],
  ["--sql", "sqlText"],
]);

const FILTERS = ["date", "since", "until", "project", "topic", "section", "session"];

export function parseArgs(argv) {
  const options = { mode: "both", words: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.has(arg)) {
      options[FLAGS.get(arg)] = argv[++i];
      continue;
    }
    if (arg === "--facts" || arg === "--prompts" || arg === "--overview") {
      options.mode = arg.slice(2);
      continue;
    }
    if (arg === "--json" || arg === "--smoke" || arg === "--quarantined" || arg === "--help") {
      options[arg.slice(2)] = true;
      continue;
    }
    if (arg === "--all-projects") {
      options.allProjects = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    options.words.push(arg);
  }

  options.query = options.words.join(" ");
  for (const key of ["limit", "promptLimit"]) {
    if (options[key] !== undefined) options[key] = positiveWholeNumber(options[key], key);
  }
  if ("source" in options) {
    options.source = checkedSource(options.source, {
      allowed: SOURCES_A_CALLER_MAY_ASK_FOR,
      label: "--source",
    });
  }
  return options;
}

function positiveWholeNumber(value, key) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${key} needs a positive whole number, got ${value}`);
  }
  return count;
}

function main(argv) {
  try {
    return run(argv);
  } catch (error) {
    process.stderr.write(`toc-search: ${error.message}\n`);
    return 2;
  }
}

function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const search = createSearch(createConfig());
  try {
    if (options.smoke) return report(renderSmoke(search.smoke(), options));
    if (options.quarantined) {
      const rows = search.quarantined();
      return report(options.json ? jsonText(rows) : renderQuarantined(rows));
    }
    if (options.sqlText) {
      const rows = search.sql(options.sqlText, [], { source: options.source ?? "explicit" });
      return report(options.json ? jsonText(rows) : renderRows(rows));
    }
    if (!hasSomethingToSearchFor(options)) {
      process.stdout.write(`${USAGE}\n`);
      return 2;
    }

    const result = search.search(options);
    return report(options.json ? jsonText(result) : render(result));
  } finally {
    search.close();
  }
}

function hasSomethingToSearchFor(options) {
  return Boolean(options.query) || FILTERS.some((filter) => options[filter]);
}

function report(rendered) {
  process.stdout.write(rendered.text);
  return rendered.status ?? 0;
}

function jsonText(value) {
  return { text: `${JSON.stringify(value, null, 2)}\n` };
}

const ATTRIBUTION =
  "note: every line above is dated evidence, not current truth. Attribute it to its\n" +
  "date when you use it, and check anything load-bearing against the systems of record.\n";


function render(result) {
  const parts = [];

  if (result.facts) {
    parts.push(heading("FACTS", result.facts));
    parts.push(
      ...result.facts.rows.map(
        (row, i) =>
          `${pad(i)}. [${row.topic} | ${row.section} | ${row.date ?? "undated"}` +
          `${row.session ? ` | session ${row.session}` : ""}]\n     ${row.text}`
      )
    );
  }
  if (result.prompts) {
    parts.push(heading("PROMPTS", result.prompts));
    parts.push(
      ...result.prompts.rows.map(
        (row, i) =>
          `${pad(i)}. [${row.local_date} ${row.local_time.slice(0, 5)}` +
          `${row.project ? ` | ${row.project}` : ""}]\n     ${row.text}`
      )
    );
  }
  if (result.overview) {
    parts.push(heading("OVERVIEW", result.overview));
    parts.push(
      ...result.overview.rows.map(
        (row) =>
          `  ${row.hits.toString().padStart(4)} ${row.hits === 1 ? "hit " : "hits"}  ${row.topic}` +
          `${row.summary ? `\n              ${row.summary}` : ""}`
      )
    );
  }

  if (result.rows === 0) parts.push("no results.");
  return { text: `${parts.join("\n")}\n${result.rows ? `\n${ATTRIBUTION}` : ""}` };
}

function heading(label, section) {
  return `${label}  ${section.rows.length} of ${section.total}`;
}

function pad(index) {
  return `  ${index + 1}`.slice(-3);
}

function renderRows(rows) {
  if (!rows.length) return { text: "no rows.\n" };
  return { text: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` };
}

function renderQuarantined(rows) {
  if (!rows.length) return { text: "nothing quarantined.\n" };
  const text = rows
    .map(
      (row) =>
        `${row.sessionId}  attempts ${row.attempts ?? "?"}  ${row.ts ?? "undated"}\n` +
        `  project: ${row.project ?? "unknown"}\n` +
        `  transcript: ${row.transcriptPath ?? "gone"}\n` +
        `  error: ${row.error ?? "unrecorded"}`
    )
    .join("\n");
  return { text: `QUARANTINED  ${rows.length}\n${text}\n` };
}

function renderSmoke(report, options) {
  if (options.json) return { ...jsonText(report), status: report.passed ? 0 : 1 };

  const lines = report.reason ? [report.reason] : [];
  for (const result of report.results) {
    lines.push(
      `${result.passed ? "ok  " : "FAIL"}  ${result.rows} rows  ${result.query}` +
        `${result.reason ? `  (${result.reason})` : ""}`
    );
  }
  lines.push(report.passed ? "smoke queries passed." : "smoke queries FAILED.");
  return { text: `${lines.join("\n")}\n`, status: report.passed ? 0 : 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
