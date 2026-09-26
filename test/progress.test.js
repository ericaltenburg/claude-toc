import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ATTEMPTS_BEFORE_QUARANTINE, createStateStore } from "../src/sessions/progress.js";
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

  assert.deepEqual(readdirSync(dirname(config.statePath)), ["state.json"]);
});

test("records a skipped session so it is not retried forever", () => {
  const config = freshConfig();
  const state = createStateStore(config);

  state.recordExtraction("nothing");

  assert.ok(state.processedRecord("nothing"));
  assert.equal(state.load().processed["nothing"].topic, null);
});

test("a state file still carrying the old lease loads, and the lease is dropped", () => {
  const config = freshConfig();
  writeFileSync(
    config.statePath,
    JSON.stringify({
      version: 1,
      processed: { old: { ts: "2026-09-08T20:15:00.000Z", topic: "resume_project" } },
      extraction: { holder: "21f6985e", startedAt: "2026-09-08T20:15:00.000Z" },
    })
  );
  const state = createStateStore(config);

  assert.ok(state.processedRecord("old"));
  state.recordExtraction("new");

  assert.equal("extraction" in JSON.parse(readFileSync(config.statePath, "utf-8")), false);
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

test("survives a corrupt state file rather than throwing", () => {
  const config = freshConfig();
  writeFileSync(config.statePath, "{ not json");

  const state = createStateStore(config);
  assert.deepEqual(state.load().processed, {});
  state.recordExtraction("fresh");
  assert.ok(state.processedRecord("fresh"));
});
