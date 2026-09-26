import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTopicStore } from "../src/corpus/topics.js";
import { bedrockBilledToOurOwnProfile, createExtractor } from "../src/extract/extractor.js";
import { createExtractionLock } from "../src/extract/lock.js";
import { createSpendLog } from "../src/extract/spend.js";
import { openIndex } from "../src/index/open.js";
import { createSearch } from "../src/search/search.js";
import { createStateStore } from "../src/sessions/progress.js";
import { recordSession } from "../src/sessions/registry.js";
import {
  tempCorpus,
  runNode,
  runCli,
  sessionPayload,
  writeTranscript,
  REPO_ROOT,
  PROMPT_HOOK,
  EXTRACTOR,
  SPEND_REPORT,
  STATUS_REPORT,
} from "./support/corpus.js";

function repoStatus() {
  return execFileSync("git", ["status", "--porcelain", "--ignored"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
}

test("every write lands in the configured corpus and none in the repository", () => {
  const before = repoStatus();
  const config = tempCorpus();
  const session = "316972f2-1111-2222-3333-444455556666";

  const topics = createTopicStore(config);
  topics.upsertTopic("alcs_broadcast_variants", {
    keywords: ["broadcast", "variant"],
    summary: "how broadcast variants are stored",
  });
  topics.appendToTopic(
    "alcs_broadcast_variants",
    "Context",
    "Variants are keyed by show id",
    session
  );
  topics.appendToTopic(
    "alcs_broadcast_variants",
    "Decisions",
    "Will store variants in DynamoDB",
    session
  );
  createStateStore(config).recordExtraction(session);

  const index = openIndex(config);
  index.refresh();
  index.close();

  runNode(PROMPT_HOOK, { input: sessionPayload(config), config });
  for (const args of [[], ["--dedup"], ["--sweep"], ["nosuchsession"]]) {
    const result = runCli(EXTRACTOR, { args, config });
    assert.equal(result.stderr, "", `toc-extract ${args.join(" ")}`);
  }
  assert.equal(runCli(SPEND_REPORT, { config }).stderr, "");
  assert.equal(runCli(STATUS_REPORT, { config }).stderr, "");

  assert.ok(existsSync(join(config.topicsDir, "alcs_broadcast_variants.md")));
  assert.ok(existsSync(config.tocPath));
  assert.ok(existsSync(config.statePath));
  assert.ok(existsSync(config.indexPath));
  assert.ok(readFileSync(config.sessionIndexPath, "utf-8").includes("aaaaaaaa"));

  assert.equal(repoStatus(), before);
  assert.equal(existsSync(join(REPO_ROOT, "memory")), false);
});

// ADR 0018. The layout is spelled out here rather than read back from the config, so that
// moving a path in config.js without meaning to fails this test.
test("a first run from an empty root files each write under corpus, ledger or cache", () => {
  const config = tempCorpus();
  rmSync(config.corpusDir, { recursive: true });
  const session = "316972f2-1111-2222-3333-444455556666";
  const transcript = writeTranscript(config, session, [
    { role: "user", text: "where do broadcast variants live?" },
    { role: "assistant", text: "in dynamodb, keyed by show id" },
  ]);

  runNode(LOGGER_HOOK, {
    input: sessionPayload(config, { session_id: session, transcript_path: transcript }),
    config,
  });
  const lock = createExtractionLock(config);
  assert.ok(lock.acquire(session));
  const extractor = createExtractor(config, {
    callModel: bedrockBilledToOurOwnProfile(config, { run: bedrockAnswering(ONE_FACT) }),
  });
  const extracted = extractor.extractSession({ session_id: session, transcript, cwd: "/work/alcs" });
  extractor.close();
  const search = createSearch(config);
  search.search({ query: "broadcast variants" });
  search.close();

  assert.equal(extracted.status, "extracted");
  assert.deepEqual(readdirSync(config.corpusDir, { recursive: true }).sort(), [
    "cache",
    "cache/extraction.lock",
    "cache/extractor",
    "cache/index.db",
    "corpus",
    "corpus/toc.json",
    "corpus/topics",
    "corpus/topics/alcs_broadcast_variants.md",
    "ledger",
    "ledger/search.log",
    "ledger/sessions.jsonl",
    "ledger/spend.jsonl",
    "ledger/state.json",
  ]);
  lock.release(session);
});

// In one run the first writer into a group creates its directory for the rest, so each
// writer is checked alone: one that created some other directory would lose its file.
test("each writer creates its own file's directory in an empty root", () => {
  const writers = {
    "corpus/toc.json": (config) => createTopicStore(config).upsertTopic("alcs"),
    "ledger/state.json": (config) => createStateStore(config).recordExtraction("s"),
    "ledger/sessions.jsonl": (config) => recordSession(config, { sessionId: "s" }),
    "ledger/spend.jsonl": (config) => createSpendLog(config).record({ model: "m" }),
    "ledger/search.log": (config) => {
      const search = createSearch(config);
      search.search({ query: "anything" });
      search.close();
    },
    "cache/index.db": (config) => openIndex(config).close(),
    "cache/extraction.lock": (config) => createExtractionLock(config).acquire("h"),
  };

  for (const [file, write] of Object.entries(writers)) {
    const config = tempCorpus();
    rmSync(config.corpusDir, { recursive: true });
    write(config);
    assert.ok(existsSync(join(config.corpusDir, file)), file);
  }
});

const ONE_FACT = {
  topic: { id: "alcs_broadcast_variants", keywords: ["broadcast"], summary: "where variants live" },
  context: ["Broadcast variants are keyed by show id"],
  decisions: [],
};

// Stands in for `aws bedrock-runtime invoke-model`, which writes its answer to the path it is
// given last.
function bedrockAnswering(output) {
  return (_aws, args) =>
    writeFileSync(
      args.at(-1),
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(output) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 100 },
      })
    );
}

test("the extractor lists sessions without writing anything", () => {
  const config = tempCorpus();
  const before = repoStatus();

  const transcript = writeTranscript(config, "aaaaaaaa-1111-2222-3333-444455556666", [
    { role: "user", text: "what did we decide about broadcast variants?" },
  ]);
  runNode(PROMPT_HOOK, {
    input: sessionPayload(config, { transcript_path: transcript }),
    config,
  });
  const listing = runCli(EXTRACTOR, { args: [], config });

  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /1 total, 1 unextracted/);
  assert.match(listing.stdout, /aaaaaaaa.*pending/);
  assert.equal(repoStatus(), before);
});

test("only the config module knows where the corpus is", () => {
  // A path segment reaches join() as an argument; "topics" alone is free to be a display label.
  const forbidden =
    /homedir\(|import\.meta\.dirname|__dirname|toc\.json|sessions\.jsonl|state\.json|processed\.json|history\.jsonl|topics\/|,\s*"topics"|"memory"/;

  const offenders = [];
  for (const relative of trackedSources()) {
    if (relative === "src/config.js") continue;
    const code = stripComments(readFileSync(join(REPO_ROOT, relative), "utf-8"));
    if (forbidden.test(code)) offenders.push(relative);
  }

  assert.deepEqual(offenders, []);
});

test("the removed push-injection code is gone", () => {
  for (const gone of [
    join(REPO_ROOT, "hooks", "toc-inject.cjs"),
    join(REPO_ROOT, "hooks", "toc-logger.cjs"),
    join(REPO_ROOT, "hooks", "toc-auto-analyze.cjs"),
    join(REPO_ROOT, "hooks", "toc-auto-analyze.mjs"),
    join(REPO_ROOT, "src", "read-session.js"),
    join(REPO_ROOT, "src", "analyze.js"),
  ]) {
    assert.equal(existsSync(gone), false, `${gone} should be deleted`);
  }

  assert.deepEqual(grepSources("additionalContext"), []);
  assert.deepEqual(grepSources("resolveAllTopics"), []);
});

function trackedSources() {
  return execFileSync("git", ["ls-files", "src", "hooks"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
}

function grepSources(pattern) {
  try {
    return execFileSync("git", ["grep", "-l", pattern, "--", "src", "hooks"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}
