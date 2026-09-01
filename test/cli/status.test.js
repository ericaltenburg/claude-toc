import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { summarizeStatus } from "../../src/status.js";
import { renderStatus } from "../../src/cli/status.js";
import { createStateStore } from "../../src/state.js";
import { SESSION_IS_IDLE_AFTER_MS } from "../../src/sweep.js";
import {
  idleFor,
  runCli,
  tempCorpus,
  writeSmokeQueries,
  writeTopic,
  writeTranscript,
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  STATUS_REPORT,
} from "../support/corpus.js";
import {
  corpusReadings,
  extractionReadings,
  factsDated,
  leaseExpired,
  A_MINUTE,
  AN_HOUR,
  EXTRACTED_ONCE,
} from "../support/readings.js";

function idleSessionWithUnreadTurns(config, sessionId) {
  const path = writeTranscript(config, sessionId, [{ role: "user", text: "a question" }]);
  return idleFor(path, SESSION_IS_IDLE_AFTER_MS + A_MINUTE);
}

// --- Rendering ---

function renderedBlocks(report) {
  return renderStatus(report)
    .split("\n")
    .filter((line) => /^[┌├└│]/.test(line));
}

const lengthsOf = (lines) => new Set(lines.map((line) => line.length));

function wholeReport(overrides = {}) {
  return summarizeStatus(
    { ...extractionReadings(EXTRACTED_ONCE), ...corpusReadings(), ...overrides },
    { now: () => AFTERNOON_ON_27_AUGUST_IN_NEW_YORK }
  );
}

test("every line of every table is exactly as long as every other", () => {
  assert.deepEqual(lengthsOf(renderedBlocks(wholeReport())).size, 1);
});

test("a reading wider than any other widens all four tables and is printed in full", () => {
  const aTopicThatGrewAndGrew = "an_appsync_key_secrets_manager_migration_topic_that_grew_and_grew";
  const widened = wholeReport({
    corpus: {
      ...corpusReadings().corpus,
      factsPerTopic: { min: 4, median: 31, max: 587, largest: aTopicThatGrewAndGrew },
    },
  });

  const narrowLines = renderedBlocks(wholeReport());
  const widenedLines = renderedBlocks(widened);

  assert.ok(widenedLines[0].length > narrowLines[0].length);
  assert.deepEqual(lengthsOf(widenedLines).size, 1);
  assert.match(renderStatus(widened), new RegExp(aTopicThatGrewAndGrew));
});

test("each block carries its title in its top border, where no row can be read as one", () => {
  const rendered = renderStatus(wholeReport());

  for (const title of ["EXTRACTION", "CORPUS", "SEARCH", "SPEND"]) {
    assert.match(rendered, new RegExp(`^┌─ ${title} ─+[┬─].+┐$`, "m"));
  }
});

test("a windowed block heads its columns with an empty title cell beside the window names", () => {
  const rendered = renderStatus(wholeReport());

  assert.equal(rendered.match(/^│ +│ +7d │ +30d │ +all-time │$/gm).length, 2);
});

// --- The command line ---

test("toc-status prints a verdict and the extraction block, and exits 0", () => {
  const config = tempCorpus();
  createStateStore(config).recordExtraction("316972f2-1111-2222-3333-444455556666");

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^CLAUDE-TOC STATUS: healthy$/m);
  assert.match(report.stdout, /^┌─ EXTRACTION ─+/m);
  assert.match(report.stdout, /│ last extraction +│ \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(report.stdout, /│ last checked for work +│/);
  assert.match(report.stdout, /│ sessions waiting +│ 0 +│/);
});

test("an empty corpus reports never run on the command line and still exits 0", () => {
  const config = tempCorpus();

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.match(report.stdout, /^CLAUDE-TOC STATUS: never run$/m);
});

test("a blocked queue names the problem under the verdict as prose and still exits 0", () => {
  const config = tempCorpus();
  idleSessionWithUnreadTurns(config, "316972f2-1111-2222-3333-444455556666");
  createStateStore(config).claimSweep();

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^CLAUDE-TOC STATUS: 1 problem$/m);
  assert.match(report.stdout, /^ {2}! nothing extracted yet with 1 session waiting$/m);
});

test("two problems on the command line are counted in the plural and still exit 0", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", { Context: factsDated(["2026-08-01"]) });
  writeSmokeQueries(config, [
    { query: "something", mode: "facts" },
    { query: "kinesis", mode: "facts" },
  ]);
  idleSessionWithUnreadTurns(config, "316972f2-1111-2222-3333-444455556666");
  createStateStore(config).claimSweep();

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^CLAUDE-TOC STATUS: 2 problems$/m);
});

test("each problem is named on its own prose line above the tables", () => {
  const now = AFTERNOON_ON_27_AUGUST_IN_NEW_YORK;
  const report = summarizeStatus(
    extractionReadings({
      processed: { count: 4, lastAt: now - 31 * AN_HOUR },
      waiting: 2,
      lease: leaseExpired(now, 2 * AN_HOUR),
    }),
    { now: () => now }
  );

  assert.deepEqual(renderStatus(report).split("\n").slice(0, 3), [
    "CLAUDE-TOC STATUS: 2 problems",
    "  ! no extraction in 31h with 2 sessions waiting",
    "  ! lease held by sweep-316972f2 expired 2h ago with no extraction since",
  ]);
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

test("there is one rendering, so an argument asking for another is rejected", () => {
  const config = tempCorpus();

  const report = runCli(STATUS_REPORT, { config, args: ["--markdown"] });

  assert.equal(report.status, 2);
  assert.equal(report.stdout, "");
  assert.match(report.stderr, /unexpected argument --markdown/);
});

test("toc-status prints the corpus block with the largest topic on a row of its own", () => {
  const config = tempCorpus();
  writeTopic(config, "small", { Context: factsDated(["2026-08-01"]) });
  writeTopic(config, "junk_drawer", { Context: factsDated(["2026-08-01", "2026-08-02"]) });

  const report = runCli(STATUS_REPORT, { config });

  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.match(report.stdout, /^┌─ CORPUS ─+/m);
  assert.match(report.stdout, /^│ topics +│ 2 +│$/m);
  assert.match(report.stdout, /^│ largest topic +│ junk_drawer +│$/m);
});

test("a reading made of several readings gets a cell each, divided by a wall", () => {
  const config = tempCorpus();
  writeTopic(config, "small", { Context: factsDated(["2026-08-01"]) });
  writeTopic(config, "junk_drawer", { Context: factsDated(["2026-08-01", "2026-08-02"]) });

  const report = runCli(STATUS_REPORT, { config });

  assert.match(report.stdout, /^│ facts per topic +│ min 1 +│ median 1 +│ max 2 +│$/m);
  assert.match(report.stdout, /^│ facts added +│ 7d \d+ +│ 30d \d+ +│$/m);
  assert.match(report.stdout, /^│ index\.db +│ [\d.]+ MB +│ refresh took \d+ ms +│$/m);
});

test("the rule between rows that divide differently opens and closes each wall", () => {
  const config = tempCorpus();
  writeTopic(config, "junk_drawer", { Context: factsDated(["2026-08-01"]) });

  const report = runCli(STATUS_REPORT, { config });
  const lines = report.stdout.split("\n");
  const dividedRow = lines.findIndex((line) => line.startsWith("│ facts per topic"));

  // The rule above a three-cell row opens two walls the row before it did not have; the one
  // below closes them again, because the row after it is undivided.
  assert.match(lines[dividedRow - 1], /┬.+┬/);
  assert.match(lines[dividedRow + 1], /┴.+┴/);
});
