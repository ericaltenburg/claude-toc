import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localDateParts,
  parseFactLine,
  parsePromptRecord,
  parseSessionRecord,
  parseTopic,
} from "../src/parse.js";

const NY = "America/New_York";

const LATE_ON_26_AUGUST_IN_NEW_YORK = Date.parse("2026-08-27T03:30:00Z");
const BEFORE_CLOCKS_JUMP_FORWARD = Date.parse("2026-03-08T06:30:00Z");
const AFTER_CLOCKS_JUMP_FORWARD = Date.parse("2026-03-08T07:30:00Z");

test("parses a fact carrying a session and a date", () => {
  const fact = parseFactLine("- Project uses Brazil build system [session:316972f2, 2026-05-12]");

  assert.deepEqual(fact, {
    text: "Project uses Brazil build system",
    session: "316972f2",
    date: "2026-05-12",
  });
});

test("parses the older fact format that carries only a date", () => {
  const fact = parseFactLine("- Variants are keyed by show id [2026-04-24]");

  assert.deepEqual(fact, {
    text: "Variants are keyed by show id",
    session: null,
    date: "2026-04-24",
  });
});

test("keeps a fact whose trailing bracket is neither format, with a null date", () => {
  const fact = parseFactLine("- Alarm fired 07:25-08:03 UTC only [unverified]");

  assert.deepEqual(fact, {
    text: "Alarm fired 07:25-08:03 UTC only [unverified]",
    session: null,
    date: null,
  });
});

test("keeps a fact with no trailing bracket at all, with a null date", () => {
  const fact = parseFactLine("- Coverage is 17 percent");

  assert.deepEqual(fact, { text: "Coverage is 17 percent", session: null, date: null });
});

test("takes the trailing provenance, not an earlier bracket in the text", () => {
  const fact = parseFactLine(
    "- Ticket tripped by [ERROR] lines in EU logs [session:1f07b22c, 2026-08-27]"
  );

  assert.deepEqual(fact, {
    text: "Ticket tripped by [ERROR] lines in EU logs",
    session: "1f07b22c",
    date: "2026-08-27",
  });
});

test("keeps unicode in a fact intact", () => {
  const fact = parseFactLine("- Clipboard mangles “smart quotes” and — dashes [2026-08-27]");

  assert.equal(fact.text, "Clipboard mangles “smart quotes” and — dashes");
});

test("a line that is not a list item is not a fact", () => {
  assert.equal(parseFactLine("## Context"), null);
  assert.equal(parseFactLine(""), null);
  assert.equal(parseFactLine("-- not a bullet"), null);
});

test("splits a topic file into its sections, keeping each fact's section", () => {
  const markdown = [
    "# alcs broadcast variants",
    "",
    "## Context",
    "- Variants are keyed by show id [session:316972f2, 2026-05-12]",
    "- Project uses Brazil build system [session:316972f2, 2026-05-12]",
    "",
    "## Decisions",
    "- Will store variants in DynamoDB [session:316972f2, 2026-05-12]",
    "",
  ].join("\n");

  const facts = parseTopic(markdown);

  assert.deepEqual(
    facts.map((f) => [f.section, f.text]),
    [
      ["Context", "Variants are keyed by show id"],
      ["Context", "Project uses Brazil build system"],
      ["Decisions", "Will store variants in DynamoDB"],
    ]
  );
});

test("records the line each fact came from", () => {
  const markdown = "# t\n\n## Context\n- first [2026-01-01]\n- second [2026-01-02]\n";

  assert.deepEqual(
    parseTopic(markdown).map((f) => f.line),
    [4, 5]
  );
});

test("ignores list items that appear before any section heading", () => {
  const markdown = "# t\n\n- stray item [2026-01-01]\n\n## Context\n- real fact [2026-01-02]\n";

  assert.deepEqual(
    parseTopic(markdown).map((f) => f.text),
    ["real fact"]
  );
});

test("keeps facts from a section other than Context or Decisions", () => {
  const markdown = "# t\n\n## Notes\n- kept anyway [2026-01-01]\n";

  assert.deepEqual(parseTopic(markdown).map((f) => [f.section, f.text]), [
    ["Notes", "kept anyway"],
  ]);
});

test("buckets a timestamp by local date, not by UTC date", () => {
  const parts = localDateParts(LATE_ON_26_AUGUST_IN_NEW_YORK, NY);

  assert.deepEqual(parts, { date: "2026-08-26", time: "23:30:00" });
});

test("buckets a timestamp on either side of a daylight-saving boundary", () => {
  assert.deepEqual(localDateParts(BEFORE_CLOCKS_JUMP_FORWARD, NY), {
    date: "2026-03-08",
    time: "01:30:00",
  });
  assert.deepEqual(localDateParts(AFTER_CLOCKS_JUMP_FORWARD, NY), {
    date: "2026-03-08",
    time: "03:30:00",
  });
});

test("applies the offset in force on the day, not a fixed offset", () => {
  const standard = localDateParts(Date.parse("2026-03-07T18:00:00Z"), NY);
  const daylight = localDateParts(Date.parse("2026-03-09T18:00:00Z"), NY);

  assert.equal(standard.time, "13:00:00");
  assert.equal(daylight.time, "14:00:00");
});

test("buckets midnight local as that day, not the previous one", () => {
  assert.deepEqual(localDateParts(Date.parse("2026-08-27T04:00:00Z"), NY), {
    date: "2026-08-27",
    time: "00:00:00",
  });
});

test("parses a prompt log record", () => {
  const record = parsePromptRecord(
    JSON.stringify({
      display: "what did we decide about broadcast variants?",
      timestamp: 1774279096774,
      project: "/some/project",
      sessionId: "4cc461d6-2d88-4426-966c-ba2081ca75bb",
    }),
    NY
  );

  assert.deepEqual(record, {
    ts: 1774279096774,
    localDate: localDateParts(1774279096774, NY).date,
    localTime: localDateParts(1774279096774, NY).time,
    session: "4cc461d6-2d88-4426-966c-ba2081ca75bb",
    project: "/some/project",
    text: "what did we decide about broadcast variants?",
    isCommand: 0,
  });
});

test("flags a prompt that is a slash command", () => {
  const record = parsePromptRecord(
    JSON.stringify({ display: "/toc-search variants", timestamp: 1774279104053 })
  );

  assert.equal(record.isCommand, 1);
  assert.equal(record.session, null);
  assert.equal(record.project, null);
});

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

test("skips a malformed prompt log line rather than throwing", () => {
  assert.equal(parsePromptRecord("{not json"), null);
  assert.equal(parsePromptRecord(""), null);
  assert.equal(parsePromptRecord("null"), null);
  assert.equal(parsePromptRecord(JSON.stringify({ display: "no timestamp" })), null);
  assert.equal(parsePromptRecord(JSON.stringify({ timestamp: 1774279104053 })), null);
  assert.equal(
    parsePromptRecord(JSON.stringify({ display: "  ", timestamp: 1774279104053 })),
    null
  );
});
