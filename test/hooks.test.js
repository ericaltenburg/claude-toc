import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  tempCorpus,
  runNode,
  sessionPayload,
  LOGGER_HOOK,
  EXTRACT_HOOK,
} from "./support/corpus.js";

const HOOKS = [
  ["toc-logger", LOGGER_HOOK],
  ["toc-extract", EXTRACT_HOOK],
];

for (const [name, hook] of HOOKS) {
  test(`${name} exits zero and stays silent on garbage input`, () => {
    const config = tempCorpus();
    const result = runNode(hook, { input: "not json at all", config });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test(`${name} never writes to stdout on a valid payload`, () => {
    const config = tempCorpus();
    const result = runNode(hook, { input: sessionPayload(config), config });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test(`${name} does nothing when fired inside the extractor`, () => {
    const config = tempCorpus();
    const result = runNode(hook, {
      input: sessionPayload(config),
      config,
      env: { TOC_EXTRACTING: "1" },
    });

    assert.equal(result.status, 0);
    assert.equal(existsSync(config.sessionIndexPath), false);
  });
}

test("toc-logger indexes a session once, without a per-turn counter file", () => {
  const config = tempCorpus();
  const payload = sessionPayload(config, {
    session_id: "cccccccc-1111-2222-3333-444455556666",
  });

  runNode(LOGGER_HOOK, { input: payload, config });
  runNode(LOGGER_HOOK, { input: payload, config });

  const lines = readFileSync(config.sessionIndexPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.session_id, "cccccccc-1111-2222-3333-444455556666");
  assert.equal(entry.cwd, "/some/project");

  assert.equal(existsSync(join(config.corpusDir, ".analyzing")), false);
  assert.equal(existsSync(config.legacyProcessedPath), false);
  assert.deepEqual(
    readdirSync(config.corpusDir).filter((f) => f.startsWith(".turns-")),
    []
  );
});
