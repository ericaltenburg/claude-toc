import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";

import { chunkTurns, createExtractor, parseModelOutput } from "../src/extract.js";
import { createSearch } from "../src/search.js";
import { createStateStore } from "../src/state.js";
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
  const known = model.calls[0].prompt.match(/^- \(alcs_broadcast_variants\//gm) ?? [];
  assert.equal(known.length, 20);
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

test("chunkTurns keeps turns whole until a single turn cannot fit", () => {
  const turns = [
    { role: "user", text: "a".repeat(50) },
    { role: "assistant", text: "b".repeat(50) },
  ];
  assert.equal(chunkTurns(turns, 1000).length, 1);
  assert.equal(chunkTurns(turns, 70).length, 2);
  assert.equal(chunkTurns([{ role: "user", text: "c".repeat(500) }], 100).length, 6);
});

test("parseModelOutput keeps a skip and rejects a plausible-looking non-result", () => {
  assert.deepEqual(parseModelOutput('{"skip": true}'), { skip: true });
  assert.throws(() => parseModelOutput('{"topic": {}}'), /malformed/);
  assert.throws(() => parseModelOutput(""), /malformed/);
});
