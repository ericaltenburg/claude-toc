import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

import { ATTEMPTS_BEFORE_QUARANTINE, createStateStore } from "../src/state.js";
import { tempCorpus } from "./support/corpus.js";

function freshConfig() {
  const config = tempCorpus();
  mkdirSync(config.topicsDir, { recursive: true });
  return config;
}

test("exposes what extraction recorded without leaking the file's shape", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  assert.equal(state.processedRecord("never-seen"), null);
  state.recordExtraction("seen", { result: { topic: { id: "resume_project" } } });
  assert.equal(state.processedRecord("seen").topic, "resume_project");
});

test("records processed sessions in the one state file", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  assert.equal(state.processedRecord("abc123"), null);

  state.recordExtraction("abc123", {
    offset: 4096,
    result: {
      topic: { id: "alcs_broadcast_variants", summary: "one line" },
      context: ["a"],
      decisions: ["b", "c"],
    },
  });

  assert.ok(state.processedRecord("abc123"));

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

  state.recordExtraction("nothing");

  assert.ok(state.processedRecord("nothing"));
  assert.equal(state.load().processed["nothing"].topic, null);
});

test("holds the extraction lease in the same state file", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  assert.equal(state.acquireExtraction("session-one"), true);
  assert.equal(state.load().extraction.holder, "session-one");

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
    JSON.stringify({ version: 1, processed: {}, extraction: { holder: "dead", startedAt: stale } })
  );

  assert.equal(state.acquireExtraction("session-two"), true);
  assert.equal(state.load().extraction.holder, "session-two");
});

test("releasing a lock another process took does not clobber it", () => {
  const config = freshConfig();
  const owner = createStateStore(config);
  owner.acquireExtraction("mine");

  createStateStore(config).releaseExtraction("someone-else");

  assert.equal(owner.load().extraction.holder, "mine");
});

test("releasing a quarantine clears the attempts that caused it", () => {
  const config = freshConfig();
  const state = createStateStore(config);
  for (let attempt = 0; attempt < ATTEMPTS_BEFORE_QUARANTINE; attempt++) {
    state.recordFailure("session-one", "model returned malformed output");
  }
  assert.equal(state.isQuarantined("session-one"), true);

  assert.equal(state.releaseQuarantine("session-one"), true);

  assert.equal(state.isQuarantined("session-one"), false);
  assert.equal(state.load().failures["session-one"], undefined, "the next failure is its first");
  assert.equal(state.releaseQuarantine("session-one"), false, "releasing twice is not a release");
});

test("adopts an existing processed.json once and never writes it again", () => {
  const config = freshConfig();
  const legacy = config.legacyProcessedPath;
  writeFileSync(
    legacy,
    JSON.stringify({ old: { ts: "2026-05-12T00:00:00.000Z", topic: "resume_project" } })
  );

  const state = createStateStore(config);
  assert.ok(state.processedRecord("old"));

  state.recordExtraction("new");

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
  state.recordExtraction("fresh");
  assert.ok(state.processedRecord("fresh"));
});
