import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseJsonLine } from "./json-lines.js";
import { openIndex } from "./index/open.js";
import { ftsQuery, termsQuery } from "./index/terms.js";

export const FACT_LIMIT = 20;
export const PROMPT_LIMIT = 10;

const CLAUDES_OWN_JUDGEMENT = "automatic";
export const SOURCES_A_CALLER_MAY_ASK_FOR = [CLAUDES_OWN_JUDGEMENT, "explicit"];
export const SOURCES = [...SOURCES_A_CALLER_MAY_ASK_FOR, "smoke"];

// --- Query terms ---

const MATCH_EVERY_ROW_THE_FILTERS_ALLOW = { match: null, matchesNothing: false };
const MATCH_NOTHING = { match: null, matchesNothing: true };
const NO_ROWS = { rows: [], total: 0, match: null };

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

export function createSearch(
  config,
  { timeZone, now = () => new Date(), currentProject = theCurrentProject() } = {}
) {
  const index = openIndex(config, { timeZone });

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
      result.facts = resultClass(query, { ...filters, limit }, index.facts);
    }
    if (mode === "prompts" || mode === "both") {
      result.prompts = resultClass(query, { ...filters, limit: promptLimit }, index.prompts);
    }
    if (mode === "overview") {
      result.overview = resultClass(query, { ...filters, limit }, index.overview);
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
    const boundedBy = (path) => ({
      projects: index.recordedProjectsUnder(path),
      scopedTo: path,
    });
    if (project) return boundedBy(project);
    if (source !== CLAUDES_OWN_JUDGEMENT) return { projects: null, scopedTo: null };
    if (allProjects) return { projects: null, scopedTo: null, widened: true };
    return boundedBy(currentProject);
  }

  function resultClass(query, filters, read) {
    const { match, matchesNothing } = matchFor(query);
    if (matchesNothing) return NO_ROWS;

    const run = (effective) => ({ ...read(effective, filters), match: effective });
    return withTermsFallback(query, match, run);
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
    const rows = index.readOnlyQuery(statement, params);
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
    return index.quarantinedSessions();
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

  return { refresh, search, sql, quarantined, smoke, close: () => index.close() };
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

export function checkedSource(value, { allowed, label }) {
  if (allowed.includes(value)) return value;
  throw new Error(`${label} takes ${allowed.join(" or ")}, got ${JSON.stringify(value)}`);
}

function loggedAsUnscoped(source) {
  return source === CLAUDES_OWN_JUDGEMENT;
}

const READ_STATEMENT = /^\s*(?:select|with)\b/i;

// The friendly refusal, before anything is refreshed. It is not the guard: the index runs the
// statement under query_only, which is what refuses a write hidden behind a read.
function assertReadOnly(statement) {
  if (!READ_STATEMENT.test(String(statement))) {
    throw new Error("the read path is read-only: only select and with statements are allowed");
  }
}

function isFts5SyntaxError(error) {
  return /fts5/i.test(String(error?.message));
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
