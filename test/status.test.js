import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import {
  createStatusReport,
  summarizeSearchLog,
  summarizeStatus,
  EXTRACTION_IS_STALE_AFTER_MS,
  SEARCH_ROW_LABELS,
} from "../src/status.js";
import { renderStatus } from "../src/cli/status.js";
import { SOURCES } from "../src/search.js";
import { createSpendLog } from "../src/spend.js";
import { createStateStore, EXTRACTION_LEASE_MS } from "../src/state.js";
import { SESSION_IS_IDLE_AFTER_MS } from "../src/sweep.js";
import { EXTRACTION_PROMPT_MARKER } from "../src/extract-prompt.js";
import {
  appendPrompts,
  appendSessions,
  idleFor,
  runCli,
  tempCorpus,
  writeSmokeQueries,
  writeTopic,
  writeTranscript,
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  LATE_ON_26_AUGUST_IN_NEW_YORK,
  STATUS_REPORT,
} from "./support/corpus.js";
import {
  corpusReadings,
  extractionReadings,
  factsDated,
  leaseExpired,
  leaseLive,
  A_DAY,
  A_MINUTE,
  AN_HOUR,
  EXTRACTED_ONCE,
  NEW_YORK,
} from "./support/readings.js";

function extractionBlock(report) {
  const block = report.blocks.find((candidate) => candidate.title === "EXTRACTION");
  assert.ok(block, "the report should carry an EXTRACTION block");
  return block;
}

function rowValue(report, label) {
  const row = extractionBlock(report).rows.find((candidate) => candidate.label === label);
  assert.ok(row, `the EXTRACTION block should carry a "${label}" row`);
  return row.value;
}

function corpusRow(report, label) {
  const block = report.blocks.find((candidate) => candidate.title === "CORPUS");
  assert.ok(block, "the report should carry a CORPUS block");
  const row = block.rows.find((candidate) => candidate.label === label);
  assert.ok(row, `the CORPUS block should carry a "${label}" row`);
  return row;
}

function localDay(at, daysAgo) {
  return new Date(at - daysAgo * A_DAY).toISOString().slice(0, "YYYY-MM-DD".length);
}

function statusOver(config, { at = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK } = {}) {
  return createStatusReport(config, { timeZone: NEW_YORK, now: () => at }).read();
}

function idleSessionWithUnreadTurns(config, sessionId) {
  const path = writeTranscript(config, sessionId, [{ role: "user", text: "a question" }]);
  return idleFor(path, SESSION_IS_IDLE_AFTER_MS + A_MINUTE);
}

// --- The pure summariser ---

test("a corpus that has recorded nothing at all reads as never run, not as healthy", () => {
  const report = summarizeStatus(extractionReadings(), { now: () => Date.now() });

  assert.equal(report.verdict.label, "never run");
});

test("a corpus with an extraction behind it reads as healthy", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({ processed: { count: 173, lastAt: now - 13 * A_MINUTE } }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("the last extraction is dated in local time and aged from the injected clock", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({ processed: { count: 173, lastAt: now - 13 * A_MINUTE } }),
    { now: () => now, timeZone: NEW_YORK }
  );

  assert.equal(rowValue(report, "last extraction"), "2026-08-27 10:47  (13m ago)");
  assert.equal(rowValue(report, "sessions extracted"), "173");
});

test("a queue with nothing recorded behind it still reads as never run", () => {
  const report = summarizeStatus(extractionReadings({ waiting: 4 }), { now: () => Date.now() });

  assert.equal(report.verdict.label, "never run");
  assert.equal(rowValue(report, "sessions waiting"), "4");
});

test("the sweep row says it checked for work, which is not the same as having done it", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 1, lastAt: now - AN_HOUR },
      sweptAt: now - 4 * A_MINUTE,
    }),
    { now: () => now, timeZone: NEW_YORK }
  );

  const labels = extractionBlock(report).rows.map((row) => row.label);
  assert.ok(labels.includes("last extraction"));
  assert.ok(labels.includes("last checked for work"));
  assert.equal(rowValue(report, "last checked for work"), "2026-08-27 10:56  (4m ago)");
});

test("nothing extracted and nothing swept read as never rather than as a date", () => {
  const report = summarizeStatus(extractionReadings({ quarantined: 1 }), {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.equal(rowValue(report, "last extraction"), "never");
  assert.equal(rowValue(report, "last checked for work"), "never");
});

test("an extraction in flight is reported as one, and an idle lease as no extraction", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const free = summarizeStatus(extractionReadings({ processed: { count: 1, lastAt: now } }), {
    now: () => now,
  });
  const held = summarizeStatus(
    extractionReadings({
      processed: { count: 1, lastAt: now },
      lease: { holder: "sweep-316972f2", startedAt: now - 2 * A_MINUTE },
    }),
    { now: () => now }
  );

  assert.equal(rowValue(free, "extracting now"), "no");
  assert.equal(rowValue(held, "extracting now"), "yes (started 2m ago)");
});

test("the report names no mechanism, and the lease is not among its labels", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({ processed: { count: 1, lastAt: now }, lease: leaseLive(now) }),
    { now: () => now }
  );

  assert.deepEqual(
    extractionBlock(report).rows.map((row) => row.label),
    [
      "last extraction",
      "sessions waiting",
      "last checked for work",
      "extracting now",
      "sessions extracted",
      "retrying after failure",
      "given up on",
    ]
  );
});

test("failures short of quarantine are counted with their attempts", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 1, lastAt: now },
      failures: { sessions: 1, attempts: 1 },
      quarantined: 2,
    }),
    { now: () => now }
  );

  assert.equal(rowValue(report, "retrying after failure"), "1 session (1 attempt)");
  assert.equal(rowValue(report, "given up on"), "2");
});

test("attempts spread over several failing sessions are not read as one session's", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 1, lastAt: now },
      failures: { sessions: 2, attempts: 4 },
    }),
    { now: () => now }
  );

  assert.equal(rowValue(report, "retrying after failure"), "2 sessions (4 attempts)");
});

// --- The verdict ---

test("a stale extraction with sessions waiting is a problem", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({ processed: { count: 173, lastAt: now - 31 * AN_HOUR }, waiting: 4 }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "1 problem");
  assert.deepEqual(report.verdict.problems, ["no extraction in 31h with 4 sessions waiting"]);
});

test("one session waiting behind a stale extraction is named in the singular", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({ processed: { count: 1, lastAt: now - 2 * A_DAY }, waiting: 1 }),
    { now: () => now }
  );

  assert.deepEqual(report.verdict.problems, ["no extraction in 48h with 1 session waiting"]);
});

test("a stale extraction with an empty queue is the quiet weekend, and is healthy", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({ processed: { count: 173, lastAt: now - 3 * A_DAY }, waiting: 0 }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("a queue behind an extraction inside the threshold is healthy", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 173, lastAt: now - (EXTRACTION_IS_STALE_AFTER_MS - A_MINUTE) },
      waiting: 9,
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
});

test("the staleness threshold is overridable through the options object", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const readings = extractionReadings({
    processed: { count: 173, lastAt: now - 2 * AN_HOUR },
    waiting: 3,
  });

  assert.equal(summarizeStatus(readings, { now: () => now }).verdict.label, "healthy");
  assert.equal(
    summarizeStatus(readings, { now: () => now, staleAfterMs: AN_HOUR }).verdict.label,
    "1 problem"
  );
});

test("a frozen sweep with an empty queue is healthy", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 173, lastAt: now - 9 * A_DAY },
      sweptAt: now - 9 * A_DAY,
      waiting: 0,
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("an expired lease with an extraction since it expired is reported, not a problem", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 4, lastAt: now - A_MINUTE },
      lease: leaseExpired(now, 15 * A_MINUTE),
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.match(rowValue(report, "extracting now"), /expired/);
});

test("an expired lease with no extraction since it expired is a problem", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 4, lastAt: now - 40 * A_MINUTE },
      lease: leaseExpired(now, 15 * A_MINUTE),
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "1 problem");
  assert.deepEqual(report.verdict.problems, [
    "lease held by sweep-316972f2 expired 15m ago with no extraction since",
  ]);
});

test("a live lease over a fresh extraction is not a problem however long the queue", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 4, lastAt: now - A_MINUTE },
      lease: leaseLive(now),
      waiting: 12,
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
});

test("failures short of quarantine never reach the verdict", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 4, lastAt: now - A_MINUTE },
      failures: { sessions: 3, attempts: 5 },
      quarantined: 2,
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("two problems at once are counted in the plural and named one per line", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 4, lastAt: now - 31 * AN_HOUR },
      waiting: 2,
      lease: leaseExpired(now, 2 * AN_HOUR),
    }),
    { now: () => now }
  );

  assert.equal(report.verdict.label, "2 problems");
  assert.deepEqual(renderStatus(report).split("\n").slice(1, 3), [
    "  ! no extraction in 31h with 2 sessions waiting",
    "  ! lease held by sweep-316972f2 expired 2h ago with no extraction since",
  ]);
});

test("a queue with nothing ever extracted reads as never run rather than as a problem", () => {
  const report = summarizeStatus(extractionReadings({ waiting: 4, sweptAt: null }), {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.equal(report.verdict.label, "never run");
  assert.deepEqual(report.verdict.problems, []);
});

test("a swept corpus that has never extracted anything with a queue is a problem", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(extractionReadings({ waiting: 4, sweptAt: now - A_MINUTE }), {
    now: () => now,
  });

  assert.equal(report.verdict.label, "1 problem");
  assert.deepEqual(report.verdict.problems, ["nothing extracted yet with 4 sessions waiting"]);
});

// --- Gathering against a real corpus ---

test("an empty corpus reads as never run through the gathering seam", () => {
  const config = tempCorpus();

  const report = createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.equal(report.verdict.label, "never run");
  assert.equal(rowValue(report, "sessions waiting"), "0");
});

test("the waiting count is what the next sweep would act on", () => {
  const config = tempCorpus();
  const waiting = "316972f2-1111-2222-3333-444455556666";
  const quarantined = "4a3a87fa-1111-2222-3333-444455556666";
  const busy = "5b4b98ab-1111-2222-3333-444455556666";

  idleSessionWithUnreadTurns(config, waiting);
  idleSessionWithUnreadTurns(config, quarantined);
  writeTranscript(config, busy, [{ role: "user", text: "still going" }]);
  const state = createStateStore(config);
  state.recordFailure(quarantined, "first");
  state.recordFailure(quarantined, "second");
  state.recordFailure(quarantined, "third");

  const report = createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.equal(rowValue(report, "sessions waiting"), "1");
  assert.equal(rowValue(report, "given up on"), "1");
});

test("the extractor's own transcripts are not sessions waiting for extraction", () => {
  const config = tempCorpus();
  idleFor(
    writeTranscript(config, "4a3a87fa-1111-2222-3333-444455556666", [
      { role: "user", text: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
      { role: "assistant", text: '{"skip": true}' },
    ]),
    SESSION_IS_IDLE_AFTER_MS + A_MINUTE
  );

  const report = createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.equal(rowValue(report, "sessions waiting"), "0");
});

test("extraction figures come from the recorded state", () => {
  const config = tempCorpus();
  const session = "316972f2-1111-2222-3333-444455556666";
  const state = createStateStore(config);
  state.recordExtraction(session, { offset: 12 });
  state.recordFailure("4a3a87fa-1111-2222-3333-444455556666", "flaked");

  const report = createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.equal(report.verdict.label, "healthy");
  assert.equal(rowValue(report, "sessions extracted"), "1");
  assert.equal(rowValue(report, "retrying after failure"), "1 session (1 attempt)");
  assert.notEqual(rowValue(report, "last extraction"), "never");
});

test("the staleness threshold reaches the verdict through the gathering seam", () => {
  const config = tempCorpus();
  idleSessionWithUnreadTurns(config, "316972f2-1111-2222-3333-444455556666");
  createStateStore(config).recordExtraction("4a3a87fa-1111-2222-3333-444455556666");

  const patient = createStatusReport(config, { timeZone: NEW_YORK }).read();
  const impatient = createStatusReport(config, { timeZone: NEW_YORK, staleAfterMs: 1 }).read();

  assert.equal(patient.verdict.label, "healthy");
  assert.equal(impatient.verdict.label, "1 problem");
  assert.match(impatient.verdict.problems[0], /1 session waiting$/);
});

test("reading the status refreshes the index", () => {
  const config = tempCorpus();

  createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.ok(existsSync(config.indexPath));
});

// --- The corpus block ---

test("the corpus block counts topics, facts, prompts and sessions", () => {
  const report = summarizeStatus({ ...extractionReadings(), ...corpusReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.equal(corpusRow(report, "topics").value, "59");
  assert.equal(corpusRow(report, "facts").value, "3,101");
  assert.equal(corpusRow(report, "prompts").value, "4,882");
  assert.equal(corpusRow(report, "sessions").value, "229");
});

test("the facts-per-topic spread is a row of its own, and the largest topic another", () => {
  const report = summarizeStatus({ ...extractionReadings(), ...corpusReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.deepEqual(corpusRow(report, "facts per topic").values, ["min 4", "median 31", "max 587"]);
  assert.equal(corpusRow(report, "largest topic").value, "appsync_key_secrets_manager");
});

test("fact growth is reported over both windows, and the index size and refresh beside it", () => {
  const report = summarizeStatus({ ...extractionReadings(), ...corpusReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.deepEqual(corpusRow(report, "facts added").values, ["7d 585", "30d 1,204"]);
  assert.deepEqual(corpusRow(report, "index.db").values, ["5.0 MB", "refresh took 61 ms"]);
});

test("nothing in the corpus block reaches the verdict, however lopsided it reads", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    {
      ...extractionReadings({ processed: { count: 4, lastAt: now - A_MINUTE } }),
      ...corpusReadings({
        factsPerTopic: { min: 1, median: 2, max: 90_000, largest: "junk_drawer" },
        added: [
          { days: 7, facts: 0 },
          { days: 30, facts: 0 },
        ],
        bytes: 4 * 1024 * 1024 * 1024,
      }),
    },
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("an empty corpus renders the block with zeros rather than failing", () => {
  const config = tempCorpus();

  const report = createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.equal(corpusRow(report, "topics").value, "0");
  assert.equal(corpusRow(report, "facts").value, "0");
  assert.equal(corpusRow(report, "prompts").value, "0");
  assert.equal(corpusRow(report, "sessions").value, "0");
  assert.deepEqual(corpusRow(report, "facts per topic").values, ["min 0", "median 0", "max 0"]);
  assert.equal(corpusRow(report, "largest topic").value, "none");
  assert.deepEqual(corpusRow(report, "facts added").values, ["7d 0", "30d 0"]);
  assert.match(corpusRow(report, "index.db").values[0], /^[\d.]+ MB$/);
  assert.match(corpusRow(report, "index.db").values[1], /^refresh took \d+ ms$/);
});

// --- Index statistics over a fixture corpus ---

test("index statistics count what the fixture corpus holds", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", { Context: factsDated(["2026-08-01", "2026-08-02"]) });
  writeTopic(config, "appsync_keys", { Decisions: factsDated(["2026-08-03"]) });
  appendPrompts(config, [{ display: "one" }, { display: "two" }]);
  appendSessions(config, [{ session_id: "316972f2-1111-2222-3333-444455556666" }]);

  const report = statusOver(config);

  assert.equal(corpusRow(report, "topics").value, "2");
  assert.equal(corpusRow(report, "facts").value, "3");
  assert.equal(corpusRow(report, "prompts").value, "2");
  assert.equal(corpusRow(report, "sessions").value, "1");
});

test("the spread over a fixture corpus names the largest topic", () => {
  const config = tempCorpus();
  writeTopic(config, "small", { Context: factsDated(["2026-08-01"]) });
  writeTopic(config, "middling", { Context: factsDated(["2026-08-01", "2026-08-02"]) });
  writeTopic(config, "junk_drawer", {
    Context: factsDated(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]),
  });

  const report = statusOver(config);

  assert.deepEqual(corpusRow(report, "facts per topic").values, ["min 1", "median 2", "max 4"]);
  assert.equal(corpusRow(report, "largest topic").value, "junk_drawer");
});

test("a topic that parsed no facts is counted in the minimum rather than skipped", () => {
  const config = tempCorpus();
  writeTopic(config, "empty", {});
  writeTopic(config, "populated", { Context: factsDated(["2026-08-01", "2026-08-02"]) });

  const report = statusOver(config);

  assert.deepEqual(corpusRow(report, "facts per topic").values, ["min 0", "median 0", "max 2"]);
  assert.equal(corpusRow(report, "largest topic").value, "populated");
});

test("an even number of topics reports a median some topic really has", () => {
  const config = tempCorpus();
  writeTopic(config, "one", { Context: factsDated(["2026-08-01"]) });
  writeTopic(config, "four", {
    Context: factsDated(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]),
  });

  const report = statusOver(config);

  assert.equal(corpusRow(report, "facts per topic").values[1], "median 1");
});

test("facts added are bucketed by fact date against the injected clock", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  writeTopic(config, "growth", {
    Context: factsDated([
      localDay(now, 0),
      localDay(now, 3),
      localDay(now, 6),
      localDay(now, 9),
      localDay(now, 29),
      localDay(now, 40),
    ]),
  });

  const report = statusOver(config, { at: now });

  assert.deepEqual(corpusRow(report, "facts added").values, ["7d 3", "30d 5"]);
});

test("a window counts back in local dates, so it does not drift an hour over DST", () => {
  const justAfterLocalMidnightAfterSpringForward = Date.parse("2026-03-10T04:30:00Z");
  const config = tempCorpus();
  writeTopic(config, "growth", { Context: factsDated(["2026-03-03", "2026-03-04"]) });

  const report = statusOver(config, { at: justAfterLocalMidnightAfterSpringForward });

  assert.deepEqual(corpusRow(report, "facts added").values, ["7d 1", "30d 2"]);
});

test("an undated fact counts towards the total but towards no growth window", () => {
  const config = tempCorpus();
  writeTopic(config, "undated", { Context: ["- a fact with no date at all"] });

  const report = statusOver(config);

  assert.equal(corpusRow(report, "facts").value, "1");
  assert.deepEqual(corpusRow(report, "facts added").values, ["7d 0", "30d 0"]);
});

test("counts past a thousand are separated wherever the block reports them", () => {
  const report = summarizeStatus(
    {
      ...extractionReadings(),
      ...corpusReadings({
        factsPerTopic: { min: 1_000, median: 2_000, max: 90_000, largest: "junk_drawer" },
        added: [
          { days: 7, facts: 5_000 },
          { days: 30, facts: 12_000 },
        ],
      }),
    },
    { now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK }
  );

  assert.deepEqual(corpusRow(report, "facts per topic").values, [
    "min 1,000",
    "median 2,000",
    "max 90,000",
  ]);
  assert.deepEqual(corpusRow(report, "facts added").values, ["7d 5,000", "30d 12,000"]);
});

// --- The search block ---

function searchRow(report, label) {
  const row = searchBlockOf(report).rows.find((candidate) => candidate.label === label);
  assert.ok(row, `the SEARCH block should carry a "${label}" row`);
  return row;
}

function searchBlockOf(report) {
  const block = report.blocks.find((candidate) => candidate.title === "SEARCH");
  assert.ok(block, "the report should carry a SEARCH block");
  return block;
}

function searchColumns(report) {
  return searchBlockOf(report).columns;
}

function appendSearches(config, entries) {
  mkdirSync(config.corpusDir, { recursive: true });
  appendFileSync(
    config.searchLogPath,
    entries.map((entry) => `${typeof entry === "string" ? entry : JSON.stringify(entry)}\n`).join("")
  );
}

function searched({ at, source = "explicit", rows = 3, ...rest }) {
  return { ts: new Date(at).toISOString(), query: "broadcast variants", rows, source, ...rest };
}

test("the search block counts each source over seven days, thirty days and all time", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const summary = summarizeSearchLog(
    [
      searched({ at: now }),
      searched({ at: now - A_DAY, source: "automatic" }),
      searched({ at: now - 20 * A_DAY, source: "smoke" }),
      searched({ at: now - 100 * A_DAY, source: "explicit" }),
    ],
    { at: now, timeZone: NEW_YORK }
  );
  const report = summarizeStatus({ ...extractionReadings(), search: summary }, { now: () => now });

  assert.deepEqual(searchColumns(report), ["7d", "30d", "all-time"]);
  assert.deepEqual(searchRow(report, "Claude searched").values, ["1", "1", "1"]);
  assert.deepEqual(searchRow(report, "you searched").values, ["1", "1", "2"]);
  assert.deepEqual(searchRow(report, "self-tests").values, ["0", "1", "1"]);
});

test("every source the read path can write has a label on the report", () => {
  const labelled = summarizeStatus({ ...extractionReadings() }, { now: () => Date.now() });

  assert.deepEqual(
    SOURCES.filter((source) => !SEARCH_ROW_LABELS[source]),
    []
  );
  assert.deepEqual(
    searchBlockOf(labelled).rows.filter((row) => !row.label),
    []
  );
});

test("the search block names who decided to search, one row each, folded into no total", () => {
  const report = summarizeStatus({ ...extractionReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });
  const labels = report.blocks.find((block) => block.title === "SEARCH").rows.map((r) => r.label);

  assert.deepEqual(labels, [
    "Claude searched",
    "you searched",
    "self-tests",
    "found nothing",
    "bad syntax, retried",
  ]);
});

test("searches that returned nothing and queries that fell back are counted", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const summary = summarizeSearchLog(
    [
      searched({ at: now, rows: 0 }),
      searched({ at: now, rows: 0, fellBackFrom: "broadcast AND" }),
      searched({ at: now, rows: 4, fellBackFrom: "broadcast NEAR" }),
    ],
    { at: now, timeZone: NEW_YORK }
  );
  const report = summarizeStatus({ ...extractionReadings(), search: summary }, { now: () => now });

  assert.deepEqual(searchRow(report, "found nothing").values, ["2", "2", "2"]);
  assert.deepEqual(searchRow(report, "bad syntax, retried").values, ["2", "2", "2"]);
});

test("a deliberately widened search is not reported as a signal about health", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const summary = summarizeSearchLog([searched({ at: now, allProjects: true })], {
    at: now,
    timeZone: NEW_YORK,
  });
  const report = summarizeStatus({ ...extractionReadings(), search: summary }, { now: () => now });
  const labels = report.blocks.find((block) => block.title === "SEARCH").rows.map((r) => r.label);

  assert.deepEqual(labels.filter((label) => /project/i.test(label)), []);
});

test("an entry late in the local evening lands in the local day, not the UTC one", () => {
  // 2026-08-27T02:30:00Z is still the 26th in New York, so a window opening on the 27th
  // must exclude it. Bucketing on the UTC date would count it.
  const summary = summarizeSearchLog([searched({ at: Date.parse("2026-08-27T02:30:00Z") })], {
    at: Date.parse("2026-09-02T15:00:00Z"),
    timeZone: NEW_YORK,
  });

  assert.deepEqual(summary.tallies.find((t) => t.key === "explicit").counts, [0, 1, 1]);
});

test("a search window counts back in local dates across a daylight-saving boundary", () => {
  const justAfterLocalMidnightAfterSpringForward = Date.parse("2026-03-10T04:30:00Z");
  const summary = summarizeSearchLog(
    [
      searched({ at: Date.parse("2026-03-04T18:00:00Z") }),
      searched({ at: Date.parse("2026-03-03T18:00:00Z") }),
    ],
    { at: justAfterLocalMidnightAfterSpringForward, timeZone: NEW_YORK }
  );

  assert.deepEqual(summary.tallies.find((t) => t.key === "explicit").counts, [1, 2, 2]);
});

test("a malformed line in the search log is skipped rather than breaking the report", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendSearches(config, [
    searched({ at: now }),
    "{not json at all",
    "[]",
    searched({ at: now, source: "automatic" }),
  ]);

  const report = statusOver(config, { at: now });

  assert.deepEqual(searchRow(report, "you searched").values, ["1", "1", "1"]);
  assert.deepEqual(searchRow(report, "Claude searched").values, ["1", "1", "1"]);
});

test("an entry with an unreadable timestamp counts all-time but in no window", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const summary = summarizeSearchLog([{ ts: "not a date", rows: 3, source: "explicit" }], {
    at: now,
    timeZone: NEW_YORK,
  });

  assert.deepEqual(summary.tallies.find((t) => t.key === "explicit").counts, [0, 0, 1]);
});

test("an absent search log renders the block with zeros rather than failing", () => {
  const config = tempCorpus();

  const report = statusOver(config);

  assert.deepEqual(searchRow(report, "Claude searched").values, ["0", "0", "0"]);
  assert.deepEqual(searchRow(report, "found nothing").values, ["0", "0", "0"]);
});

test("nothing in the search block reaches the verdict, however rarely the read path fires", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const summary = summarizeSearchLog(
    [
      ...Array.from({ length: 50 }, () => searched({ at: now, rows: 0 })),
      searched({ at: now, source: "automatic", rows: 0 }),
    ],
    { at: now, timeZone: NEW_YORK }
  );
  const report = summarizeStatus(
    {
      ...extractionReadings({ processed: { count: 4, lastAt: now - A_MINUTE } }),
      search: summary,
    },
    { now: () => now }
  );

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("reading the status leaves the search log exactly as the read path wrote it", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", { Context: factsDated(["2026-08-01"]) });
  writeSmokeQueries(config, [{ query: "something", mode: "facts" }]);
  appendSearches(config, [searched({ at: now })]);
  const before = readFileSync(config.searchLogPath, "utf-8");

  runCli(STATUS_REPORT, { config });

  assert.equal(readFileSync(config.searchLogPath, "utf-8"), before);
});

test("toc-status prints the search block as a table with a header row per window", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendSearches(config, [
    searched({ at: now, source: "automatic" }),
    searched({ at: now }),
    searched({ at: now, source: "smoke", rows: 0 }),
  ]);

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^┌─ SEARCH ─+┬.+┐$/m);
  assert.match(report.stdout, /^│ +│ +7d │ +30d │ +all-time │$/m);
  assert.match(report.stdout, /^│ Claude searched +│ +1 │ +1 │ +1 │$/m);
  assert.match(report.stdout, /^│ found nothing +│ +1 │ +1 │ +1 │$/m);
  assert.match(report.stdout, /^│ bad syntax, retried +│ +0 │ +0 │ +0 │$/m);
});

// --- Smoke queries ---

// Smoke is not a row on the report: it runs live on every invocation and speaks only
// through the verdict, where a corpus that can no longer answer its own known-good queries
// is blockage rather than a count.

function smokeReadings(overrides = {}) {
  return { smoke: { configured: 6, failed: 0, ...overrides } };
}


function summarizeWithSmoke(smoke) {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  return summarizeStatus({ ...extractionReadings(EXTRACTED_ONCE), ...smoke }, { now: () => now });
}

test("a passing smoke run is healthy and takes no row of its own on the report", () => {
  const report = summarizeWithSmoke(smokeReadings());

  assert.equal(report.verdict.label, "healthy");
  assert.doesNotMatch(renderStatus(report), /passed \(6 of 6\)/);
});

test("failing smoke queries are a problem naming how many of how many failed", () => {
  const report = summarizeWithSmoke(smokeReadings({ failed: 2 }));

  assert.equal(report.verdict.label, "1 problem");
  assert.deepEqual(report.verdict.problems, ["smoke queries FAILED (2 of 6)"]);
});

test("a corpus with no smoke queries configured has nothing to fail and is not a problem", () => {
  const report = summarizeWithSmoke(smokeReadings({ configured: 0 }));

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("a corpus that has recorded nothing does not report its own emptiness as smoke failure", () => {
  const report = summarizeStatus(
    { ...extractionReadings(), ...smokeReadings({ configured: 6, failed: 6 }) },
    { now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK }
  );

  assert.equal(report.verdict.label, "never run");
  assert.deepEqual(report.verdict.problems, []);
});

test("status runs the corpus's smoke queries against the corpus it is reporting on", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", { Context: factsDated(["2026-08-01"]) });
  writeSmokeQueries(config, [
    { query: "something", mode: "facts", expectTopic: "broadcast_variants" },
    { query: "kinesis", mode: "facts" },
  ]);
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");

  const report = statusOver(config);

  assert.deepEqual(report.verdict.problems, ["smoke queries FAILED (1 of 2)"]);
});

test("the smoke counts the report prints are not inflated by the report's own run", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", { Context: factsDated(["2026-08-01"]) });
  writeSmokeQueries(config, [{ query: "something", mode: "facts" }]);

  const report = statusOver(config);

  assert.deepEqual(searchRow(report, "self-tests").values, ["0", "0", "0"]);
  assert.equal(existsSync(config.searchLogPath), false);
});

test("a smoke query the corpus can no longer answer fails the verdict and still exits 0", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", { Context: factsDated(["2026-08-01"]) });
  writeSmokeQueries(config, [
    { query: "something", mode: "facts" },
    { query: "kinesis", mode: "facts" },
  ]);
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^CLAUDE-TOC STATUS: 1 problem$/m);
  assert.match(report.stdout, /^ {2}! smoke queries FAILED \(1 of 2\)$/m);
});

// --- The spend block ---

const SONNET = "global.anthropic.claude-sonnet-5";

function spendBlock(report) {
  const block = report.blocks.find((candidate) => candidate.title === "SPEND");
  assert.ok(block, "the report should carry a SPEND block");
  return block;
}

function spendRow(report, label) {
  const row = spendBlock(report).rows.find((candidate) => candidate.label === label);
  assert.ok(row, `the SPEND block should carry a "${label}" row`);
  return row;
}

function appendCalls(config, calls) {
  mkdirSync(config.corpusDir, { recursive: true });
  appendFileSync(config.spendLogPath, calls.map((call) => `${JSON.stringify(call)}\n`).join(""));
}

function called({ localDate, model = SONNET, inputTokens = 1_000_000, outputTokens = 100_000 }) {
  return {
    ts: `${localDate}T15:00:00.000Z`,
    localDate,
    session: "316972f2",
    model,
    inputTokens,
    outputTokens,
  };
}

test("the spend block reports calls and dollars over seven days, thirty days and all time", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendCalls(config, [
    called({ localDate: localDay(now, 0) }),
    called({ localDate: localDay(now, 20) }),
    called({ localDate: localDay(now, 100) }),
  ]);

  const report = statusOver(config, { at: now });

  assert.deepEqual(spendBlock(report).columns, ["7d", "30d", "all-time"]);
  assert.deepEqual(spendRow(report, "model calls").values, ["1", "2", "3"]);
  assert.deepEqual(spendRow(report, "estimated cost").values, ["$4.50", "$9.00", "$13.50"]);
});

test("the spend block is the last block on the report", () => {
  const report = statusOver(tempCorpus());

  assert.deepEqual(
    report.blocks.map((block) => block.title),
    ["EXTRACTION", "CORPUS", "SEARCH", "SPEND"]
  );
});

test("calls whose model has no rate are counted per window and left out of the dollars", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendCalls(config, [
    called({ localDate: localDay(now, 0), model: "some.unlisted.model" }),
    called({ localDate: localDay(now, 100), model: "some.unlisted.model" }),
    called({ localDate: localDay(now, 0) }),
  ]);

  const report = statusOver(config, { at: now });

  assert.deepEqual(spendRow(report, "calls with no rate").values, ["1", "1", "2"]);
  assert.deepEqual(spendRow(report, "model calls").values, ["2", "2", "3"]);
  assert.deepEqual(spendRow(report, "estimated cost").values, ["$4.50", "$4.50", "$4.50"]);
});

test("a call made late in the local evening falls in the local day it was recorded on", () => {
  const config = tempCorpus();
  createSpendLog(config, {
    timeZone: NEW_YORK,
    now: () => LATE_ON_26_AUGUST_IN_NEW_YORK,
  }).record({ model: SONNET, inputTokens: 1_000_000, outputTokens: 100_000 });

  // The seven-day window opens on 2026-08-27, and the call was made on the 26th in New
  // York even though its timestamp is already the 27th in UTC.
  const report = statusOver(config, { at: Date.parse("2026-09-02T15:00:00Z") });

  assert.deepEqual(spendRow(report, "model calls").values, ["0", "1", "1"]);
});

test("a spend window counts back in local dates across a daylight-saving boundary", () => {
  const justAfterLocalMidnightAfterSpringForward = Date.parse("2026-03-10T04:30:00Z");
  const config = tempCorpus();
  appendCalls(config, [
    called({ localDate: "2026-03-04" }),
    called({ localDate: "2026-03-03" }),
  ]);

  const report = statusOver(config, { at: justAfterLocalMidnightAfterSpringForward });

  assert.deepEqual(spendRow(report, "model calls").values, ["1", "2", "2"]);
});

test("a call with no local date on it falls in no window but still counts all-time", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendCalls(config, [{ model: SONNET, inputTokens: 1_000_000, outputTokens: 100_000 }]);

  const report = statusOver(config, { at: now });

  assert.deepEqual(spendRow(report, "model calls").values, ["0", "0", "1"]);
});

test("a malformed line in the spend log is skipped rather than breaking the report", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  mkdirSync(config.corpusDir, { recursive: true });
  appendFileSync(
    config.spendLogPath,
    `${JSON.stringify(called({ localDate: localDay(now, 0) }))}\n{ not json\n`
  );

  const report = statusOver(config, { at: now });

  assert.deepEqual(spendRow(report, "model calls").values, ["1", "1", "1"]);
});

test("an amount too small for cents is reported the way the spend report reports it", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendCalls(config, [
    called({ localDate: localDay(now, 0), inputTokens: 1_000, outputTokens: 0 }),
  ]);

  const report = statusOver(config, { at: now });

  assert.deepEqual(spendRow(report, "estimated cost").values, ["$0.0030", "$0.0030", "$0.0030"]);
});

test("an absent spend log renders the block with zeros rather than failing", () => {
  const config = tempCorpus();

  const report = statusOver(config);

  assert.deepEqual(spendRow(report, "model calls").values, ["0", "0", "0"]);
  assert.deepEqual(spendRow(report, "estimated cost").values, ["$0.00", "$0.00", "$0.00"]);
  assert.deepEqual(spendRow(report, "calls with no rate").values, ["0", "0", "0"]);
});

test("the spend block names the bill it lands on and where to override the rates", () => {
  const config = tempCorpus();

  const block = spendBlock(statusOver(config));

  assert.deepEqual(block.footer, [
    "Billed to the AWS profile claudecode in us-west-2.",
    `Rates are list prices; edit ${config.modelRatesPath} to match your bill.`,
  ]);
});

test("nothing in the spend block reaches the verdict, however much went unpriced", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");
  appendCalls(
    config,
    Array.from({ length: 20 }, () =>
      called({ localDate: localDay(now, 0), model: "some.unlisted.model" })
    )
  );

  const report = statusOver(config, { at: now });

  assert.equal(report.verdict.label, "healthy");
  assert.deepEqual(report.verdict.problems, []);
});

test("a dollar amount is printed in full and right-aligned against its column's edge", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendCalls(config, [
    called({ localDate: localDay(now, 0), inputTokens: 400_000_000, outputTokens: 0 }),
  ]);

  const rendered = renderStatus(statusOver(config, { at: now }));

  assert.match(rendered, /^│ estimated cost +│( +\$1200\.00 │){3}$/m);
});

test("toc-status prints the spend block in the same columns as the search block", () => {
  const config = tempCorpus();
  createSpendLog(config).record({
    model: SONNET,
    sessionId: "316972f2",
    inputTokens: 1_000_000,
    outputTokens: 100_000,
  });

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^┌─ SPEND ─+┬.+┐$/m);
  assert.match(report.stdout, /^│ model calls +│ +1 │ +1 │ +1 │$/m);
  assert.match(report.stdout, /^│ estimated cost +│( +\$4\.50 │){3}$/m);
  assert.match(report.stdout, /^│ calls with no rate +│ +0 │ +0 │ +0 │$/m);
  assert.match(report.stdout, /^Billed to the AWS profile claudecode in us-west-2\.$/m);
  assert.match(report.stdout, /^Rates are list prices; edit \S+model-rates\.json to match your bill\.$/m);
});

