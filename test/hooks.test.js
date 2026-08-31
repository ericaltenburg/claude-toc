import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { createStateStore } from "../src/state.js";
import {
  fakeExtractor,
  idleFor,
  runNode,
  sessionPayload,
  tempCorpus,
  writeTranscript,
  LOGGER_HOOK,
  SWEEP_HOOK,
} from "./support/corpus.js";

const HOOKS = [
  ["toc-logger", LOGGER_HOOK],
  ["toc-sweep", SWEEP_HOOK],
];

const LONGER_THAN_THE_IDLE_THRESHOLD = 2 * 60 * 60_000;
const A_SPAWN_TAKES_AT_MOST_MS = 5000;

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

test("toc-logger does nothing when fired inside the extractor", () => {
  const config = tempCorpus();
  const result = runNode(LOGGER_HOOK, {
    input: sessionPayload(config),
    config,
    env: { TOC_EXTRACTING: "1" },
  });

  assert.equal(result.status, 0);
  assert.equal(existsSync(config.sessionIndexPath), false);
});

function sweepable(config) {
  return idleFor(
    writeTranscript(config, "316972f2-1111-2222-3333-444455556666", [
      { role: "user", text: "where do broadcast variants live?" },
      { role: "assistant", text: "in dynamodb, keyed by show id" },
    ]),
    LONGER_THAN_THE_IDLE_THRESHOLD
  );
}

function sweepWith(config, { spawnsRecordedIn, env = {} } = {}) {
  const extractor = fakeExtractor(config, { writesTo: spawnsRecordedIn });
  return runNode(SWEEP_HOOK, {
    input: sessionPayload(config),
    config,
    env: { CLAUDE_TOC_EXTRACTOR: extractor, ...env },
  });
}

function spawns(path) {
  const deadline = Date.now() + A_SPAWN_TAKES_AT_MOST_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim().split("\n");
  }
  return [];
}

function noSpawn(path) {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf-8");
  }
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

test("submitting a prompt sweeps an idle session in a detached extractor", () => {
  const config = tempCorpus();
  sweepable(config);
  const spawnLog = join(config.corpusDir, "spawns");

  const result = sweepWith(config, { spawnsRecordedIn: spawnLog });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(spawns(spawnLog), [`${realpathSync(config.extractorDir)} --sweep`]);
  assert.ok(createStateStore(config).load().extraction, "the extraction lock is held");
});

test("a second prompt inside the debounce window sweeps nothing", () => {
  const config = tempCorpus();
  sweepable(config);
  const spawnLog = join(config.corpusDir, "spawns");

  sweepWith(config, { spawnsRecordedIn: spawnLog });
  assert.equal(spawns(spawnLog).length, 1);

  createStateStore(config).releaseExtraction(
    createStateStore(config).load().extraction.sessionId
  );
  sweepWith(config, { spawnsRecordedIn: spawnLog });

  assert.deepEqual(spawns(spawnLog).length, 1, "the second sweep was debounced");
});

test("a sweep does not overlap an extraction already running", () => {
  const config = tempCorpus();
  sweepable(config);
  const spawnLog = join(config.corpusDir, "spawns");
  createStateStore(config).acquireExtraction("dddddddd-1111-2222-3333-444455556666");

  sweepWith(config, { spawnsRecordedIn: spawnLog });

  assert.equal(noSpawn(spawnLog), "");
});

test("a sweep with nothing idle spawns nothing", () => {
  const config = tempCorpus();
  writeTranscript(config, "316972f2-1111-2222-3333-444455556666", [
    { role: "user", text: "still typing in this session" },
  ]);
  const spawnLog = join(config.corpusDir, "spawns");

  sweepWith(config, { spawnsRecordedIn: spawnLog });

  assert.equal(noSpawn(spawnLog), "");
  assert.equal(createStateStore(config).load().extraction, null);
});

test("a sweep fired inside the extractor does nothing at all", () => {
  const config = tempCorpus();
  sweepable(config);
  const spawnLog = join(config.corpusDir, "spawns");

  const result = sweepWith(config, {
    spawnsRecordedIn: spawnLog,
    env: { TOC_EXTRACTING: "1" },
  });

  assert.equal(result.status, 0);
  assert.equal(noSpawn(spawnLog), "");
  assert.equal(existsSync(config.statePath), false);
});
