import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendPrompts, corpusEnv, REPO_ROOT, tempCorpus, writeTopic } from "./support/corpus.js";

const CLI = join(REPO_ROOT, "bin", "toc-search");

const FACTS = {
  Context: ["- Variants are keyed by show id [session:316972f2, 2026-05-12]"],
  Decisions: ["- Will store variants in DynamoDB [session:316972f2, 2026-05-12]"],
};

const NODE_WITH_BUILTIN_SQLITE = process.execPath;

function run(config, args) {
  return spawnSync(CLI, args, {
    encoding: "utf-8",
    timeout: 20_000,
    env: corpusEnv(config, { CLAUDE_TOC_NODE: NODE_WITH_BUILTIN_SQLITE }),
  });
}

test("the read path's one command returns facts and prompts and stays silent on stderr", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);
  appendPrompts(config, [{ display: "how do variants work again?" }]);

  const result = run(config, ["variants"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "", "the read path must write nothing to stderr");
  assert.match(result.stdout, /^FACTS {2}2 of 2$/m);
  assert.match(result.stdout, /broadcast_variants \| Decisions \| 2026-05-12 \| session 316972f2/);
  assert.match(result.stdout, /^PROMPTS {2}1 of 1$/m);
  assert.match(result.stdout, /how do variants work again\?/);
  assert.match(result.stdout, /dated evidence, not current truth/);
});

test("a search from the command line lands in the search log", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);

  run(config, ["--facts", "variants"]);

  const line = JSON.parse(readFileSync(config.searchLogPath, "utf-8").trim());
  assert.equal(line.query, "variants");
  assert.equal(line.rows, 2);
});

test("an overview from the command line lists topics and hit counts only", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);

  const result = run(config, ["--overview", "variants"]);

  assert.match(result.stdout, /2 hits {2}broadcast_variants/);
  assert.equal(result.stdout.includes("DynamoDB"), false);
});

test("json output is machine-readable", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);

  const result = run(config, ["--facts", "--json", "variants"]);
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.facts.rows.length, 2);
  assert.equal(parsed.prompts, null);
});

test("smoke queries exit non-zero when one comes back empty", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);
  writeFileSync(
    config.smokeQueriesPath,
    JSON.stringify({ queries: [{ query: "variants" }, { query: "kinesis" }] })
  );

  const result = run(config, ["--smoke"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL {2}0 rows {2}kinesis/);
  assert.match(result.stdout, /smoke queries FAILED/);
});

test("a refused write reads as one line, not as a stack trace", () => {
  const config = tempCorpus();

  const result = run(config, ["--sql", "delete from facts"]);

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "toc-search: the read path is read-only: only select and with statements are allowed\n");
});

test("a filter with no query terms is a search, not a usage error", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);

  const result = run(config, ["--facts", "--topic", "broadcast_variants", "--section", "Decisions"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Will store variants in DynamoDB/);
  assert.equal(result.stdout.includes("keyed by show id"), false);
});

test("no arguments prints usage rather than searching for nothing", () => {
  const config = tempCorpus();

  const result = run(config, []);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /^toc-search \[options\]/);
});
