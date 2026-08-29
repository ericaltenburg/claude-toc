import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { homedir } from "node:os";

import { createConfig } from "../src/config.js";

const REPO_ROOT = join(import.meta.dirname, "..");

test("derives every corpus path from the corpus directory", () => {
  const config = createConfig({ corpusDir: "/tmp/corpus" }, {});

  assert.equal(config.corpusDir, "/tmp/corpus");
  assert.equal(config.topicsDir, join("/tmp/corpus", "topics"));
  assert.equal(config.tocPath, join("/tmp/corpus", "toc.json"));
  assert.equal(config.sessionIndexPath, join("/tmp/corpus", "sessions.jsonl"));
  assert.equal(config.statePath, join("/tmp/corpus", "state.json"));
  assert.equal(config.indexPath, join("/tmp/corpus", "index.db"));
  assert.equal(config.searchLogPath, join("/tmp/corpus", "search.log"));
  assert.equal(config.smokeQueriesPath, join("/tmp/corpus", "smoke-queries.json"));
});

test("reads the corpus, transcripts and prompt log from the environment", () => {
  const config = createConfig(
    {},
    {
      CLAUDE_TOC_CORPUS_DIR: "/env/corpus",
      CLAUDE_TOC_TRANSCRIPTS_DIR: "/env/transcripts",
      CLAUDE_TOC_PROMPT_LOG: "/env/history.jsonl",
    }
  );

  assert.equal(config.corpusDir, "/env/corpus");
  assert.equal(config.transcriptsDir, "/env/transcripts");
  assert.equal(config.promptLog, "/env/history.jsonl");
});

test("explicit overrides beat the environment", () => {
  const config = createConfig(
    { corpusDir: "/explicit/corpus" },
    { CLAUDE_TOC_CORPUS_DIR: "/env/corpus" }
  );

  assert.equal(config.corpusDir, "/explicit/corpus");
});

test("defaults sit under the Claude configuration directory", () => {
  const config = createConfig({}, { CLAUDE_CONFIG_DIR: "/claude" });

  assert.equal(config.corpusDir, join("/claude", "claude-toc"));
  assert.equal(config.transcriptsDir, join("/claude", "projects"));
  assert.equal(config.promptLog, join("/claude", "history.jsonl"));
});

test("no default path resolves inside this repository", () => {
  const config = createConfig({}, {});

  for (const [key, value] of Object.entries(config)) {
    assert.ok(
      !value.startsWith(REPO_ROOT + sep),
      `${key} resolves inside the repository: ${value}`
    );
  }
  assert.ok(config.corpusDir.startsWith(join(homedir(), ".claude") + sep));
});

test("the config object cannot be mutated by a module that takes it", () => {
  const config = createConfig({ corpusDir: "/tmp/corpus" }, {});

  assert.throws(() => {
    config.corpusDir = "/somewhere/else";
  }, TypeError);
});
