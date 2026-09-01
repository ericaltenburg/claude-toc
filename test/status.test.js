import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { createStatusReport, summarizeStatus } from "../src/status.js";
import { createStateStore } from "../src/state.js";
import { EXTRACTION_PROMPT_MARKER, SESSION_IS_IDLE_AFTER_MS } from "../src/sweep.js";
import {
  idleFor,
  runCli,
  tempCorpus,
  writeTranscript,
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  STATUS_REPORT,
} from "./support/corpus.js";

const NEW_YORK = "America/New_York";
const A_MINUTE = 60_000;
const AN_HOUR = 60 * A_MINUTE;

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

test("reading the status refreshes the index", () => {
  const config = tempCorpus();

  createStatusReport(config, { timeZone: NEW_YORK }).read();

  assert.ok(existsSync(config.indexPath));
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
