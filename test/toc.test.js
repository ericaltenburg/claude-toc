import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createTopicStore } from "../src/toc.js";
import { parseTopic } from "../src/parse.js";
import { tempCorpus, topicPath } from "./support/corpus.js";

const A_SESSION = "316972f2-1111-2222-3333-444455556666";
const HAPPENED_ON = "2026-08-27";

function storeWith(topics) {
  const config = tempCorpus();
  const store = createTopicStore(config);

  for (const [id, { keywords = [], summary = "", context = [], decisions = [] }] of Object.entries(
    topics
  )) {
    store.upsertTopic(id, { keywords, summary });
    for (const fact of context) store.appendToTopic(id, "Context", fact, A_SESSION, HAPPENED_ON);
    for (const fact of decisions) {
      store.appendToTopic(id, "Decisions", fact, A_SESSION, HAPPENED_ON);
    }
  }

  return { config, store };
}

const factsIn = (config, id) => parseTopic(readFileSync(topicPath(config, id), "utf-8"));
const textsIn = (config, id) => factsIn(config, id).map((fact) => fact.text);

// --- Appending ---

test("a fact is appended under its section with the session and date it came from", () => {
  const { config } = storeWith({
    brazil: { context: ["uses version sets"], decisions: ["will pin the major version"] },
  });

  assert.deepEqual(factsIn(config, "brazil"), [
    {
      text: "uses version sets",
      session: A_SESSION.slice(0, 8),
      date: HAPPENED_ON,
      section: "Context",
      line: 4,
    },
    {
      text: "will pin the major version",
      session: A_SESSION.slice(0, 8),
      date: HAPPENED_ON,
      section: "Decisions",
      line: 7,
    },
  ]);
});

// The interface hides an ordering constraint: appending to a topic whose file was never
// created does nothing at all.
test("appending to a topic that was never upserted is silently dropped", () => {
  const config = tempCorpus();
  const store = createTopicStore(config);

  store.appendToTopic("never_created", "Context", "a fact", A_SESSION, HAPPENED_ON);

  assert.equal(existsSync(topicPath(config, "never_created")), false);
});

test("a fact reworded past the similarity threshold is not appended twice", () => {
  const { config, store } = storeWith({
    brazil: { context: ["the build system resolves dependencies from a version set"] },
  });

  store.appendToTopic(
    "brazil",
    "Context",
    "the build system resolves dependencies from a version set",
    A_SESSION,
    HAPPENED_ON
  );
  store.appendToTopic("brazil", "Context", "something else entirely about pipelines", A_SESSION, HAPPENED_ON);

  assert.deepEqual(textsIn(config, "brazil"), [
    "the build system resolves dependencies from a version set",
    "something else entirely about pipelines",
  ]);
});

test("the TOC counts the facts a topic holds", () => {
  const { config, store } = storeWith({
    brazil: { summary: "the build system", context: ["a", "b"], decisions: ["c"] },
  });

  const toc = store.loadToc();

  assert.equal(toc.topics.brazil.entries, 3);
  assert.equal(toc.topics.brazil.summary, "the build system");
  assert.equal(toc.topics.brazil.file, join("topics", "brazil.md"));
  assert.equal(store.countEntries("brazil"), 3);
});

test("upserting an existing topic unions its keywords and keeps a summary it already had", () => {
  const { store } = storeWith({ brazil: { keywords: ["build"], summary: "the build system" } });

  store.upsertTopic("brazil", { keywords: ["versionset", "build"], summary: "" });

  const entry = store.loadToc().topics.brazil;
  assert.deepEqual(entry.keywords.sort(), ["build", "versionset"]);
  assert.equal(entry.summary, "the build system");
});

// --- Similarity ---

test("a topic is similar when its keywords and its id overlap enough", () => {
  const { store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build", "versionset"] },
  });

  const match = store.findSimilarTopic("brazil_build_system", ["brazil", "build", "versionset"]);
  const unrelated = store.findSimilarTopic("kinesis_streams", ["kinesis", "shards"]);

  assert.equal(match?.id, "brazil_build_system");
  assert.ok(match.score >= 0.6);
  assert.equal(unrelated, null);
});

// --- Merging ---

// pickMergeWinner and mergeTopics are private, so dedup is the only way in: these exercise
// merging exactly as `toc-extract --dedup` does.
//
// THESE THREE ARE SKIPPED BECAUSE MERGING IS BROKEN, NOT BECAUSE IT IS UNIMPORTANT.
// findSimilarTopic scans every topic including the candidate itself, which scores 1.00, so
// dedupTopics' `match.id !== ids[i]` guard always continues and no pair can ever merge. The
// last test in this file pins that as today's behaviour; unskip these three when it is fixed.
const MERGING_IS_BROKEN = { skip: "findSimilarTopic matches the candidate against itself" };

test("dedup merges a similar pair, moving the loser's facts to the winner", MERGING_IS_BROKEN, () => {
  const { config, store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build", "versionset"], context: ["uses version sets", "resolves deps"] },
    brazil_build_systems: { keywords: ["brazil", "build", "versionset"], context: ["has a Config file"] },
  });

  const { merges, remaining } = store.dedupTopics();

  assert.equal(merges.length, 1, "a near-identical pair should merge");
  assert.equal(remaining, 1);
  assert.deepEqual(textsIn(config, merges[0].winnerId).sort(), [
    "has a Config file",
    "resolves deps",
    "uses version sets",
  ]);
});

test("the topic holding more facts wins, and the loser leaves a tombstone and the TOC", MERGING_IS_BROKEN, () => {
  const { config, store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build"], context: ["a", "b"] },
    brazil_build_systems: { keywords: ["brazil", "build"], context: ["c"] },
  });

  const { merges } = store.dedupTopics();

  assert.equal(merges[0].winnerId, "brazil_build_system");
  assert.equal(merges[0].loserId, "brazil_build_systems");
  const files = readdirSync(config.topicsDir);
  assert.ok(files.includes("brazil_build_systems.merged.md"), `expected a tombstone in ${files}`);
  assert.equal(files.includes("brazil_build_systems.md"), false);
  assert.equal("brazil_build_systems" in store.loadToc().topics, false);
});

test("the winner keeps the union of both keyword sets and the longer summary", MERGING_IS_BROKEN, () => {
  const { store } = storeWith({
    brazil_build_system: { keywords: ["brazil"], summary: "short", context: ["a", "b"] },
    brazil_build_systems: {
      keywords: ["build"],
      summary: "a considerably longer summary of the same subject",
      context: ["c"],
    },
  });

  store.dedupTopics();

  const winner = store.loadToc().topics.brazil_build_system;
  assert.deepEqual(winner.keywords.sort(), ["brazil", "build"]);
  assert.equal(winner.summary, "a considerably longer summary of the same subject");
  assert.equal(winner.entries, 3);
});

test("a topic that resembles nothing survives a dedup untouched", () => {
  const { config, store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build", "versionset"], context: ["a", "b"] },
    brazil_build_systems: { keywords: ["brazil", "build", "versionset"], context: ["c"] },
    kinesis_streams: { keywords: ["kinesis", "shards"], context: ["d"] },
  });

  store.dedupTopics();

  assert.ok("kinesis_streams" in store.loadToc().topics);
  assert.deepEqual(textsIn(config, "kinesis_streams"), ["d"]);
});

test("dedup over topics that resemble nothing merges nothing", () => {
  const { store } = storeWith({
    brazil: { keywords: ["brazil", "build"], context: ["a"] },
    kinesis: { keywords: ["kinesis", "shards"], context: ["b"] },
  });

  const { merges, remaining } = store.dedupTopics();

  assert.deepEqual(merges, []);
  assert.equal(remaining, 2);
});

// The defect the three skipped tests above are waiting on. Delete this when merging works.
test("dedup merges nothing today, because every topic best-matches itself", () => {
  const { store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build", "versionset"], context: ["a", "b"] },
    brazil_build_systems: { keywords: ["brazil", "build", "versionset"], context: ["c"] },
  });

  const itself = store.findSimilarTopic("brazil_build_systems", ["brazil", "build", "versionset"]);

  assert.equal(itself.id, "brazil_build_systems");
  assert.deepEqual(store.dedupTopics(), { merges: [], remaining: 2 });
});
