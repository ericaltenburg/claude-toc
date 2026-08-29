import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../src/config.js";
import { createTopicStore } from "../src/toc.js";
import { createStateStore } from "../src/state.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const HOOKS = [
  join(REPO_ROOT, "hooks", "toc-logger.mjs"),
  join(REPO_ROOT, "hooks", "toc-auto-analyze.mjs"),
];

function tempCorpus() {
  const root = mkdtempSync(join(tmpdir(), "claude-toc-repo-"));
  const corpusDir = join(root, "corpus");
  const transcriptsDir = join(root, "projects");
  const promptLog = join(root, "history.jsonl");
  mkdirSync(corpusDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });
  writeFileSync(promptLog, "");
  return { root, config: createConfig({ corpusDir, transcriptsDir, promptLog }, {}) };
}

function hookEnv(config) {
  return {
    ...process.env,
    CLAUDE_TOC_CORPUS_DIR: config.corpusDir,
    CLAUDE_TOC_TRANSCRIPTS_DIR: config.transcriptsDir,
    CLAUDE_TOC_PROMPT_LOG: config.promptLog,
  };
}

function runHook(hook, payload, config) {
  return execFileSync("node", [hook], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    env: hookEnv(config),
    timeout: 20_000,
  });
}

function repoStatus() {
  return execFileSync("git", ["status", "--porcelain", "--ignored"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
}

test("every write lands in the configured corpus and none in the repository", () => {
  const before = repoStatus();
  const { config } = tempCorpus();

  const topics = createTopicStore(config);
  topics.upsertTopic("alcs_broadcast_variants", {
    keywords: ["broadcast", "variant"],
    summary: "how broadcast variants are stored",
  });
  topics.appendToTopic(
    "alcs_broadcast_variants",
    "Context",
    "Variants are keyed by show id",
    "316972f2-1111-2222-3333-444455556666"
  );
  topics.appendToTopic(
    "alcs_broadcast_variants",
    "Decisions",
    "Will store variants in DynamoDB",
    "316972f2-1111-2222-3333-444455556666"
  );

  createStateStore(config).markProcessed("316972f2-1111-2222-3333-444455556666", null);

  for (const hook of HOOKS) {
    runHook(
      hook,
      {
        session_id: "aaaaaaaa-1111-2222-3333-444455556666",
        transcript_path: join(config.transcriptsDir, "missing.jsonl"),
        cwd: "/some/project",
        prompt: "what did we decide about broadcast variants?",
      },
      config
    );
  }

  // the work actually happened, in the temporary corpus
  assert.ok(existsSync(join(config.topicsDir, "alcs_broadcast_variants.md")));
  assert.ok(existsSync(config.tocPath));
  assert.ok(existsSync(config.statePath));
  assert.ok(readFileSync(config.sessionIndexPath, "utf-8").includes("aaaaaaaa"));

  // and nothing appeared in the repository, tracked or ignored
  assert.equal(repoStatus(), before);
  assert.equal(existsSync(join(REPO_ROOT, "memory")), false);
});

test("only the config module knows where the corpus is", () => {
  // Any module that names a corpus artifact, reads the home directory, or joins
  // its own file location into a data path has a second source of truth.
  const forbidden =
    /homedir\(|import\.meta\.dirname|__dirname|toc\.json|sessions\.jsonl|state\.json|processed\.json|history\.jsonl|"topics"|"memory"/;

  const offenders = [];
  for (const relative of trackedSources()) {
    if (relative === "src/config.js") continue; // the one place allowed to know
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
    join(REPO_ROOT, "src", "read-session.js"),
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
    if (err.status === 1) return []; // git grep exits 1 when nothing matches
    throw err;
  }
}
