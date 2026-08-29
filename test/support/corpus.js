// Seam 1 in test form: a corpus in a temporary directory, and the env that
// points a subprocess at it. Shared by every test that needs one.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../../src/config.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const LOGGER_HOOK = join(REPO_ROOT, "hooks", "toc-logger.mjs");
export const EXTRACT_HOOK = join(REPO_ROOT, "hooks", "toc-extract.mjs");
export const EXTRACTOR = join(REPO_ROOT, "src", "extract.js");

/** A config pointed at an empty corpus under the OS temp directory. */
export function tempCorpus() {
  const root = mkdtempSync(join(tmpdir(), "claude-toc-"));
  const config = createConfig(
    {
      corpusDir: join(root, "corpus"),
      transcriptsDir: join(root, "projects"),
      promptLog: join(root, "history.jsonl"),
    },
    {}
  );
  mkdirSync(config.corpusDir, { recursive: true });
  mkdirSync(config.transcriptsDir, { recursive: true });
  writeFileSync(config.promptLog, "");
  return config;
}

/** The environment a hook or the extractor needs to use that corpus. */
export function corpusEnv(config, extra = {}) {
  return {
    ...process.env,
    CLAUDE_TOC_CORPUS_DIR: config.corpusDir,
    CLAUDE_TOC_TRANSCRIPTS_DIR: config.transcriptsDir,
    CLAUDE_TOC_PROMPT_LOG: config.promptLog,
    ...extra,
  };
}

/** Runs a hook or entry point as a real subprocess, as Claude Code would. */
export function runNode(script, { input = "", args = [], config, env = {} } = {}) {
  return spawnSync("node", [script, ...args], {
    input,
    encoding: "utf-8",
    timeout: 20_000,
    env: corpusEnv(config, env),
  });
}

export function sessionPayload(config, overrides = {}) {
  return JSON.stringify({
    session_id: "aaaaaaaa-1111-2222-3333-444455556666",
    transcript_path: join(config.transcriptsDir, "missing.jsonl"),
    cwd: "/some/project",
    prompt: "what did we decide about broadcast variants?",
    ...overrides,
  });
}
