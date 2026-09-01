import { statSync } from "node:fs";

import { dollars, thousands } from "./format.js";
import { localDateParts } from "./parse.js";
import { createSearch, searchLogEntries, SOURCES } from "./search.js";
import { openIndex } from "./search-index.js";
import { createSpendLog, UNDATED } from "./spend.js";
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
  // One instant for the whole report, so a run just before local midnight cannot bucket
  // one block in yesterday and the next in today.
  function read() {
    const at = now();
    return summarizeStatus(
      {
        extraction: extractionReadings(),
        corpus: corpusReadings(at),
        search: searchReadings(at),
        spend: spendReadings(at),
        smoke: smokeReadings(),
      },
      { now: () => at, timeZone, staleAfterMs }
    );
  }

  // Suppressed logging is what makes this safe to do on every invocation: without it each
  // run would append a line per query to the log whose smoke count this same report
  // prints, so the report would spend forever inflating its own numbers.
  function smokeReadings() {
    const search = createSearch(config, { timeZone });
    try {
      const { results } = search.smoke({ log: false });
      return {
        configured: results.length,
        failed: results.filter((result) => !result.passed).length,
      };
    } finally {
      search.close();
    }
  }

  function spendReadings(at) {
    const spend = createSpendLog(config, { timeZone });
    return {
      windows: spendWindows(spend.summarize(), { at, timeZone }),
      billedTo: {
        profile: config.awsProfile,
        region: config.awsRegion,
        ratesPath: config.modelRatesPath,
      },
    };
  }

  function searchReadings(at) {
    return summarizeSearchLog(searchLogEntries(config), { at, timeZone });
  }

  function corpusReadings(at) {
    const index = openIndex(config, { timeZone });
    try {
      const startedAt = performance.now();
      index.refresh();
      const refreshMs = performance.now() - startedAt;
      return {
        ...indexStatistics(index.db, { at, timeZone }),
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

// One list, so two blocks reporting across windows cannot come to report different ones.
const ALL_TIME = null;
const REPORTING_WINDOWS = [7, 30, ALL_TIME];

function within(localDate, since) {
  if (since === ALL_TIME) return true;
  return localDate !== null && localDate >= since;
}

// --- The search log ---

// The two tallies that are not sources: a search the corpus could not answer, and a query
// whose syntax was rejected and silently retried as bare terms.
const RETURNED_NOTHING = "returned nothing";
const SYNTAX_FALLBACK = "syntax fallback";

// The search log stores an ISO timestamp and no local date, unlike the spend log. Per ADR
// 0005 the windows are local days, so the local date is derived here and the log is left
// exactly as the read path writes it.
export function summarizeSearchLog(entries, { at = Date.now(), timeZone } = {}) {
  const windows = REPORTING_WINDOWS.map((days) => ({
    days,
    since: days === ALL_TIME ? null : startOfWindow(at, days, timeZone),
  }));

  const counted = entries.map((entry) => ({
    localDate: localDateOrNull(entry.ts, timeZone),
    source: entry.source,
    returnedNothing: entry.rows === 0,
    fellBack: Boolean(entry.fellBackFrom),
  }));

  const tallies = [
    ...SOURCES.map((source) => ({
      key: source,
      matches: (entry) => entry.source === source,
    })),
    { key: RETURNED_NOTHING, matches: (entry) => entry.returnedNothing },
    { key: SYNTAX_FALLBACK, matches: (entry) => entry.fellBack },
  ];

  return {
    windows: windows.map(({ days }) => ({ days })),
    tallies: tallies.map(({ key, matches }) => ({
      key,
      counts: windows.map(
        ({ since }) =>
          counted.filter((entry) => matches(entry) && within(entry.localDate, since)).length
      ),
    })),
  };
}

function localDateOrNull(isoTimestamp, timeZone) {
  const ms = millisecondsOrNull(isoTimestamp);
  return ms === null ? null : localDateParts(ms, timeZone).date;
}

// --- Spend ---

// Spend records carry the local date they were made on, so the windows are re-bucketed
// from the spend summariser's by-day tallies rather than derived here a second time.
function spendWindows({ total, byDay }, { at, timeZone }) {
  return REPORTING_WINDOWS.map((days) => ({
    days,
    ...tallied(days === ALL_TIME ? [total] : byDay.filter(dated(at, days, timeZone))),
  }));
}

// A call recorded without a local date belongs to no window, and its key is not a date at
// all, so comparing it as one would put it in every window.
function dated(at, days, timeZone) {
  const since = startOfWindow(at, days, timeZone);
  return (day) => day.key !== UNDATED && within(day.key, since);
}

function tallied(tallies) {
  return {
    calls: totalOf(tallies, "calls"),
    cost: totalOf(tallies, "cost"),
    unpriced: totalOf(tallies, "unpriced"),
  };
}

const totalOf = (tallies, field) => tallies.reduce((total, tally) => total + tally[field], 0);

// --- Summarising ---

export function summarizeStatus(
  readings,
  { now = () => Date.now(), timeZone, staleAfterMs = EXTRACTION_IS_STALE_AFTER_MS } = {}
) {
  const at = now();
  const extraction = { ...NOTHING_RECORDED, ...readings.extraction };
  const corpus = { ...NOTHING_INDEXED, ...readings.corpus };
  const search = readings.search ?? summarizeSearchLog([], { at, timeZone });
  const spend = { ...NOTHING_SPENT, ...readings.spend };
  const smoke = { ...NOTHING_SMOKED, ...readings.smoke };

  return {
    verdict: verdictFor(extraction, smoke, at, staleAfterMs),
    blocks: [
      extractionBlock(extraction, at, timeZone),
      corpusBlock(corpus),
      searchBlock(search),
      spendBlock(spend),
    ],
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

const NOTHING_SMOKED = { configured: 0, failed: 0 };

const NOTHING_SPENT = {
  windows: REPORTING_WINDOWS.map((days) => ({ days, calls: 0, cost: 0, unpriced: 0 })),
  billedTo: null,
};

// A corpus that has recorded nothing holds no facts, so its smoke queries fail for want of
// anything to find. That is the empty corpus reporting itself, not a read path that broke.
function verdictFor(extraction, smoke, at, staleAfterMs) {
  if (hasRecordedNothing(extraction)) return { label: NEVER_RUN, problems: [] };

  const problems = [
    queueWithNoExtractionBehindIt(extraction, at, staleAfterMs),
    crashThatNeverRecovered(extraction, at),
    questionsTheCorpusCanNoLongerAnswer(smoke),
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

function questionsTheCorpusCanNoLongerAnswer(smoke) {
  if (!smoke.failed) return null;
  return `smoke queries ${smokeOutcome(smoke)}`;
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

// Every label below names the question its row answers rather than the mechanism the
// reading came from, and the code keeps its mechanism names. ADR 0015 records why the two
// registers are allowed to differ, and CONTEXT.md carries the mapping between them.
function extractionBlock(extraction, at, timeZone) {
  return {
    title: "EXTRACTION",
    rows: [
      { label: "last extraction", value: momentWithAge(extraction.processed.lastAt, at, timeZone) },
      { label: "sessions waiting", value: String(extraction.waiting) },
      { label: "last checked for work", value: momentWithAge(extraction.sweptAt, at, timeZone) },
      { label: "extracting now", value: extractingNowValue(extraction.lease, at) },
      { label: "sessions extracted", value: thousands(extraction.processed.count) },
      { label: "retrying after failure", value: retryingValue(extraction.failures) },
      { label: "given up on", value: String(extraction.quarantined) },
    ],
  };
}

function corpusBlock(corpus) {
  return {
    title: "CORPUS",
    rows: [
      { label: "topics", value: thousands(corpus.topics) },
      { label: "facts", value: thousands(corpus.facts) },
      { label: "facts added", values: growthCells(corpus.added) },
      { label: "facts per topic", values: spreadCells(corpus.factsPerTopic) },
      { label: "largest topic", value: corpus.factsPerTopic.largest ?? NONE },
      { label: "prompts", value: thousands(corpus.prompts) },
      { label: "sessions", value: thousands(corpus.sessions) },
      { label: "index.db", values: indexFileCells(corpus) },
    ],
  };
}

// The log records which source issued a search; the report says who decided to search. Every
// source search.js can write needs a label here, or its row renders without one.
export const SEARCH_ROW_LABELS = {
  automatic: "Claude searched",
  explicit: "you searched",
  smoke: "self-tests",
  [RETURNED_NOTHING]: "found nothing",
  [SYNTAX_FALLBACK]: "bad syntax, retried",
};

// Smoke runs on every invocation and reaches the verdict when it fails, but it is not a
// row: the corpus answering its own known-good queries is a pass/fail, not a count, and
// the counted rows here are what the log recorded rather than what just happened.
function searchBlock(search) {
  return {
    title: "SEARCH",
    columns: search.windows.map(windowHeading),
    rows: search.tallies.map((tally) => ({
      label: SEARCH_ROW_LABELS[tally.key],
      values: tally.counts.map(thousands),
    })),
  };
}

// The verdict is the only place smoke is spoken, so it phrases the outcome.
function smokeOutcome({ configured, failed }) {
  const [outcome, counted] = failed ? ["FAILED", failed] : ["passed", configured - failed];
  return `${outcome} (${counted} of ${configured})`;
}

function spendBlock({ windows, billedTo }) {
  return {
    title: "SPEND",
    columns: windows.map(windowHeading),
    rows: [
      { label: "model calls", values: windows.map((window) => thousands(window.calls)) },
      { label: "estimated cost", values: windows.map((window) => dollars(window.cost)) },
      { label: "calls with no rate", values: windows.map((window) => thousands(window.unpriced)) },
    ],
    footer: whoseBillThisIs(billedTo),
  };
}

function whoseBillThisIs(billedTo) {
  if (!billedTo) return [];
  return [
    `Billed to the AWS profile ${billedTo.profile} in ${billedTo.region}.`,
    `Rates are list prices; edit ${billedTo.ratesPath} to match your bill.`,
  ];
}

const windowHeading = ({ days }) => (days === ALL_TIME ? "all-time" : `${days}d`);

// Two readings of one subject share a row where neither is worth a row of its own. The gap
// between them is wide enough to read as two readings and not as one sentence.
// A reading made of several readings gets a cell each, so the eye lands on one number at a
// time instead of parsing a run of words. Each cell says what it holds, because the cells of
// one row do not mean the same kind of thing and no header could name them all.
function spreadCells({ min, median, max }) {
  return [`min ${thousands(min)}`, `median ${thousands(median)}`, `max ${thousands(max)}`];
}

function growthCells(added) {
  return added.map((window) => `${window.days}d ${thousands(window.facts)}`);
}

function indexFileCells({ bytes, refreshMs }) {
  const refresh = Number.isFinite(refreshMs) ? `refresh took ${Math.round(refreshMs)} ms` : null;
  return [megabytes(bytes), refresh].filter(Boolean);
}

const A_MEGABYTE = 1024 * 1024;

function megabytes(bytes) {
  if (!Number.isFinite(bytes)) return "missing";
  return `${(bytes / A_MEGABYTE).toFixed(1)} MB`;
}

const NEVER = "never";
const NONE = "none";

function momentWithAge(ms, at, timeZone) {
  if (!Number.isFinite(ms)) return NEVER;
  const { date, time } = localDateParts(ms, timeZone);
  return `${date} ${time.slice(0, "HH:MM".length)}  (${elapsed(at - ms)} ago)`;
}

// A held lease is an extraction in flight, which is the only part of the mechanism the
// operator can act on. The holder is a random identifier and appears only in the problem
// line for an expired lease nothing recovered from, where it is the thing to go and look
// for. An expiry is still noted here, because ADR 0014 reports a recovered crash without
// counting it as blockage and this row is where that recovery is visible.
function extractingNowValue(lease, at) {
  if (!lease) return "no";
  const since = [
    Number.isFinite(lease.startedAt) ? `started ${elapsed(at - lease.startedAt)} ago` : null,
    hasExpired(lease, at) ? `expired ${elapsed(at - lease.expiresAt)} ago` : null,
  ].filter(Boolean);
  return since.length ? `yes (${since.join(", ")})` : "yes";
}

function retryingValue({ sessions, attempts }) {
  if (!sessions) return "0";
  return `${sessionCount(sessions)} (${attempts} attempt${attempts === 1 ? "" : "s"})`;
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
