import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";

import { parseTopic } from "../src/corpus/format.js";
import { createExtractor, SAME_SESSION_FACTS_IN_A_PROMPT } from "../src/extract/extractor.js";
import { createSearch } from "../src/search/search.js";
import { createStateStore } from "../src/sessions/progress.js";
import {
  appendSessions,
  appendTranscript,
  tempCorpus,
  topicPath,
  transcriptPath,
  writeTopic,
  writeTranscript,
} from "./support/corpus.js";

const SESSION = "316972f2-1111-2222-3333-444455556666";
const PROJECT = "/work/alcs";

const CONVERSATION = [
  { role: "user", text: "where do broadcast variants live for the alcs pipeline?" },
  {
    role: "assistant",
    text: "broadcast variants are stored in dynamodb, keyed by show id, and the alcs pipeline reads them there",
  },
  { role: "user", text: "so we should keep dynamodb for broadcast variants" },
];

const MODEL_OUTPUT = {
  topic: {
    id: "alcs_broadcast_variants",
    keywords: ["broadcast", "variants"],
    summary: "how broadcast variants are stored",
  },
  context: ["Broadcast variants are keyed by show id"],
  decisions: ["Will keep DynamoDB for broadcast variants"],
};

function corpusWithOneTopic() {
  const config = tempCorpus();
  writeTopic(config, "alcs_broadcast_variants", {
    Context: ["- Broadcast variants are stored in dynamodb [session:aaaaaaaa, 2026-05-12]"],
    Decisions: ["- Will use dynamodb for the alcs pipeline [session:aaaaaaaa, 2026-05-12]"],
  });
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [session()]);
  return config;
}

function session(overrides = {}) {
  return {
    session_id: SESSION,
    transcript: `/tmp/replaced-by-the-test`,
    cwd: PROJECT,
    started: "2026-08-27T15:00:00.000Z",
    ...overrides,
  };
}

function sessionIn(config, overrides = {}) {
  return session({ transcript: transcriptPath(config, overrides.session_id ?? SESSION), ...overrides });
}

function stubModel(replies) {
  const calls = [];
  const answer = typeof replies === "function" ? replies : () => replies[calls.length - 1];
  return {
    calls,
    callModel(call) {
      calls.push(call);
      const reply = answer(call, calls.length - 1);
      if (reply instanceof Error) throw reply;
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  };
}

function extractorFor(config, model, options = {}) {
  return createExtractor(config, { callModel: model.callModel, ...options });
}

function factsIn(config, topicId) {
  const path = topicPath(config, topicId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

test("a session's unread slice becomes facts on the topic the model chose", () => {
  const config = corpusWithOneTopic();
  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "extracted");
  assert.equal(result.topic, "alcs_broadcast_variants");

  const facts = factsIn(config, "alcs_broadcast_variants");
  assert.equal(facts.length, 4, "two existing facts plus the two just extracted");
  assert.ok(
    facts.some((line) => line.includes("keyed by show id") && line.includes(`session:${SESSION.slice(0, 8)}`)),
    facts.join("\n")
  );
  assert.ok(facts.some((line) => line.includes("Will keep DynamoDB")));

  assert.equal(createStateStore(config).extractionOffset(SESSION), result.offset);
  assert.ok(result.offset > 0);
});

test("gotchas and open items are filed under sections of their own", () => {
  const config = corpusWithOneTopic();
  const model = stubModel([
    {
      ...MODEL_OUTPUT,
      gotchas: ["A variant written without a show id is silently dropped by the reader"],
      open: ["Whether to replicate variants per region is undecided"],
    },
  ]);
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  const sections = parseTopic(readFileSync(topicPath(config, "alcs_broadcast_variants"), "utf-8"))
    .filter((fact) => fact.session === SESSION.slice(0, 8))
    .map((fact) => [fact.section, fact.text]);
  assert.deepEqual(sections, [
    ["Context", "Broadcast variants are keyed by show id"],
    ["Decisions", "Will keep DynamoDB for broadcast variants"],
    ["Gotchas", "A variant written without a show id is silently dropped by the reader"],
    ["Open", "Whether to replicate variants per region is undecided"],
  ]);
  assert.deepEqual([result.gotchas, result.open], [1, 1]);
  const record = createStateStore(config).processedRecord(SESSION);
  assert.deepEqual([record.gotchas, record.open], [1, 1]);
});

const A_WEEK_AGO = Date.parse("2026-08-24T15:00:00Z");
const THE_DAY_THE_CONVERSATION_HAPPENED = "2026-08-24";

function dateOnEveryFact(config, topicId) {
  return [...new Set(factsIn(config, topicId).map((line) => line.match(/, (\d{4}-\d{2}-\d{2})\]/)?.[1]))];
}

test("a fact is dated from the conversation, not from when the extractor ran", () => {
  const config = tempCorpus();
  writeTranscript(config, SESSION, CONVERSATION, { at: A_WEEK_AGO });
  appendSessions(config, [sessionIn(config)]);

  const extractor = extractorFor(config, stubModel([MODEL_OUTPUT]), { timeZone: "UTC" });
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "extracted");
  assert.deepEqual(
    dateOnEveryFact(config, "alcs_broadcast_variants"),
    [THE_DAY_THE_CONVERSATION_HAPPENED],
    "a week-old session extracted today is a week-old fact, not today's news"
  );
});

test("a fact from a transcript with no timestamps falls back to when the session started", () => {
  const config = tempCorpus();
  writeTranscript(config, SESSION, CONVERSATION);
  const started = `${THE_DAY_THE_CONVERSATION_HAPPENED}T15:00:00.000Z`;
  appendSessions(config, [sessionIn(config, { started })]);

  const extractor = extractorFor(config, stubModel([MODEL_OUTPUT]), { timeZone: "UTC" });
  extractor.extractSession(sessionIn(config, { started }));
  extractor.close();

  assert.deepEqual(dateOnEveryFact(config, "alcs_broadcast_variants"), [
    THE_DAY_THE_CONVERSATION_HAPPENED,
  ]);
});

test("a fact with nothing to date it by is dated today", () => {
  const config = tempCorpus();
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [sessionIn(config, { started: null })]);

  const extractor = extractorFor(config, stubModel([MODEL_OUTPUT]), { timeZone: "UTC" });
  extractor.extractSession(sessionIn(config, { started: null }));
  extractor.close();

  assert.deepEqual(dateOnEveryFact(config, "alcs_broadcast_variants"), [
    new Date().toISOString().slice(0, 10),
  ]);
});

test("candidate topics come from a full-text query, capped at ten", () => {
  const config = tempCorpus();
  for (let i = 0; i < 30; i++) {
    writeTopic(config, `broadcast_topic_${String(i).padStart(3, "0")}`, {
      Context: [`- Broadcast variants for the alcs pipeline, note ${i} [session:aaaaaaaa, 2026-05-12]`],
    });
  }
  writeTopic(config, "unrelated_kitchen_sink", {
    Context: ["- Sourdough needs a longer proof [session:bbbbbbbb, 2026-05-12]"],
  });
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [sessionIn(config)]);

  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.candidates.length, 10);
  const prompt = model.calls[0].prompt;
  const listed = prompt.match(/^- broadcast_topic_\d{3}:/gm) ?? [];
  assert.equal(listed.length, 10, "the prompt lists the candidates and nothing else");
  assert.ok(!prompt.includes("unrelated_kitchen_sink"), "a topic matching nothing is not a candidate");
});

function twoEquallyMatchingTopics(sameProjectAs) {
  const config = tempCorpus();
  const fact = "Broadcast variants for the alcs pipeline live in dynamodb";
  writeTopic(config, "aaa_variants_elsewhere", {
    Context: [`- ${fact} [session:bbbbbbbb, 2026-05-12]`],
  });
  writeTopic(config, "zzz_variants_here", {
    Context: [`- ${fact} [session:aaaaaaaa, 2026-05-12]`],
  });
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [
    { session_id: "aaaaaaaa-0000-0000-0000-000000000000", cwd: sameProjectAs, started: "2026-05-12" },
    {
      session_id: "bbbbbbbb-0000-0000-0000-000000000000",
      cwd: "/work/elsewhere",
      started: "2026-05-12",
    },
    sessionIn(config),
  ]);
  return config;
}

function topCandidate(config) {
  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model, { candidateLimit: 1 });
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();
  return result.candidates[0];
}

test("a topic from the current project is scored above an equally matching one elsewhere", () => {
  const nearby = topCandidate(twoEquallyMatchingTopics(PROJECT));

  assert.equal(
    nearby.topic,
    "zzz_variants_here",
    "the project must outweigh the alphabetical tie-break these two otherwise fall to"
  );
  assert.equal(nearby.sameProject, true);
});

test("with neither topic in the current project, the project boost decides nothing", () => {
  const neither = topCandidate(twoEquallyMatchingTopics("/work/somewhere-else-entirely"));

  assert.equal(
    neither.topic,
    "aaa_variants_elsewhere",
    "with no boost to apply, equally matching topics fall to the alphabetical tie-break"
  );
  assert.equal(neither.sameProject, false);
});

test("the known-facts block is capped at twenty facts", () => {
  const config = tempCorpus();
  writeTopic(config, "alcs_broadcast_variants", {
    Context: Array.from(
      { length: 40 },
      (_, i) => `- Broadcast variants note ${i} for the alcs pipeline [session:aaaaaaaa, 2026-05-12]`
    ),
  });
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [sessionIn(config)]);

  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.knownFacts, 20);
  const known = model.calls[0].prompt.match(/^\[\d+\] \(alcs_broadcast_variants\//gm) ?? [];
  assert.equal(known.length, 20);
});

const EARLIER_IN_THIS_SESSION = `session:${SESSION.slice(0, 8)}, 2026-08-20`;

const NUMBERED = /^\[(\d+)\] /;

// Each known fact as "(topic/Section) text", without the number it was listed under.
function knownFactsIn(prompt) {
  const block = prompt.split("do not repeat these:\n")[1]?.split("\nCONVERSATION:")[0] ?? "";
  return block
    .split("\n")
    .filter((line) => NUMBERED.test(line))
    .map((line) => line.replace(NUMBERED, ""));
}

// The number a prompt listed a known fact under, which is how a reply names what it supersedes.
function numberOf(prompt, text) {
  const line = prompt.split("\n").find((listed) => NUMBERED.test(listed) && listed.endsWith(`) ${text}`));
  assert.ok(line, `"${text}" is not among the known facts`);
  return Number(NUMBERED.exec(line)[1]);
}

function knownFactsPromptedFor(config) {
  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);
  extractor.extractSession(sessionIn(config));
  extractor.close();
  return knownFactsIn(model.calls[0].prompt);
}

test("a session's own earlier facts lead the known facts, ahead of the ranked ones", () => {
  const config = tempCorpus();
  writeTopic(config, "alcs_broadcast_variants", {
    Context: [
      "- Broadcast variants are stored in dynamodb [session:aaaaaaaa, 2026-05-12]",
      `- Broadcast variants are keyed by show id [${EARLIER_IN_THIS_SESSION}]`,
    ],
  });
  writeTopic(config, "ingest_lambda", {
    Context: [`- The ingest lambda retries three times [${EARLIER_IN_THIS_SESSION}]`],
  });
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [sessionIn(config)]);

  const known = knownFactsPromptedFor(config);

  assert.deepEqual(
    known.slice(0, 2).sort(),
    [
      "(alcs_broadcast_variants/Context) Broadcast variants are keyed by show id",
      "(ingest_lambda/Context) The ingest lambda retries three times",
    ],
    "an earlier slice's facts come first, even one filed under a topic that is not a candidate"
  );
  assert.deepEqual(
    known.slice(2),
    ["(alcs_broadcast_variants/Context) Broadcast variants are stored in dynamodb"],
    "a ranked fact the session's own facts already listed is not listed twice"
  );
});

test("the same-session facts in a prompt are capped", () => {
  const config = corpusWithOneTopic();
  writeTopic(config, "earlier_in_this_session", {
    Context: Array.from(
      { length: SAME_SESSION_FACTS_IN_A_PROMPT + 5 },
      (_, i) => `- Sourdough note ${i} [${EARLIER_IN_THIS_SESSION}]`
    ),
  });

  const known = knownFactsPromptedFor(config);

  const own = known.filter((line) => line.startsWith("(earlier_in_this_session/"));
  assert.equal(own.length, SAME_SESSION_FACTS_IN_A_PROMPT);
  assert.ok(
    known.some((line) => line.startsWith("(alcs_broadcast_variants/")),
    "the ranked facts still follow a session that hit the cap"
  );
});

test("a session with no facts yet is prompted with the ranked facts alone, as before", () => {
  const config = corpusWithOneTopic();
  writeTopic(config, "another_sessions_notes", {
    Context: ["- Sourdough needs a longer proof [session:bbbbbbbb, 2026-05-12]"],
  });

  assert.deepEqual(knownFactsPromptedFor(config).sort(), [
    "(alcs_broadcast_variants/Context) Broadcast variants are stored in dynamodb",
    "(alcs_broadcast_variants/Decisions) Will use dynamodb for the alcs pipeline",
  ]);
});

// --- Supersession ---

const OPEN_ITEM = "Whether broadcast variants move off dynamodb is undecided";
const OPEN_LINE = `- ${OPEN_ITEM} [session:aaaaaaaa, 2026-05-12]`;
const WHEN_THIS_SESSION_HAPPENED = "2026-08-27";

function corpusWithAnOpenItem() {
  const config = corpusWithOneTopic();
  writeTopic(config, "alcs_broadcast_variants", {
    Context: ["- Broadcast variants are stored in dynamodb [session:aaaaaaaa, 2026-05-12]"],
    Decisions: ["- Will use dynamodb for the alcs pipeline [session:aaaaaaaa, 2026-05-12]"],
    Open: [OPEN_LINE],
  });
  return config;
}

function extractWith(config, reply) {
  const model = stubModel((call) => reply(call.prompt));
  const extractor = extractorFor(config, model, { timeZone: "UTC" });
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();
  return { result, model };
}

const topicText = (config) => readFileSync(topicPath(config, "alcs_broadcast_variants"), "utf-8");

test("the decision that settles an open item supersedes it, and the item's line is marked, not removed", () => {
  const config = corpusWithAnOpenItem();
  const decision = "Chose to keep broadcast variants in dynamodb, because every variant fits one item";

  const { result } = extractWith(config, (prompt) => ({
    ...MODEL_OUTPUT,
    decisions: [{ text: decision, supersedes: [numberOf(prompt, OPEN_ITEM)] }],
  }));

  assert.equal(result.superseded, 1);
  assert.ok(
    topicText(config).includes(
      `\n${OPEN_LINE} [superseded:${SESSION.slice(0, 8)}, ${WHEN_THIS_SESSION_HAPPENED}]\n`
    ),
    topicText(config)
  );
  const facts = parseTopic(topicText(config));
  assert.deepEqual(
    [OPEN_ITEM, decision].map((text) => {
      const fact = facts.find((candidate) => candidate.text === text);
      return [fact.section, fact.session, fact.date, fact.superseded];
    }),
    [
      [
        "Open",
        "aaaaaaaa",
        "2026-05-12",
        { session: SESSION.slice(0, 8), date: WHEN_THIS_SESSION_HAPPENED },
      ],
      ["Decisions", SESSION.slice(0, 8), WHEN_THIS_SESSION_HAPPENED, null],
    ]
  );
});

test("a supersedes number that names no known fact is ignored, and the fact is appended as usual", () => {
  const config = corpusWithAnOpenItem();

  const { result } = extractWith(config, () => ({
    ...MODEL_OUTPUT,
    context: [{ text: "Broadcast variants are replicated per region", supersedes: [999, -1, "0"] }],
  }));

  assert.equal(result.status, "extracted");
  assert.equal(result.superseded, 0);
  assert.ok(factsIn(config, "alcs_broadcast_variants").some((line) => line.includes("replicated per region")));
  assert.equal(topicText(config).includes("[superseded:"), false);
});

// Marking the old fact is only safe when the new one landed. One the section already holds,
// reworded, would otherwise leave the value it restates with no current line saying it.
test("a fact that only restates the one it claims to supersede marks nothing", () => {
  const config = corpusWithAnOpenItem();
  const before = topicText(config);

  extractWith(config, (prompt) => ({
    ...MODEL_OUTPUT,
    context: [],
    decisions: [
      {
        text: "Will use dynamodb for the alcs pipeline",
        supersedes: [numberOf(prompt, "Will use dynamodb for the alcs pipeline")],
      },
    ],
  }));

  assert.equal(topicText(config).includes("[superseded:"), false);
  assert.equal(topicText(config), before);
});

test("a superseded fact is not offered to the model as one already in memory", () => {
  const config = corpusWithOneTopic();
  writeTopic(config, "alcs_broadcast_variants", {
    Context: [
      "- Broadcast variants are stored in dynamodb [session:aaaaaaaa, 2026-05-12] [superseded:bbbbbbbb, 2026-06-01]",
      "- Broadcast variants are stored in s3 [session:bbbbbbbb, 2026-06-01]",
      `- Broadcast variants are keyed by show id [${EARLIER_IN_THIS_SESSION}] [superseded:bbbbbbbb, 2026-06-01]`,
    ],
  });

  assert.deepEqual(knownFactsPromptedFor(config), [
    "(alcs_broadcast_variants/Context) Broadcast variants are stored in s3",
  ]);
});

test("prompt size does not grow as topic count grows", () => {
  const promptFor = (topicCount) => {
    const config = tempCorpus();
    for (let i = 0; i < topicCount; i++) {
      writeTopic(config, `broadcast_topic_${String(i).padStart(4, "0")}`, {
        Context: [
          `- Broadcast variants in the alcs pipeline live in dynamodb, note ${String(i).padStart(4, "0")} [session:aaaaaaaa, 2026-05-12]`,
        ],
      });
    }
    writeTranscript(config, SESSION, CONVERSATION);
    appendSessions(config, [sessionIn(config)]);

    const model = stubModel([MODEL_OUTPUT]);
    const extractor = extractorFor(config, model);
    extractor.extractSession(sessionIn(config));
    extractor.close();
    return model.calls[0].prompt;
  };

  const small = promptFor(40);
  const tenTimesLarger = promptFor(400);

  assert.equal(
    tenTimesLarger.length,
    small.length,
    "with uniform topics the caps, not the corpus, decide the prompt's size"
  );
});

test("markdown is written only after the model call succeeds", () => {
  const config = corpusWithOneTopic();
  const before = factsIn(config, "alcs_broadcast_variants");
  const model = stubModel(() => new Error("model unavailable"));
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 1);
  assert.deepEqual(factsIn(config, "alcs_broadcast_variants"), before);
  assert.equal(createStateStore(config).extractionOffset(SESSION), 0, "the slice must retry");
});

test("output wrapped in a fenced block is parsed without a second model call", () => {
  const config = corpusWithOneTopic();
  const model = stubModel([`Here you go:\n\`\`\`json\n${JSON.stringify(MODEL_OUTPUT)}\n\`\`\`\n`]);
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "extracted");
  assert.equal(model.calls.length, 1);
  assert.ok(factsIn(config, "alcs_broadcast_variants").some((l) => l.includes("keyed by show id")));
});

test("malformed output fails the slice without a second, larger model call", () => {
  const config = corpusWithOneTopic();
  const model = stubModel(["I could not do that"]);
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "failed");
  assert.deepEqual(
    model.calls.map((call) => call.model),
    ["global.anthropic.claude-sonnet-5"],
    "escalation is for a chunk the model could not take, not for output it would not format"
  );
  assert.match(result.error, /malformed/);
  assert.equal(createStateStore(config).extractionOffset(SESSION), 0);
  assert.equal(factsIn(config, "alcs_broadcast_variants").length, 2);
});

test("a slice exceeding the context window is chunked, and a failing chunk escalates", () => {
  const config = corpusWithOneTopic();
  appendTranscript(config, SESSION, [
    { role: "user", text: `broadcast variants again: ${"x".repeat(400)}` },
    { role: "assistant", text: `the alcs pipeline still uses dynamodb: ${"y".repeat(400)}` },
  ]);

  const model = stubModel((_call, index) => {
    if (index === 1) return new Error("chunk too hard");
    if (index === 2) {
      return { ...MODEL_OUTPUT, context: ["Broadcast variants are replicated per region"] };
    }
    return MODEL_OUTPUT;
  });
  const extractor = extractorFor(config, model, { maxChunkChars: 300 });

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "extracted");
  assert.ok(result.chunks > 1, `expected several chunks, got ${result.chunks}`);
  assert.equal(model.calls[1].model, "global.anthropic.claude-sonnet-5");
  assert.equal(model.calls[2].model, "global.anthropic.claude-opus-5");

  const facts = factsIn(config, "alcs_broadcast_variants");
  assert.ok(facts.some((line) => line.includes("replicated per region")), facts.join("\n"));
});

test("a chunk that named a different topic keeps its facts under that topic", () => {
  const config = corpusWithOneTopic();
  appendTranscript(config, SESSION, [
    { role: "user", text: `then we moved on to the ingest lambda: ${"x".repeat(400)}` },
    { role: "assistant", text: `the ingest lambda retries three times: ${"y".repeat(400)}` },
  ]);

  const model = stubModel((_call, index) =>
    index === 0
      ? MODEL_OUTPUT
      : {
          topic: { id: "ingest_lambda", keywords: ["ingest"], summary: "the ingest lambda" },
          context: ["The ingest lambda retries three times"],
          decisions: [],
        }
  );
  const extractor = extractorFor(config, model, { maxChunkChars: 400 });

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "extracted");
  assert.deepEqual(result.topics.sort(), ["alcs_broadcast_variants", "ingest_lambda"]);
  assert.ok(
    factsIn(config, "ingest_lambda").some((line) => line.includes("retries three times")),
    "a chunk's facts must not be filed under a topic it did not name"
  );
  assert.ok(factsIn(config, "alcs_broadcast_variants").some((l) => l.includes("keyed by show id")));
});

// --- Chunks of one slice ---

const INGEST_LAMBDA = { id: "ingest_lambda", keywords: ["ingest"], summary: "the ingest lambda" };

function corpusWithASliceOfSeveralChunks() {
  const config = corpusWithOneTopic();
  appendTranscript(config, SESSION, [
    { role: "user", text: `then we moved on to the ingest lambda: ${"x".repeat(400)}` },
    { role: "assistant", text: `the ingest lambda retries three times: ${"y".repeat(400)}` },
  ]);
  return config;
}

// Every chunk of a slice used to get the same prompt, so the second never saw what the first had
// just returned and wrote it again, reworded.
test("a later chunk's prompt lists the facts the earlier chunks of the same run returned", () => {
  const config = corpusWithASliceOfSeveralChunks();
  const model = stubModel((_call, index) =>
    index === 0 ? MODEL_OUTPUT : { topic: INGEST_LAMBDA, context: ["The ingest lambda retries three times"] }
  );
  const extractor = extractorFor(config, model, { maxChunkChars: 400 });

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.ok(result.chunks > 2, `expected at least three chunks, got ${result.chunks}`);
  const fromTheFirstChunk = [
    "(alcs_broadcast_variants/Context) Broadcast variants are keyed by show id",
    "(alcs_broadcast_variants/Decisions) Will keep DynamoDB for broadcast variants",
  ];
  const listed = model.calls.map((call) => knownFactsIn(call.prompt));
  for (const line of fromTheFirstChunk) {
    assert.equal(listed[0].includes(line), false, line);
    assert.ok(listed[1].includes(line), line);
  }
  assert.ok(listed[2].includes("(ingest_lambda/Context) The ingest lambda retries three times"));
});

test("a later chunk can supersede what an earlier chunk of the same run returned", () => {
  const config = corpusWithASliceOfSeveralChunks();
  const replaced = "Broadcast variants are keyed by show id";
  const model = stubModel((call, index) =>
    index === 0
      ? MODEL_OUTPUT
      : {
          topic: INGEST_LAMBDA,
          context: [
            "The ingest lambda retries three times",
            "The ingest lambda reads variants from a queue",
            {
              text: "Broadcast variants are keyed by show id and region",
              supersedes: [numberOf(call.prompt, replaced)],
            },
          ],
        }
  );
  const extractor = extractorFor(config, model, { maxChunkChars: 400, timeZone: "UTC" });

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.superseded, 1, "written after its own topic, and still found");
  const old = parseTopic(readFileSync(topicPath(config, "alcs_broadcast_variants"), "utf-8")).find(
    (fact) => fact.text === replaced
  );
  assert.deepEqual(old.superseded, { session: SESSION.slice(0, 8), date: WHEN_THIS_SESSION_HAPPENED });
});

// Merging chunks folds the two copies into one fact that names itself as superseded, and it is
// the one line saying that value.
test("a later chunk restating an earlier chunk's fact, and claiming to supersede it, marks nothing", () => {
  const config = corpusWithASliceOfSeveralChunks();
  const restated = "Broadcast variants are keyed by show id";
  const model = stubModel((call, index) =>
    index === 0
      ? MODEL_OUTPUT
      : {
          ...MODEL_OUTPUT,
          context: [{ text: ` ${restated} `, supersedes: [numberOf(call.prompt, restated)] }],
          decisions: [],
        }
  );
  const extractor = extractorFor(config, model, { maxChunkChars: 400 });

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.superseded, 0);
  assert.equal(topicText(config).includes("[superseded:"), false);
  assert.equal(factsIn(config, "alcs_broadcast_variants").filter((line) => line.includes(restated)).length, 1);
});

test("what earlier chunks returned shares the cap on the session's own facts", () => {
  const config = corpusWithASliceOfSeveralChunks();
  writeTopic(config, "earlier_in_this_session", {
    Context: Array.from(
      { length: SAME_SESSION_FACTS_IN_A_PROMPT + 5 },
      (_, i) => `- Sourdough note ${i} [${EARLIER_IN_THIS_SESSION}]`
    ),
  });
  const model = stubModel((_call, index) =>
    index === 0 ? MODEL_OUTPUT : { topic: INGEST_LAMBDA, context: [] }
  );
  const extractor = extractorFor(config, model, { maxChunkChars: 400 });

  extractor.extractSession(sessionIn(config));
  extractor.close();

  const second = knownFactsIn(model.calls[1].prompt);
  const ownOrThisRun = second.filter(
    (line) =>
      line.startsWith("(earlier_in_this_session/") ||
      line.endsWith("keyed by show id") ||
      line.endsWith("Will keep DynamoDB for broadcast variants")
  );
  assert.equal(ownOrThisRun.length, SAME_SESSION_FACTS_IN_A_PROMPT);
  assert.deepEqual(second.slice(0, 2).sort(), [
    "(alcs_broadcast_variants/Context) Broadcast variants are keyed by show id",
    "(alcs_broadcast_variants/Decisions) Will keep DynamoDB for broadcast variants",
  ]);
});

test("a session failing three times is quarantined and surfaced", () => {
  const config = corpusWithOneTopic();
  const model = stubModel(() => new Error("model unavailable"));

  const statuses = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const extractor = extractorFor(config, model);
    statuses.push(extractor.extractSession(sessionIn(config)).status);
    extractor.close();
  }

  assert.deepEqual(statuses, ["failed", "failed", "quarantined"]);
  assert.equal(createStateStore(config).isQuarantined(SESSION), true);

  const search = createSearch(config);
  try {
    const quarantined = search.quarantined();
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].sessionId, SESSION);
    assert.equal(quarantined[0].attempts, 3);
    assert.match(quarantined[0].error, /model unavailable/);
    assert.equal(quarantined[0].project, PROJECT);
  } finally {
    search.close();
  }

  const callsBefore = model.calls.length;
  const skipped = extractorFor(config, model);
  assert.equal(skipped.extractSession(sessionIn(config)).status, "quarantined");
  assert.equal(model.calls.length, callsBefore, "a quarantined session is not called for again");
  skipped.close();
});

test("a malformed reply is recorded with what the model actually said", () => {
  const config = corpusWithOneTopic();
  const model = stubModel(["I can't help with that particular request."]);
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "failed");
  assert.match(
    result.error,
    /I can't help with that/,
    "a failure nobody can diagnose is a failure nobody can fix"
  );
  assert.match(createStateStore(config).load().failures[SESSION].error, /I can't help with that/);
});

test("a released session is extracted on the next attempt", () => {
  const config = corpusWithOneTopic();
  const failing = stubModel(() => new Error("model unavailable"));
  for (let attempt = 0; attempt < 3; attempt++) {
    const extractor = extractorFor(config, failing);
    extractor.extractSession(sessionIn(config));
    extractor.close();
  }
  const state = createStateStore(config);
  assert.equal(state.isQuarantined(SESSION), true);

  state.releaseQuarantine(SESSION);
  const retry = extractorFor(config, stubModel([MODEL_OUTPUT]));
  const result = retry.extractSession(sessionIn(config));
  retry.close();

  assert.equal(result.status, "extracted");
  assert.ok(factsIn(config, "alcs_broadcast_variants").some((l) => l.includes("keyed by show id")));
});

test("a failed extraction leaves the slice for the next attempt", () => {
  const config = corpusWithOneTopic();
  const failing = stubModel(() => new Error("transient"));
  const first = extractorFor(config, failing);
  first.extractSession(sessionIn(config));
  first.close();

  const succeeding = stubModel([MODEL_OUTPUT]);
  const second = extractorFor(config, succeeding);
  const result = second.extractSession(sessionIn(config));
  second.close();

  assert.equal(result.status, "extracted");
  assert.match(succeeding.calls[0].prompt, /keyed by show id/, "the same slice went to the model");
  assert.equal(createStateStore(config).extractionOffset(SESSION), result.offset);
  assert.equal(createStateStore(config).load().failures[SESSION], undefined);
});

test("only the unread part of a transcript is extracted again", () => {
  const config = corpusWithOneTopic();
  const first = stubModel([MODEL_OUTPUT]);
  const one = extractorFor(config, first);
  one.extractSession(sessionIn(config));
  one.close();

  appendTranscript(config, SESSION, [
    { role: "user", text: "and where does the alcs pipeline emit variant metrics?" },
    { role: "assistant", text: "the alcs pipeline emits variant metrics to cloudwatch" },
  ]);

  const second = stubModel([
    { ...MODEL_OUTPUT, context: ["Variant metrics go to CloudWatch"], decisions: [] },
  ]);
  const two = extractorFor(config, second);
  const result = two.extractSession(sessionIn(config));
  two.close();

  const conversation = second.calls[0].prompt.split("CONVERSATION:\n")[1];
  assert.match(conversation, /variant metrics/);
  assert.ok(!conversation.includes("keyed by show id"), "the read slice must not be paid for twice");
  assert.equal(result.status, "extracted");
});

test("nothing to extract advances the offset without calling the model", () => {
  const config = tempCorpus();
  writeTranscript(config, SESSION, [{ role: "user", text: "hi" }]);
  appendSessions(config, [sessionIn(config)]);

  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "nothing-to-extract");
  assert.equal(model.calls.length, 0);
  assert.equal(createStateStore(config).extractionOffset(SESSION), result.offset);
});

test("a topic created after the index was opened is a candidate rather than a duplicate", () => {
  const config = corpusWithOneTopic();
  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);

  writeTopicTheOpenIndexHasNeverSeen(config);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.ok(
    result.candidates.some((candidate) => candidate.topic === "alcs_variant_pipeline"),
    result.candidates.map((candidate) => candidate.topic).join(", ")
  );
});

function writeTopicTheOpenIndexHasNeverSeen(config) {
  writeTopic(config, "alcs_variant_pipeline", {
    Context: [
      "- The alcs pipeline reads broadcast variants from dynamodb [session:cccccccc, 2026-08-30]",
    ],
  });
}

test("a topic id whose stored spelling uses another separator still reuses the file", () => {
  const config = tempCorpus();
  writeTopic(config, "alcs-broadcast-variants", {
    Context: ["- Broadcast variants live in dynamodb for the alcs pipeline [session:aaaaaaaa, 2026-05-12]"],
  });
  writeTranscript(config, SESSION, CONVERSATION);
  appendSessions(config, [sessionIn(config)]);

  const model = stubModel([
    { ...MODEL_OUTPUT, topic: { ...MODEL_OUTPUT.topic, id: "alcs_broadcast_variants" } },
  ]);
  const extractor = extractorFor(config, model, { candidateLimit: 0 });

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.topic, "alcs-broadcast-variants");
  assert.deepEqual(
    readdirSync(config.topicsDir),
    ["alcs-broadcast-variants.md"],
    "normalising only the returned id forks a second file for one subject"
  );
});

test("a chunk no model can take fails after both were tried", () => {
  const config = corpusWithOneTopic();
  const model = stubModel(() => new Error("context window exceeded"));
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "failed");
  assert.deepEqual(
    model.calls.map((call) => call.model),
    ["global.anthropic.claude-sonnet-5", "global.anthropic.claude-opus-5"],
    "the larger model is the fallback for a chunk the extraction model cannot take"
  );
  assert.match(result.error, /context window exceeded/);
});

test("every topic a slice wrote is recorded, not just the first", () => {
  const config = corpusWithOneTopic();
  appendTranscript(config, SESSION, [
    { role: "user", text: `then we moved on to the ingest lambda: ${"x".repeat(400)}` },
    { role: "assistant", text: `the ingest lambda retries three times: ${"y".repeat(400)}` },
  ]);

  const model = stubModel((_call, index) =>
    index === 0
      ? MODEL_OUTPUT
      : {
          topic: { id: "ingest_lambda", keywords: ["ingest"], summary: "the ingest lambda" },
          context: ["The ingest lambda retries three times"],
          decisions: [],
        }
  );
  const extractor = extractorFor(config, model, { maxChunkChars: 400 });
  extractor.extractSession(sessionIn(config));
  extractor.close();

  const record = createStateStore(config).processedRecord(SESSION);
  assert.deepEqual([...record.topics].sort(), ["alcs_broadcast_variants", "ingest_lambda"]);
  assert.equal(record.context, 2);
  assert.equal(record.decisions, 1);
});

test("a topic id that differs only in shape reuses the existing file", () => {
  const config = corpusWithOneTopic();
  const model = stubModel([
    { ...MODEL_OUTPUT, topic: { ...MODEL_OUTPUT.topic, id: "ALCS Broadcast Variants" } },
  ]);
  const extractor = extractorFor(config, model);

  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.topic, "alcs_broadcast_variants");
  assert.deepEqual(readdirSync(config.topicsDir), ["alcs_broadcast_variants.md"]);
});

test("a transcript that vanished is reported rather than throwing", () => {
  const config = tempCorpus();
  appendSessions(config, [sessionIn(config)]);
  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);

  assert.equal(extractor.extractSession(sessionIn(config)).status, "no-transcript");
  extractor.close();
});

test("a malformed transcript line is skipped rather than aborting the slice", () => {
  const config = corpusWithOneTopic();
  appendTranscript(config, SESSION, [{ role: "user", text: "one more about broadcast variants" }]);
  appendFileSync(transcriptPath(config, SESSION), "{ not json\n");

  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);
  const result = extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.equal(result.status, "extracted");
});

test("each chunk's model call carries the session it came from, so spend is attributable", () => {
  const config = corpusWithOneTopic();
  const model = stubModel([MODEL_OUTPUT]);
  const extractor = extractorFor(config, model);

  extractor.extractSession(sessionIn(config));
  extractor.close();

  assert.deepEqual(
    model.calls.map((call) => call.sessionId),
    [SESSION]
  );
});


