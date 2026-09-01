import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendPrompts, corpusEnv, REPO_ROOT, tempCorpus, writeTopic } from "../support/corpus.js";

const CLI = join(REPO_ROOT, "bin", "toc-search");

const FACTS = {
  Context: ["- Variants are keyed by show id [session:316972f2, 2026-05-12]"],
  Decisions: ["- Will store variants in DynamoDB [session:316972f2, 2026-05-12]"],
};

function run(config, args, { cwd, env = {} } = {}) {
  const environment = corpusEnv(config, env);
  if (!("CLAUDE_PROJECT_DIR" in env)) delete environment.CLAUDE_PROJECT_DIR;
  return spawnSync(CLI, args, { cwd, encoding: "utf-8", timeout: 20_000, env: environment });
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

test("rows drilled out with sql carry the attribution note like any other result", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);

  const result = run(config, ["--sql", "select date, text from facts order by line"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /keyed by show id/);
  assert.match(result.stdout, /dated evidence, not current truth/);
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

test("a search Claude ran itself scopes to the project it ran in", () => {
  const config = tempCorpus();
  appendPrompts(config, [
    { display: "variants here", project: REPO_ROOT },
    { display: "variants there", project: "/work/other" },
  ]);

  const result = run(config, ["--prompts", "--source", "automatic", "variants"], {
    cwd: REPO_ROOT,
    env: { CLAUDE_PROJECT_DIR: REPO_ROOT },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /variants here/);
  assert.equal(result.stdout.includes("variants there"), false);

  const line = JSON.parse(readFileSync(config.searchLogPath, "utf-8").trim());
  assert.equal(line.source, "automatic");
  assert.equal(line.project, REPO_ROOT);
});

test("an automatic search run from a subdirectory still finds the project's material", () => {
  const config = tempCorpus();
  appendPrompts(config, [
    { display: "variants here", project: REPO_ROOT },
    { display: "variants there", project: "/work/other" },
  ]);

  const result = run(config, ["--prompts", "--source", "automatic", "variants"], {
    cwd: join(REPO_ROOT, "test", "support"),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /variants here/, "the repository is the project, not the cwd");
  assert.equal(result.stdout.includes("variants there"), false);
});

test("json output carries the attribution note too", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);

  const searched = JSON.parse(run(config, ["--facts", "--json", "variants"]).stdout);
  const drilled = JSON.parse(run(config, ["--json", "--sql", "select date, text from facts"]).stdout);

  assert.match(searched.attribution, /dated evidence, not current truth/);
  assert.match(drilled.attribution, /dated evidence, not current truth/);
  assert.equal(drilled.rows.length, 2);
});

test("an unrecognised --source is a usage error rather than a mislabelled log line", () => {
  const config = tempCorpus();

  const result = run(config, ["--source", "guessed", "variants"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--source/);
  assert.equal(existsSync(config.searchLogPath), false);
});

test("no arguments prints usage rather than searching for nothing", () => {
  const config = tempCorpus();

  const result = run(config, []);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /^toc-search \[options\]/);
});
