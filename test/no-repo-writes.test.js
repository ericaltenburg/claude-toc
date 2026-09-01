import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTopicStore } from "../src/toc.js";
import { createStateStore } from "../src/state.js";
import { openIndex } from "../src/search-index.js";
import {
  tempCorpus,
  runNode,
  runCli,
  sessionPayload,
  writeTranscript,
  REPO_ROOT,
  LOGGER_HOOK,
  SWEEP_HOOK,
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

  runNode(LOGGER_HOOK, { input: sessionPayload(config), config });
  runNode(SWEEP_HOOK, { input: sessionPayload(config), config });
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

test("the extractor lists sessions without writing anything", () => {
  const config = tempCorpus();
  const before = repoStatus();

  const transcript = writeTranscript(config, "aaaaaaaa-1111-2222-3333-444455556666", [
    { role: "user", text: "what did we decide about broadcast variants?" },
  ]);
  runNode(LOGGER_HOOK, {
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
