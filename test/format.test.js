import { test } from "node:test";
import assert from "node:assert/strict";

import {
  factLine,
  factLinesIn,
  markSupersededIn,
  newTopicFile,
  parseFactLine,
  parseTopic,
} from "../src/corpus/format.js";

test("parses a fact carrying a session and a date", () => {
  const fact = parseFactLine("- Project uses Brazil build system [session:316972f2, 2026-05-12]");

  assert.deepEqual(fact, {
    text: "Project uses Brazil build system",
    session: "316972f2",
    date: "2026-05-12",
    superseded: null,
  });
});

test("parses a fact another session superseded, keeping its own session and date", () => {
  const fact = parseFactLine(
    "- Batch size is 264,000 [session:316972f2, 2026-05-12] [superseded:ef56ab78, 2026-09-20]"
  );

  assert.deepEqual(fact, {
    text: "Batch size is 264,000",
    session: "316972f2",
    date: "2026-05-12",
    superseded: { session: "ef56ab78", date: "2026-09-20" },
  });
});

test("parses a superseded fact that carried no attribution of its own", () => {
  const fact = parseFactLine("- Coverage is 17 percent [superseded:ef56ab78, 2026-09-20]");

  assert.deepEqual(fact, {
    text: "Coverage is 17 percent",
    session: null,
    date: null,
    superseded: { session: "ef56ab78", date: "2026-09-20" },
  });
});

test("parses the older fact format that carries only a date", () => {
  const fact = parseFactLine("- Variants are keyed by show id [2026-04-24]");

  assert.deepEqual(fact, {
    text: "Variants are keyed by show id",
    session: null,
    date: "2026-04-24",
    superseded: null,
  });
});

test("keeps a fact whose trailing bracket is neither format, with a null date", () => {
  const fact = parseFactLine("- Alarm fired 07:25-08:03 UTC only [unverified]");

  assert.deepEqual(fact, {
    text: "Alarm fired 07:25-08:03 UTC only [unverified]",
    session: null,
    date: null,
    superseded: null,
  });
});

test("keeps a fact with no trailing bracket at all, with a null date", () => {
  const fact = parseFactLine("- Coverage is 17 percent");

  assert.deepEqual(fact, {
    text: "Coverage is 17 percent",
    session: null,
    date: null,
    superseded: null,
  });
});

test("takes the trailing provenance, not an earlier bracket in the text", () => {
  const fact = parseFactLine(
    "- Ticket tripped by [ERROR] lines in EU logs [session:1f07b22c, 2026-08-27]"
  );

  assert.deepEqual(fact, {
    text: "Ticket tripped by [ERROR] lines in EU logs",
    session: "1f07b22c",
    date: "2026-08-27",
    superseded: null,
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

// --- Round trip ---

const A_SESSION = "316972f2-1111-2222-3333-444455556666";
const A_LATER_SESSION = "ef56ab78-aaaa-bbbb-cccc-ddddeeeeffff";

// #23 lived between the writer and the reader: a line the topic store wrote was read back by
// patterns the store did not share, and nothing checked the two agreed.
test("a fact line the writer produces reads back as the text, session and date it was written from", () => {
  const written = [
    ["Project uses Brazil build system", A_SESSION, "316972f2"],
    ["Ticket tripped by [ERROR] lines in EU logs", A_SESSION, "316972f2"],
    ["Alarm fired 07:25-08:03 UTC only [unverified]", A_SESSION, "316972f2"],
    ["Released on [2026-01-01] behind a flag", A_SESSION, "316972f2"],
    ["Clipboard mangles “smart quotes” and — dashes", A_SESSION, "316972f2"],
    ["Quoted [superseded:aaaaaaaa, 2026-01-01] from an old note", A_SESSION, "316972f2"],
    ["A fact whose session was never known", null, "unknown"],
  ];

  for (const [text, sessionId, session] of written) {
    const markdown = `## Context\n${factLine(text, sessionId, "2026-05-12")}`;
    const [fact] = parseTopic(markdown);

    assert.deepEqual(
      { text: fact.text, session: fact.session, date: fact.date, superseded: fact.superseded },
      { text, session, date: "2026-05-12", superseded: null },
      text
    );

    const marked = markSupersededIn(markdown, fact, A_LATER_SESSION, "2026-09-20");
    const [old] = parseTopic(marked);

    assert.ok(marked.startsWith(markdown.trimEnd()), `the line is kept byte for byte: ${text}`);
    assert.deepEqual(
      { text: old.text, session: old.session, date: old.date, superseded: old.superseded },
      { text, session, date: "2026-05-12", superseded: { session: "ef56ab78", date: "2026-09-20" } },
      text
    );
  }
});

test("only a current fact in the named section with the exact text is marked", () => {
  const markdown =
    "## Context\n- Batch size is 264,000 [session:316972f2, 2026-05-12]\n" +
    "## Open\n- Batch size is 264,000 [session:316972f2, 2026-05-12]\n";
  const theOpenOne = { section: "Open", text: "Batch size is 264,000" };

  const marked = markSupersededIn(markdown, theOpenOne, A_LATER_SESSION, "2026-09-20");

  assert.deepEqual(
    parseTopic(marked).map((fact) => [fact.section, fact.superseded?.date ?? null]),
    [
      ["Context", null],
      ["Open", "2026-09-20"],
    ]
  );
  assert.equal(markSupersededIn(marked, theOpenOne, A_LATER_SESSION, "2026-09-21"), null);
  assert.equal(
    markSupersededIn(markdown, { section: "Context", text: "Batch size is 264" }, A_LATER_SESSION, "2026-09-20"),
    null,
    "a reworded or missing line is not found, and nothing is marked"
  );
});

test("a fact line is carried as written and compared by its words alone", () => {
  const line = factLine("Variants are keyed by show id", A_SESSION, "2026-05-12");

  assert.deepEqual(factLinesIn(`## Context\n${line}\n## Decisions\n`), [
    { line, text: "Variants are keyed by show id", superseded: null },
  ]);
});

test("a new topic file carries a heading for each section and no facts", () => {
  const skeleton = newTopicFile("alcs_broadcast_variants");

  assert.equal(
    skeleton,
    "# alcs broadcast variants\n\n## Context\n\n## Decisions\n\n## Gotchas\n\n## Open\n"
  );
  assert.deepEqual(parseTopic(skeleton), []);
});
