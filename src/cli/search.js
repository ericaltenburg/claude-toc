import { createConfig } from "../config.js";
import {
  checkedSource,
  createSearch,
  FACT_LIMIT,
  PROMPT_LIMIT,
  SOURCES_A_CALLER_MAY_ASK_FOR,
} from "../search.js";

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

export function main(argv) {
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
      return report(options.json ? jsonTextWithAttribution(rows) : renderRows(rows));
    }
    if (!hasSomethingToSearchFor(options)) {
      process.stdout.write(`${USAGE}\n`);
      return 2;
    }

    const result = search.search(options);
    return report(options.json ? jsonTextWithAttribution(result) : render(result));
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

function jsonTextWithAttribution(value) {
  const payload = Array.isArray(value) ? { rows: value } : value;
  return jsonText({ ...payload, attribution: ATTRIBUTION_NOTE });
}

// Per ADR 0009 every result path carries this, so every renderer below ends with it.
const ATTRIBUTION =
  "note: every line above is dated evidence, not current truth. Attribute it to its\n" +
  "date when you use it, and check anything load-bearing against the systems of record.\n";

const ATTRIBUTION_NOTE = ATTRIBUTION.replace(/^note: /, "").replace(/\s+/g, " ").trim();

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
  return { text: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n\n${ATTRIBUTION}` };
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
  return {
    text:
      `QUARANTINED  ${rows.length}\n${text}\n` +
      `\nRelease and extract one with: toc-extract --retry <session-id>\n`,
  };
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
