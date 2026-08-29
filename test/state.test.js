import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../src/config.js";
import { createStateStore } from "../src/state.js";

function freshConfig() {
  const corpusDir = mkdtempSync(join(tmpdir(), "claude-toc-state-"));
  mkdirSync(join(corpusDir, "topics"), { recursive: true });
  return createConfig({ corpusDir }, {});
}

test("records processed sessions in the one state file", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  assert.equal(state.isProcessed("abc123"), false);

  state.markProcessed("abc123", {
    topic: { id: "alcs_broadcast_variants", summary: "one line" },
    context: ["a"],
    decisions: ["b", "c"],
  });

  assert.equal(state.isProcessed("abc123"), true);

  const record = createStateStore(config).load().processed["abc123"];
  assert.equal(record.topic, "alcs_broadcast_variants");
  assert.equal(record.summary, "one line");
  assert.equal(record.context, 1);
  assert.equal(record.decisions, 2);
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(readdirSync(config.corpusDir).sort(), ["state.json", "topics"]);
});

test("records a skipped session so it is not retried forever", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  state.markProcessed("nothing", null);

  assert.equal(state.isProcessed("nothing"), true);
  assert.equal(state.load().processed["nothing"].topic, null);
});

test("holds the extraction lock in the same state file", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  assert.equal(state.acquireExtraction("session-one"), true);
  assert.equal(state.load().extraction.sessionId, "session-one");

  // a second sweeper, reading the same state file, must not start
  assert.equal(createStateStore(config).acquireExtraction("session-two"), false);

  state.releaseExtraction();
  assert.equal(state.load().extraction, null);
  assert.equal(createStateStore(config).acquireExtraction("session-two"), true);
});

test("takes over an extraction lock older than its lease", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(
    config.statePath,
    JSON.stringify({ version: 1, processed: {}, extraction: { sessionId: "dead", startedAt: stale } })
  );

  assert.equal(state.acquireExtraction("session-two"), true);
  assert.equal(state.load().extraction.sessionId, "session-two");
});

test("releasing a lock another process took does not clobber it", () => {
  const config = freshConfig();
  const owner = createStateStore(config);
  owner.acquireExtraction("mine");

  createStateStore(config).releaseExtraction("someone-else");

  assert.equal(owner.load().extraction.sessionId, "mine");
});

test("adopts an existing processed.json once and never writes it again", () => {
  const config = freshConfig();
  const legacy = join(config.corpusDir, "processed.json");
  writeFileSync(
    legacy,
    JSON.stringify({ old: { ts: "2026-05-12T00:00:00.000Z", topic: "resume_project" } })
  );

  const state = createStateStore(config);
  assert.equal(state.isProcessed("old"), true);

  state.markProcessed("new", null);

  assert.ok(existsSync(config.statePath));
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(legacy, "utf-8"))),
    ["old"],
    "the legacy file must be left untouched, not extended"
  );
  assert.deepEqual(Object.keys(state.load().processed).sort(), ["new", "old"]);
});

test("survives a corrupt state file rather than throwing", () => {
  const config = freshConfig();
  writeFileSync(config.statePath, "{ not json");

  const state = createStateStore(config);
  assert.deepEqual(state.load().processed, {});
  state.markProcessed("fresh", null);
  assert.equal(state.isProcessed("fresh"), true);
});
