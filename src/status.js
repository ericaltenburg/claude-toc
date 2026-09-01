#!/usr/bin/env node
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createConfig } from "./config.js";
import { localDateParts } from "./parse.js";
import { openIndex } from "./search-index.js";
import { createStateStore } from "./state.js";
import { createSweeper } from "./sweep.js";

export const HEALTHY = "healthy";
export const NEVER_RUN = "never run";

const A_SECOND = 1_000;
const A_MINUTE = 60 * A_SECOND;
const AN_HOUR = 60 * A_MINUTE;
const A_DAY = 24 * AN_HOUR;

export const EXTRACTION_IS_STALE_AFTER_MS = A_DAY;

// --- Gathering ---

export function createStatusReport(
  config,
  { now = () => Date.now(), timeZone, staleAfterMs } = {}
) {
  function read() {
    const corpus = corpusReadings();
    return summarizeStatus(
      { extraction: extractionReadings(), corpus },
      { now, timeZone, staleAfterMs }
    );
  }

  function corpusReadings() {
    const index = openIndex(config, { timeZone });
    try {
      const startedAt = performance.now();
      index.refresh();
      const refreshMs = performance.now() - startedAt;
      return {
        ...indexStatistics(index.db, { at: now(), timeZone }),
        refreshMs,
        bytes: bytesOnDiskOrNull(config.indexPath),
      };
    } finally {
      index.close();
    }
  }

  function extractionReadings() {
    const store = createStateStore(config);
    const state = store.load();
    return {
      processed: processedReadings(state.processed),
      waiting: createSweeper(config, store, { now }).waitingSessions().length,
      sweptAt: millisecondsOrNull(state.sweptAt),
      lease: leaseReadings(state.extraction, store.leaseExpiresAt(state.extraction)),
      failures: failureReadings(state.failures),
      quarantined: Object.keys(state.quarantined ?? {}).length,
    };
  }

  return { read };
}

function processedReadings(processed = {}) {
  const records = Object.values(processed);
  const timestamps = records.map((record) => millisecondsOrNull(record?.ts)).filter(Number.isFinite);
  return {
    count: records.length,
    lastAt: timestamps.length ? Math.max(...timestamps) : null,
  };
}

function failureReadings(failures = {}) {
  const records = Object.values(failures);
  return {
    sessions: records.length,
    attempts: records.reduce((total, record) => total + (record?.attempts ?? 0), 0),
  };
}

function leaseReadings(extraction, expiresAt) {
  if (!extraction?.holder) return null;
  return {
    holder: extraction.holder,
    startedAt: millisecondsOrNull(extraction.startedAt),
    expiresAt,
  };
}

function millisecondsOrNull(isoTimestamp) {
  const ms = Date.parse(isoTimestamp ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function bytesOnDiskOrNull(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

// --- Index statistics ---

const GROWTH_WINDOWS_IN_DAYS = [7, 30];

function indexStatistics(db, { at = Date.now(), timeZone } = {}) {
  const totals = db
    .prepare(
      `select (select count(*) from topics)   as topics,
              (select count(*) from facts)    as facts,
              (select count(*) from prompts)  as prompts,
              (select count(*) from sessions) as sessions`
    )
    .get();

  return {
    ...totals,
    factsPerTopic: factsPerTopic(db),
    added: GROWTH_WINDOWS_IN_DAYS.map((days) => ({
      days,
      facts: factsAddedSince(db, startOfWindow(at, days, timeZone)),
    })),
  };
}

function factsPerTopic(db) {
  const counts = db
    .prepare(
      `select t.id as topic, count(f.id) as facts
       from topics t left join facts f on f.topic = t.id
       group by t.id
       order by facts desc, t.id asc`
    )
    .all();
  if (!counts.length) return { min: 0, median: 0, max: 0, largest: null };

  const sorted = counts.map((row) => row.facts).sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: medianOf(sorted),
    max: counts[0].facts,
    largest: counts[0].topic,
  };
}

// An even number of topics reports the lower of the two middle counts, so the median is
// always a count some topic really has rather than an average of two that neither does.
function medianOf(ascending) {
  return ascending[Math.floor((ascending.length - 1) / 2)];
}

function factsAddedSince(db, date) {
  return db.prepare("select count(*) as facts from facts where date >= ?").get(date).facts;
}

// A window of N days is N whole local dates, today included, so 7d never means eight. The
// dates are counted back as dates: subtracting milliseconds would drift an hour over DST.
function startOfWindow(at, days, timeZone) {
  const today = Date.parse(`${localDateParts(at, timeZone).date}T${MIDDAY}`);
  return new Date(today - (days - 1) * A_DAY).toISOString().slice(0, "YYYY-MM-DD".length);
}

const MIDDAY = "12:00:00Z";

// --- Summarising ---

export function summarizeStatus(
  readings,
  { now = () => Date.now(), timeZone, staleAfterMs = EXTRACTION_IS_STALE_AFTER_MS } = {}
) {
  const at = now();
  const extraction = { ...NOTHING_RECORDED, ...readings.extraction };
  const corpus = { ...NOTHING_INDEXED, ...readings.corpus };

  return {
    verdict: verdictFor(extraction, at, staleAfterMs),
    blocks: [extractionBlock(extraction, at, timeZone), corpusBlock(corpus)],
  };
}

const NOTHING_RECORDED = {
  processed: { count: 0, lastAt: null },
  waiting: 0,
  sweptAt: null,
  lease: null,
  failures: { sessions: 0, attempts: 0 },
  quarantined: 0,
};

const NOTHING_INDEXED = {
  topics: 0,
  facts: 0,
  prompts: 0,
  sessions: 0,
  factsPerTopic: { min: 0, median: 0, max: 0, largest: null },
  added: GROWTH_WINDOWS_IN_DAYS.map((days) => ({ days, facts: 0 })),
  refreshMs: null,
  bytes: null,
};

function verdictFor(extraction, at, staleAfterMs) {
  if (hasRecordedNothing(extraction)) return { label: NEVER_RUN, problems: [] };

  const problems = [
    queueWithNoExtractionBehindIt(extraction, at, staleAfterMs),
    crashThatNeverRecovered(extraction, at),
  ].filter(Boolean);

  return { label: problems.length ? problemsLabel(problems.length) : HEALTHY, problems };
}

function problemsLabel(count) {
  return `${count} problem${count === 1 ? "" : "s"}`;
}

function queueWithNoExtractionBehindIt(extraction, at, staleAfterMs) {
  const { waiting } = extraction;
  if (!waiting) return null;

  const lastAt = extraction.processed.lastAt;
  const queue = `${sessionCount(waiting)} waiting`;
  if (!Number.isFinite(lastAt)) return `nothing extracted yet with ${queue}`;
  if (at - lastAt < staleAfterMs) return null;
  return `no extraction in ${elapsedToTheHour(at - lastAt)} with ${queue}`;
}

function crashThatNeverRecovered(extraction, at) {
  const { lease } = extraction;
  if (!hasExpired(lease, at)) return null;
  if (extractedSince(extraction, lease.expiresAt)) return null;
  const since = elapsedToTheHour(at - lease.expiresAt);
  return `lease held by ${lease.holder} expired ${since} ago with no extraction since`;
}

function hasExpired(lease, at) {
  return Boolean(lease) && Number.isFinite(lease.expiresAt) && lease.expiresAt <= at;
}

function extractedSince(extraction, ms) {
  return Number.isFinite(extraction.processed.lastAt) && extraction.processed.lastAt >= ms;
}

function hasRecordedNothing(extraction) {
  return (
    !extraction.processed.count &&
    !extraction.sweptAt &&
    !extraction.lease &&
    !extraction.failures.sessions &&
    !extraction.quarantined
  );
}

function extractionBlock(extraction, at, timeZone) {
  return {
    title: "EXTRACTION",
    rows: [
      { label: "last extraction", value: momentWithAge(extraction.processed.lastAt, at, timeZone) },
      { label: "sessions waiting", value: String(extraction.waiting) },
      { label: "hook heartbeat", value: momentWithAge(extraction.sweptAt, at, timeZone) },
      { label: "lease", value: leaseValue(extraction.lease, at) },
      { label: "processed", value: sessionCount(extraction.processed.count) },
      { label: "failures", value: failuresValue(extraction.failures) },
      { label: "quarantined", value: String(extraction.quarantined) },
    ],
  };
}

function corpusBlock(corpus) {
  return {
    title: "CORPUS",
    rows: [
      {
        label: "topics",
        value: thousands(corpus.topics),
        rightAligned: true,
        note: spreadNote(corpus.factsPerTopic),
      },
      {
        label: "facts",
        value: thousands(corpus.facts),
        rightAligned: true,
        note: growthNote(corpus.added),
      },
      { label: "prompts", value: thousands(corpus.prompts), rightAligned: true },
      { label: "sessions", value: thousands(corpus.sessions), rightAligned: true },
      {
        label: "index.db",
        value: megabytes(corpus.bytes),
        rightAligned: true,
        note: refreshNote(corpus.refreshMs),
      },
    ],
  };
}

function spreadNote({ min, median, max, largest }) {
  const largestNamed = largest ? `${thousands(max)} ${largest}` : thousands(max);
  return `facts/topic   min ${thousands(min)}  median ${thousands(median)}  max ${largestNamed}`;
}

function growthNote(added) {
  const windows = added.map((window) => `${window.days}d ${thousands(window.facts)}`);
  return `added   ${windows.join("   ")}`;
}

function refreshNote(ms) {
  return Number.isFinite(ms) ? `refresh took ${Math.round(ms)} ms` : undefined;
}

const A_MEGABYTE = 1024 * 1024;

function megabytes(bytes) {
  if (!Number.isFinite(bytes)) return "missing";
  return `${(bytes / A_MEGABYTE).toFixed(1)} MB`;
}

const NEVER = "never";

function momentWithAge(ms, at, timeZone) {
  if (!Number.isFinite(ms)) return NEVER;
  const { date, time } = localDateParts(ms, timeZone);
  return `${date} ${time.slice(0, "HH:MM".length)}  (${elapsed(at - ms)} ago)`;
}

function leaseValue(lease, at) {
  if (!lease) return "free";
  const notes = [
    Number.isFinite(lease.startedAt) ? elapsed(at - lease.startedAt) : null,
    hasExpired(lease, at) ? `expired ${elapsed(at - lease.expiresAt)} ago` : null,
  ].filter(Boolean);
  const detail = notes.length ? ` (${notes.join(", ")})` : "";
  return `held by ${lease.holder}${detail}`;
}

function failuresValue({ sessions, attempts }) {
  if (!sessions) return "0";
  if (sessions === 1) {
    return `1 (${attempts} attempt${attempts === 1 ? "" : "s"}, short of quarantine)`;
  }
  return `${sessions} (${attempts} attempts between them, short of quarantine)`;
}

function sessionCount(count) {
  return `${thousands(count)} session${count === 1 ? "" : "s"}`;
}

function elapsed(ms) {
  const since = Math.max(0, ms);
  if (since < A_MINUTE) return `${Math.floor(since / A_SECOND)}s`;
  if (since < AN_HOUR) return `${Math.floor(since / A_MINUTE)}m`;
  if (since < A_DAY) return `${Math.floor(since / AN_HOUR)}h`;
  return `${Math.floor(since / A_DAY)}d`;
}

function elapsedToTheHour(ms) {
  const since = Math.max(0, ms);
  return since < AN_HOUR ? elapsed(since) : `${Math.floor(since / AN_HOUR)}h`;
}

const thousands = (count) => count.toLocaleString("en-US");

// --- Rendering ---

const REPORT_WIDTH = 68;
const LABEL_WIDTH = 21;
const RIGHT_ALIGNED_WIDTH = 7;
const VALUE_WIDTH = 15;

export function renderStatus(report) {
  const lines = [verdictLine(report.verdict), ...report.verdict.problems.map((p) => `  ! ${p}`)];

  for (const block of report.blocks) {
    lines.push("", block.title);
    for (const row of block.rows) {
      lines.push(`  ${row.label.padEnd(LABEL_WIDTH)}${valueField(row)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function valueField(row) {
  const value = row.rightAligned ? row.value.padStart(RIGHT_ALIGNED_WIDTH) : row.value;
  return row.note ? `${value.padEnd(VALUE_WIDTH)}${row.note}` : value;
}

function verdictLine(verdict) {
  const title = "claude-toc status";
  return title + verdict.label.padStart(REPORT_WIDTH - title.length);
}

export function renderStatusAsMarkdown(report) {
  const lines = [`# claude-toc status: ${report.verdict.label}`];
  if (report.verdict.problems.length) {
    lines.push("", ...report.verdict.problems.map((problem) => `- ${problem}`));
  }

  for (const block of report.blocks) {
    const headings = block.rows.some((row) => row.note)
      ? ["reading", "value", "note"]
      : ["reading", "value"];
    lines.push("", `## ${block.title}`, "", tableRow(headings), tableRow(headings.map(() => "---")));
    for (const row of block.rows) {
      lines.push(tableRow([row.label, row.value, row.note ?? ""].slice(0, headings.length)));
    }
  }

  return `${lines.join("\n")}\n`;
}

const tableRow = (cells) => `| ${cells.join(" | ")} |`;

// --- CLI ---

const USAGE = "usage: toc-status [--markdown]";

function main(argv) {
  const markdown = argv.includes("--markdown");
  const unrecognised = argv.filter((argument) => argument !== "--markdown");
  if (unrecognised.length) {
    process.stderr.write(`toc-status: unexpected argument ${unrecognised[0]}\n${USAGE}\n`);
    return 2;
  }

  const report = createStatusReport(createConfig()).read();
  process.stdout.write(markdown ? renderStatusAsMarkdown(report) : renderStatus(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
