import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../src/config.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const LOGGER = join(REPO_ROOT, "hooks", "toc-logger.mjs");
const AUTO_ANALYZE = join(REPO_ROOT, "hooks", "toc-auto-analyze.mjs");

function tempConfig() {
  const root = mkdtempSync(join(tmpdir(), "claude-toc-hooks-"));
  mkdirSync(join(root, "corpus"), { recursive: true });
  return createConfig({ corpusDir: join(root, "corpus"), transcriptsDir: join(root, "projects"), promptLog: join(root, "history.jsonl") }, {});
}

function run(hook, input, config, extraEnv = {}) {
  return spawnSync("node", [hook], {
    input,
    encoding: "utf-8",
    timeout: 20_000,
    env: {
      ...process.env,
      CLAUDE_TOC_CORPUS_DIR: config.corpusDir,
      CLAUDE_TOC_TRANSCRIPTS_DIR: config.transcriptsDir,
      CLAUDE_TOC_PROMPT_LOG: config.promptLog,
      ...extraEnv,
    },
  });
}

for (const [name, hook] of [
  ["toc-logger", LOGGER],
  ["toc-auto-analyze", AUTO_ANALYZE],
]) {
  test(`${name} exits zero and writes nothing on garbage input`, () => {
    const config = tempConfig();
    const result = run(hook, "not json at all", config);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test(`${name} never writes to stdout on a valid payload`, () => {
    const config = tempConfig();
    const result = run(
      hook,
      JSON.stringify({
        session_id: "bbbbbbbb-1111-2222-3333-444455556666",
        transcript_path: join(config.transcriptsDir, "nope.jsonl"),
        cwd: "/some/project",
        prompt: "broadcast variants",
      }),
      config
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
}

test("toc-logger indexes a session once, without a per-turn counter file", () => {
  const config = tempConfig();
  const payload = JSON.stringify({
    session_id: "cccccccc-1111-2222-3333-444455556666",
    transcript_path: join(config.transcriptsDir, "nope.jsonl"),
    cwd: "/some/project",
    prompt: "hello",
  });

  run(LOGGER, payload, config);
  run(LOGGER, payload, config);

  const lines = readFileSync(config.sessionIndexPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.session_id, "cccccccc-1111-2222-3333-444455556666");
  assert.equal(entry.cwd, "/some/project");

  // the leftover files this replaced: a lock file and one counter per session
  assert.equal(existsSync(join(config.corpusDir, ".analyzing")), false);
  assert.equal(existsSync(join(config.corpusDir, "processed.json")), false);
  assert.deepEqual(
    readdirSync(config.corpusDir).filter((f) => f.startsWith(".turns-")),
    []
  );
});

test("hooks fired inside the extractor do nothing", () => {
  const config = tempConfig();
  const payload = JSON.stringify({
    session_id: "dddddddd-1111-2222-3333-444455556666",
    transcript_path: join(config.transcriptsDir, "nope.jsonl"),
    cwd: "/some/project",
  });

  for (const hook of [LOGGER, AUTO_ANALYZE]) {
    const result = run(hook, payload, config, { TOC_ANALYZING: "1" });
    assert.equal(result.status, 0);
  }

  assert.equal(existsSync(config.sessionIndexPath), false);
});
