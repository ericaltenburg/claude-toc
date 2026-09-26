import { test } from "node:test";
import assert from "node:assert/strict";

import { buildExtractPrompt, parseModelOutput } from "../src/extract/prompt.js";
import { EXTRACTION_PROMPT_MARKER } from "../src/sessions/transcript.js";

test("parseModelOutput keeps a skip and rejects a plausible-looking non-result", () => {
  assert.deepEqual(parseModelOutput('{"skip": true}'), { skip: true });
  assert.throws(() => parseModelOutput('{"topic": {}}'), /malformed/);
  assert.throws(() => parseModelOutput(""), /malformed/);
});

test("a reply wrapped in a fence is read as the JSON inside it", () => {
  const fenced = '```json\n{"topic": {"id": "brazil", "keywords": ["build"], "summary": "s"}}\n```';

  assert.equal(parseModelOutput(fenced).topic.id, "brazil");
});

test("prose around the JSON is stepped over to reach the outermost object", () => {
  const chatty = 'Here you go:\n{"topic": {"id": "brazil", "keywords": [], "summary": ""}}\nHope that helps.';

  assert.equal(parseModelOutput(chatty).topic.id, "brazil");
});

test("the failure carries enough of the reply to diagnose it", () => {
  assert.throws(() => parseModelOutput("not json at all"), /not json at all/);
  assert.throws(() => parseModelOutput("   "), /it returned nothing/);
});

test("anything that is not a string is dropped from context and decisions", () => {
  const output = JSON.stringify({
    topic: { id: "brazil", keywords: "not a list", summary: 7 },
    context: ["a real fact", 42, "", null, "  "],
    decisions: "not a list",
  });

  const parsed = parseModelOutput(output);

  assert.deepEqual(parsed.topic.keywords, []);
  assert.equal(parsed.topic.summary, "");
  assert.deepEqual(parsed.context, ["a real fact"]);
  assert.deepEqual(parsed.decisions, []);
});

// The marker is how a sweep recognises the extractor's own sessions, per ADR 0011, so the
// prompt has to keep opening with it.
test("the prompt opens with the marker a sweep looks for", () => {
  assert.ok(buildExtractPrompt().startsWith(EXTRACTION_PROMPT_MARKER));
});

test("candidate topics and known facts are named in the prompt when there are any", () => {
  const bare = buildExtractPrompt();
  const withContext = buildExtractPrompt({
    candidates: [{ topic: "brazil", summary: "the build system", keywords: "build brazil" }],
    knownFacts: [{ topic: "brazil", section: "Context", text: "uses version sets" }],
  });

  assert.doesNotMatch(bare, /Candidate topics/);
  assert.match(withContext, /brazil: the build system \(keywords: build brazil\)/);
  assert.match(withContext, /\(brazil\/Context\) uses version sets/);
  assert.match(withContext, /do not repeat these/);
});

// The candidate list shows each topic's summary, so the summary steers where the next session's
// facts are filed. A summary that recaps the latest session describes that session and misfiles
// the next one; a reused topic keeps the subject description it already has.
test("the summary describes the topic's subject, and a reused candidate keeps its own", () => {
  const prompt = buildExtractPrompt({
    candidates: [{ topic: "brazil", summary: "the build system", keywords: "build brazil" }],
  });

  assert.match(prompt, /topic\.summary: one sentence describing the subject the topic covers/);
  assert.match(prompt, /return that candidate's summary unchanged/);
});

// A hand-classified sample of the corpus found only about 63% of Decisions were settled choices,
// the rest intentions and session narrative, and the same working-style preferences recurring
// across 11 topics. Each rule below answers one of those.
test("a decision is a settled outcome, and narrative and working-style preferences are not facts", () => {
  const prompt = buildExtractPrompt();

  assert.match(prompt, /decisions: settled outcomes only/);
  assert.match(prompt, /A plan, an intention or a pending item is not a decision/);
  assert.doesNotMatch(prompt, /"will /i, "an example that is an intention teaches intentions");
  assert.match(prompt, /record the durable fact itself/);
  assert.match(prompt, /those live in the user's CLAUDE\.md/);
});
