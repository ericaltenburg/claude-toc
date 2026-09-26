import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSessionRecord } from "../src/sessions/registry.js";

test("parses a logged session record", () => {
  const record = parseSessionRecord(
    JSON.stringify({
      session_id: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
      transcript: "/transcripts/14f63e34.jsonl",
      cwd: "/some/project",
      started: "2026-04-24T04:29:00Z",
    })
  );

  assert.deepEqual(record, {
    sessionId: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
    transcriptPath: "/transcripts/14f63e34.jsonl",
    project: "/some/project",
    startedAt: "2026-04-24T04:29:00Z",
  });
});

test("keeps a session record that carries only an identifier", () => {
  const record = parseSessionRecord(JSON.stringify({ session_id: "14f63e34" }));

  assert.deepEqual(record, {
    sessionId: "14f63e34",
    transcriptPath: null,
    project: null,
    startedAt: null,
  });
});

test("skips a malformed session log line rather than throwing", () => {
  assert.equal(parseSessionRecord("{not json"), null);
  assert.equal(parseSessionRecord(""), null);
  assert.equal(parseSessionRecord("null"), null);
  assert.equal(parseSessionRecord(JSON.stringify({ cwd: "/some/project" })), null);
});
