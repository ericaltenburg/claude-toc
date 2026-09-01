import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import {
  createStatusReport,
  renderStatus,
  summarizeSearchLog,
  summarizeStatus,
  EXTRACTION_IS_STALE_AFTER_MS,
} from "../src/status.js";
import { createStateStore, EXTRACTION_LEASE_MS } from "../src/state.js";
import { EXTRACTION_PROMPT_MARKER, SESSION_IS_IDLE_AFTER_MS } from "../src/sweep.js";
import {
  appendPrompts,
  appendSessions,
  idleFor,
  runCli,
  tempCorpus,
  writeTopic,
  writeTranscript,
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  STATUS_REPORT,
} from "./support/corpus.js";

const NEW_YORK = "America/New_York";
const A_MINUTE = 60_000;
const AN_HOUR = 60 * A_MINUTE;
const A_DAY = 24 * AN_HOUR;

function extractionReadings(overrides = {}) {
  return {
    extraction: {
      processed: { count: 0, lastAt: null },
      waiting: 0,
      sweptAt: null,
      lease: null,
      failures: { sessions: 0, attempts: 0 },
      quarantined: 0,
      ...overrides,
    },
  };
}

function leaseExpired(now, expiredAgo) {
  return {
    holder: "sweep-316972f2",
    startedAt: now - expiredAgo - EXTRACTION_LEASE_MS,
    expiresAt: now - expiredAgo,
  };
}

function leaseLive(now) {
  return { holder: "sweep-316972f2", startedAt: now, expiresAt: now + EXTRACTION_LEASE_MS };
}

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

function corpusReadings(overrides = {}) {
  return {
    corpus: {
      topics: 59,
      facts: 3101,
      prompts: 4882,
      sessions: 229,
      factsPerTopic: { min: 4, median: 31, max: 587, largest: "appsync_key_secrets_manager" },
      added: [
        { days: 7, facts: 585 },
        { days: 30, facts: 1204 },
      ],
      refreshMs: 61,
      bytes: 5 * 1024 * 1024,
      ...overrides,
    },
  };
}

function factsDated(dates) {
  return dates.map((date) => `- something happened [session:316972f2, ${date}]`);
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
  assert.equal(rowValue(report, "processed"), "173 sessions");
});

test("a queue with nothing recorded behind it still reads as never run", () => {
  const report = summarizeStatus(extractionReadings({ waiting: 4 }), { now: () => Date.now() });

  assert.equal(report.verdict.label, "never run");
  assert.equal(rowValue(report, "sessions waiting"), "4");
});

test("the sweep timestamp is a separate row and is labelled as a heartbeat", () => {
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
  assert.ok(labels.includes("hook heartbeat"));
  assert.equal(rowValue(report, "hook heartbeat"), "2026-08-27 10:56  (4m ago)");
});

test("nothing extracted and nothing swept read as never rather than as a date", () => {
  const report = summarizeStatus(extractionReadings({ quarantined: 1 }), {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.equal(rowValue(report, "last extraction"), "never");
  assert.equal(rowValue(report, "hook heartbeat"), "never");
});

test("an unheld lease reads as free, and a held one names its holder and age", () => {
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

  assert.equal(rowValue(free, "lease"), "free");
  assert.equal(rowValue(held, "lease"), "held by sweep-316972f2 (2m)");
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

  assert.equal(rowValue(report, "failures"), "1 (1 attempt, short of quarantine)");
  assert.equal(rowValue(report, "quarantined"), "2");
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

  assert.equal(rowValue(report, "failures"), "2 (4 attempts between them, short of quarantine)");
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

test("a frozen hook heartbeat with an empty queue is healthy", () => {
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
  assert.match(rowValue(report, "lease"), /expired/);
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
  assert.equal(rowValue(report, "quarantined"), "1");
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
  assert.equal(rowValue(report, "processed"), "1 session");
  assert.equal(rowValue(report, "failures"), "1 (1 attempt, short of quarantine)");
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

test("the facts-per-topic spread names the largest topic beside its count", () => {
  const report = summarizeStatus({ ...extractionReadings(), ...corpusReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.equal(
    corpusRow(report, "topics").note,
    "facts/topic   min 4  median 31  max 587 appsync_key_secrets_manager"
  );
});

test("fact growth is reported over both windows, and the index size and refresh beside it", () => {
  const report = summarizeStatus({ ...extractionReadings(), ...corpusReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });

  assert.equal(corpusRow(report, "facts").note, "added   7d 585   30d 1,204");
  assert.equal(corpusRow(report, "index.db").value, "5.0 MB");
  assert.equal(corpusRow(report, "index.db").note, "refresh took 61 ms");
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
  assert.equal(corpusRow(report, "topics").note, "facts/topic   min 0  median 0  max 0");
  assert.match(corpusRow(report, "facts").note, /^added {3}7d 0 {3}30d 0$/);
  assert.match(corpusRow(report, "index.db").note, /^refresh took \d+ ms$/);
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

  assert.equal(
    corpusRow(report, "topics").note,
    "facts/topic   min 1  median 2  max 4 junk_drawer"
  );
});

test("a topic that parsed no facts is counted in the minimum rather than skipped", () => {
  const config = tempCorpus();
  writeTopic(config, "empty", {});
  writeTopic(config, "populated", { Context: factsDated(["2026-08-01", "2026-08-02"]) });

  const report = statusOver(config);

  assert.equal(
    corpusRow(report, "topics").note,
    "facts/topic   min 0  median 0  max 2 populated"
  );
});

test("an even number of topics reports a median some topic really has", () => {
  const config = tempCorpus();
  writeTopic(config, "one", { Context: factsDated(["2026-08-01"]) });
  writeTopic(config, "four", {
    Context: factsDated(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]),
  });

  const report = statusOver(config);

  assert.match(corpusRow(report, "topics").note, /median 1 /);
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

  assert.equal(corpusRow(report, "facts").note, "added   7d 3   30d 5");
});

test("a window counts back in local dates, so it does not drift an hour over DST", () => {
  const justAfterLocalMidnightAfterSpringForward = Date.parse("2026-03-10T04:30:00Z");
  const config = tempCorpus();
  writeTopic(config, "growth", { Context: factsDated(["2026-03-03", "2026-03-04"]) });

  const report = statusOver(config, { at: justAfterLocalMidnightAfterSpringForward });

  assert.equal(corpusRow(report, "facts").note, "added   7d 1   30d 2");
});

test("an undated fact counts towards the total but towards no growth window", () => {
  const config = tempCorpus();
  writeTopic(config, "undated", { Context: ["- a fact with no date at all"] });

  const report = statusOver(config);

  assert.equal(corpusRow(report, "facts").value, "1");
  assert.equal(corpusRow(report, "facts").note, "added   7d 0   30d 0");
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

  assert.equal(
    corpusRow(report, "topics").note,
    "facts/topic   min 1,000  median 2,000  max 90,000 junk_drawer"
  );
  assert.equal(corpusRow(report, "facts").note, "added   7d 5,000   30d 12,000");
});

// --- The search block ---

function searchRow(report, label) {
  const block = report.blocks.find((candidate) => candidate.title === "SEARCH");
  assert.ok(block, "the report should carry a SEARCH block");
  const row = block.rows.find((candidate) => candidate.label === label);
  assert.ok(row, `the SEARCH block should carry a "${label}" row`);
  return row;
}

function searchColumns(report) {
  return report.blocks.find((candidate) => candidate.title === "SEARCH").columns;
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
  assert.deepEqual(searchRow(report, "automatic").values, ["1", "1", "1"]);
  assert.deepEqual(searchRow(report, "explicit").values, ["1", "1", "2"]);
  assert.deepEqual(searchRow(report, "smoke").values, ["0", "1", "1"]);
});

test("automatic is its own row and is never folded into a total", () => {
  const report = summarizeStatus({ ...extractionReadings() }, {
    now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  });
  const labels = report.blocks.find((block) => block.title === "SEARCH").rows.map((r) => r.label);

  assert.deepEqual(labels, ["automatic", "explicit", "smoke", "returned nothing", "syntax fallbacks"]);
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

  assert.deepEqual(searchRow(report, "returned nothing").values, ["2", "2", "2"]);
  assert.deepEqual(searchRow(report, "syntax fallbacks").values, ["2", "2", "2"]);
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

  assert.deepEqual(summary.tallies.find((t) => t.label === "explicit").counts, [0, 1, 1]);
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

  assert.deepEqual(summary.tallies.find((t) => t.label === "explicit").counts, [1, 2, 2]);
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

  assert.deepEqual(searchRow(report, "explicit").values, ["1", "1", "1"]);
  assert.deepEqual(searchRow(report, "automatic").values, ["1", "1", "1"]);
});

test("an entry with an unreadable timestamp counts all-time but in no window", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const summary = summarizeSearchLog([{ ts: "not a date", rows: 3, source: "explicit" }], {
    at: now,
    timeZone: NEW_YORK,
  });

  assert.deepEqual(summary.tallies.find((t) => t.label === "explicit").counts, [0, 0, 1]);
});

test("an absent search log renders the block with zeros rather than failing", () => {
  const config = tempCorpus();

  const report = statusOver(config);

  assert.deepEqual(searchRow(report, "automatic").values, ["0", "0", "0"]);
  assert.deepEqual(searchRow(report, "returned nothing").values, ["0", "0", "0"]);
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
  appendSearches(config, [searched({ at: now })]);
  const before = readFileSync(config.searchLogPath, "utf-8");

  runCli(STATUS_REPORT, { config });

  assert.equal(readFileSync(config.searchLogPath, "utf-8"), before);
});

test("toc-status prints the search block in aligned columns", () => {
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
  assert.match(report.stdout, /^SEARCH\s+7d\s+30d\s+all-time$/m);
  assert.match(report.stdout, /^ {2}automatic\s+1\s+1\s+1$/m);
  assert.match(report.stdout, /^ {2}returned nothing\s+1\s+1\s+1$/m);
  assert.match(report.stdout, /^ {2}syntax fallbacks\s+0\s+0\s+0$/m);
});

test("--markdown gives the search block one column per window", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const config = tempCorpus();
  appendSearches(config, [searched({ at: now, source: "automatic" })]);

  const report = runCli(STATUS_REPORT, { config, args: ["--markdown"] });

  assert.equal(report.status, 0);
  assert.match(report.stdout, /^## SEARCH$/m);
  assert.match(report.stdout, /^\| reading \| 7d \| 30d \| all-time \|$/m);
  assert.match(report.stdout, /^\| automatic \| 1 \| 1 \| 1 \|$/m);
});

// --- The command line ---

test("toc-status prints a verdict and the extraction block, and exits 0", () => {
  const config = tempCorpus();
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^claude-toc status\s+healthy$/m);
  assert.match(report.stdout, /^EXTRACTION$/m);
  assert.match(report.stdout, /last extraction\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(report.stdout, /hook heartbeat/);
  assert.match(report.stdout, /sessions waiting\s+0/);
});

test("an empty corpus reports never run on the command line and still exits 0", () => {
  const config = tempCorpus();

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.match(report.stdout, /^claude-toc status\s+never run$/m);
});

test("a blocked queue names the problem under the verdict and still exits 0", () => {
  const config = tempCorpus();
  idleSessionWithUnreadTurns(config, "316972f2-1111-2222-3333-444455556666");
  createStateStore(config).claimSweep();

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^claude-toc status\s+1 problem$/m);
  assert.match(report.stdout, /^ {2}! nothing extracted yet with 1 session waiting$/m);
});

test("--markdown lists the problems beneath the verdict heading", () => {
  const config = tempCorpus();
  idleSessionWithUnreadTurns(config, "316972f2-1111-2222-3333-444455556666");
  createStateStore(config).claimSweep();

  const report = runCli(STATUS_REPORT, { config, args: ["--markdown"] });

  assert.equal(report.status, 0);
  assert.match(report.stdout, /^# claude-toc status: 1 problem$/m);
  assert.match(report.stdout, /^- nothing extracted yet with 1 session waiting$/m);
});

test("the report carries no colour or terminal escape codes", () => {
  const config = tempCorpus();
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");

  const report = runCli(STATUS_REPORT, { config });

  assert.doesNotMatch(report.stdout, /\u001b/);
});

test("running the status command writes nothing into the search log", () => {
  const config = tempCorpus();

  runCli(STATUS_REPORT, { config });

  assert.equal(existsSync(config.searchLogPath), false);
});

test("--markdown renders the block as a table under the verdict as a heading", () => {
  const config = tempCorpus();
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");

  const report = runCli(STATUS_REPORT, { config, args: ["--markdown"] });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^# claude-toc status: healthy$/m);
  assert.match(report.stdout, /^## EXTRACTION$/m);
  assert.match(report.stdout, /^\| last extraction \| .+ \|$/m);
});

test("toc-status prints the corpus block with the largest topic named", () => {
  const config = tempCorpus();
  writeTopic(config, "small", { Context: factsDated(["2026-08-01"]) });
  writeTopic(config, "junk_drawer", { Context: factsDated(["2026-08-01", "2026-08-02"]) });

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^CORPUS$/m);
  assert.match(report.stdout, /^ {2}topics\s+2\s+facts\/topic\s+min 1\s+median 1\s+max 2 junk_drawer$/m);
  assert.match(report.stdout, /^ {2}facts\s+3\s+added\s+7d \d+\s+30d \d+$/m);
  assert.match(report.stdout, /^ {2}index\.db\s+[\d.]+ MB\s+refresh took \d+ ms$/m);
});

test("--markdown carries the corpus notes in a third column", () => {
  const config = tempCorpus();
  writeTopic(config, "junk_drawer", { Context: factsDated(["2026-08-01"]) });

  const report = runCli(STATUS_REPORT, { config, args: ["--markdown"] });

  assert.equal(report.status, 0);
  assert.match(report.stdout, /^## CORPUS$/m);
  assert.match(report.stdout, /^\| reading \| value \| note \|$/m);
  assert.match(report.stdout, /^\| topics \| 1 \| facts\/topic .*max 1 junk_drawer \|$/m);
});
