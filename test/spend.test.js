import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { createSpendLog, estimatedCost, summarizeSpend } from "../src/spend.js";
import {
  runCli,
  tempCorpus,
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  LATE_ON_26_AUGUST_IN_NEW_YORK,
  SPEND_REPORT,
} from "./support/corpus.js";

const SONNET = "global.anthropic.claude-sonnet-5";
const OPUS = "global.anthropic.claude-opus-5";
const NEW_YORK = "America/New_York";

function callOf(overrides = {}) {
  return {
    localDate: "2026-08-31",
    session: "316972f2",
    model: SONNET,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    ...overrides,
  };
}

test("a million input tokens of sonnet costs its list rate", () => {
  const cost = estimatedCost(callOf({ outputTokens: 0 }), { [SONNET]: { input: 3, output: 15 } });

  assert.equal(cost, 3);
});

test("a model with no known rate is counted in tokens but not in dollars", () => {
  const summary = summarizeSpend([callOf({ model: "some.unlisted.model" })], {});

  assert.equal(summary.total.cost, 0);
  assert.equal(summary.total.unpriced, 1);
  assert.equal(summary.total.inputTokens, 1_000_000);
});

test("spend is grouped by day, model, and session", () => {
  const summary = summarizeSpend(
    [
      callOf(),
      callOf({ localDate: "2026-08-30", session: "4a3a87fa", model: OPUS }),
      callOf({ localDate: "2026-08-30", session: "4a3a87fa" }),
    ],
    { [SONNET]: { input: 3, output: 15 }, [OPUS]: { input: 15, output: 75 } }
  );

  assert.equal(summary.total.calls, 3);
  assert.deepEqual(
    summary.byDay.map((day) => day.key),
    ["2026-08-30", "2026-08-31"]
  );
  assert.equal(summary.byDay.find((day) => day.key === "2026-08-30").calls, 2);
  assert.equal(summary.byModel.find((model) => model.key === OPUS).cost, 22.5);
  assert.deepEqual(
    summary.bySession.map((session) => session.key),
    ["4a3a87fa", "316972f2"]
  );
});

test("a recorded call is bucketed by the local date it was made on", () => {
  const config = tempCorpus();
  const spend = createSpendLog(config, {
    timeZone: NEW_YORK,
    now: () => LATE_ON_26_AUGUST_IN_NEW_YORK,
  });

  spend.record({ model: SONNET, sessionId: "316972f2", inputTokens: 10, outputTokens: 2 });

  assert.equal(spend.calls()[0].localDate, "2026-08-26");
});

test("rates from the corpus override the list prices", () => {
  const config = tempCorpus();
  writeFileSync(config.modelRatesPath, JSON.stringify({ [SONNET]: { input: 30, output: 150 } }));
  const spend = createSpendLog(config, { now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK });

  spend.record({ model: SONNET, inputTokens: 1_000_000, outputTokens: 0 });

  assert.equal(spend.summarize().total.cost, 30);
});

test("a malformed line in the spend log is skipped rather than breaking the report", () => {
  const config = tempCorpus();
  writeFileSync(config.spendLogPath, `${JSON.stringify(callOf())}\n{ not json\n`);
  const spend = createSpendLog(config);

  assert.equal(spend.summarize().total.calls, 1);
});

test("toc-spend reports nothing spent before any call, and totals after", () => {
  const config = tempCorpus();

  const quiet = runCli(SPEND_REPORT, { config });
  assert.equal(quiet.status, 0);
  assert.match(quiet.stdout, /No model calls recorded yet/);

  createSpendLog(config).record({
    model: SONNET,
    sessionId: "316972f2",
    inputTokens: 1_000_000,
    outputTokens: 100_000,
  });

  const report = runCli(SPEND_REPORT, { config });
  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /1 model call\(s\)/);
  assert.match(report.stdout, /\$4\.50/);
  assert.match(report.stdout, /claudecode/);
  assert.match(report.stdout, /316972f2/);
});
