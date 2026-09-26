import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../src/config.js";
import { createTopicStore } from "../src/toc.js";
import { parseTopic } from "../src/parse.js";
import { EXTRACTOR, runCli, tempCorpus, topicPath } from "./support/corpus.js";

const A_SESSION = "316972f2-1111-2222-3333-444455556666";
const HAPPENED_ON = "2026-08-27";
const ANOTHER_SESSION = "9b1e4c07-aaaa-bbbb-cccc-ddddeeeeffff";
const AN_EARLIER_DAY = "2026-07-14";

function storeWith(topics, config = tempCorpus()) {
  const store = createTopicStore(config);

  for (const [
    id,
    { keywords = [], summary = "", context = [], decisions = [], session = A_SESSION, date = HAPPENED_ON },
  ] of Object.entries(topics)) {
    store.upsertTopic(id, { keywords, summary });
    for (const fact of context) store.appendToTopic(id, "Context", fact, session, date);
    for (const fact of decisions) store.appendToTopic(id, "Decisions", fact, session, date);
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

  const match = store.findSimilarTopic("brazil_build_systems", ["brazil", "build", "versionset"]);
  const unrelated = store.findSimilarTopic("kinesis_streams", ["kinesis", "shards"]);

  assert.equal(match?.id, "brazil_build_system");
  assert.ok(match.score >= 0.6);
  assert.equal(unrelated, null);
});

// --- Merging ---

// pickMergeWinner and mergeTopics are private, so dedup is the only way in: these exercise
// merging exactly as `toc-extract --dedup` does.

test("dedup merges a similar pair, moving the loser's facts to the winner", () => {
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

test("the topic holding more facts wins, and the loser leaves a tombstone and the TOC", () => {
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

// The keyword sets overlap without being equal, because a pair has to clear the similarity
// threshold before there is any union to keep: keywords carry 0.7 of the score, so two topics
// sharing no keyword score 0.15 on their ids alone and never meet.
test("the winner keeps the union of both keyword sets and the longer summary", () => {
  const { store } = storeWith({
    brazil_build_system: {
      keywords: ["brazil", "build", "versionset"],
      summary: "short",
      context: ["a", "b"],
    },
    brazil_build_systems: {
      keywords: ["brazil", "build", "versionset", "config"],
      summary: "a considerably longer summary of the same subject",
      context: ["c"],
    },
  });

  store.dedupTopics();

  const winner = store.loadToc().topics.brazil_build_system;
  assert.deepEqual(winner.keywords.sort(), ["brazil", "build", "config", "versionset"]);
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

// A fact's session and date are its provenance (ADR 0013), so a merge that restamped them
// would corrupt the corpus while looking like it tidied it.
test("the facts a merge moves keep their own session and date, and a second dedup changes nothing", () => {
  const { config, store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build", "versionset"], context: ["a", "b"] },
    brazil_build_systems: {
      keywords: ["brazil", "build", "versionset"],
      context: ["has a Config file"],
      session: ANOTHER_SESSION,
      date: AN_EARLIER_DAY,
    },
  });

  store.dedupTopics({ apply: true });
  const winnerFile = readFileSync(topicPath(config, "brazil_build_system"), "utf-8");
  const toc = store.loadToc();
  const again = store.dedupTopics({ apply: true });

  const moved = parseTopic(winnerFile).find((fact) => fact.text === "has a Config file");
  assert.equal(moved.session, ANOTHER_SESSION.slice(0, 8));
  assert.equal(moved.date, AN_EARLIER_DAY);
  assert.deepEqual(again.merges, []);
  assert.equal(readFileSync(topicPath(config, "brazil_build_system"), "utf-8"), winnerFile);
  assert.deepEqual(store.loadToc(), toc);
});

test("a tombstone renames the topic file's own extension, not an earlier .md in its path", () => {
  const underADotMdDirectory = createConfig(
    { corpusDir: join(mkdtempSync(join(tmpdir(), "claude-toc-")), "notes.md") },
    {}
  );
  const { config, store } = storeWith(
    {
      brazil_build_system: { keywords: ["brazil", "build"], context: ["a", "b"] },
      brazil_build_systems: { keywords: ["brazil", "build"], context: ["c"] },
    },
    underADotMdDirectory
  );

  store.dedupTopics({ apply: true });

  assert.deepEqual(readdirSync(config.topicsDir).sort(), [
    "brazil_build_system.md",
    "brazil_build_systems.merged.md",
  ]);
});

// The corpus has no backup (ADR 0001), so the command that merges it only says what it would
// do until it is told otherwise.
test("toc-extract --dedup prints the plan and changes nothing, and --apply carries it out", () => {
  const { config, store } = storeWith({
    brazil_build_system: { keywords: ["brazil", "build", "versionset"], context: ["a", "b"] },
    brazil_build_systems: { keywords: ["brazil", "build", "versionset"], context: ["c"] },
  });
  const topicFiles = readdirSync(config.topicsDir).sort();

  const plan = runCli(EXTRACTOR, { args: ["--dedup"], config });

  assert.equal(plan.stderr, "");
  assert.match(plan.stdout, /brazil_build_systems into brazil_build_system \(score: 0\.85\)/);
  assert.match(plan.stdout, /rerun with --apply/i);
  assert.deepEqual(readdirSync(config.topicsDir).sort(), topicFiles);
  assert.equal(Object.keys(store.loadToc().topics).length, 2);

  const applied = runCli(EXTRACTOR, { args: ["--dedup", "--apply"], config });

  assert.equal(applied.stderr, "");
  assert.match(applied.stdout, /Merged brazil_build_systems into brazil_build_system/);
  assert.deepEqual(Object.keys(store.loadToc().topics), ["brazil_build_system"]);
});
