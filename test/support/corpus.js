import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../../src/config.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const LOGGER_HOOK = join(REPO_ROOT, "hooks", "toc-logger.mjs");
export const EXTRACT_HOOK = join(REPO_ROOT, "hooks", "toc-extract.mjs");
export const EXTRACTOR = join(REPO_ROOT, "src", "extract.js");

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

export function corpusEnv(config, extra = {}) {
  return {
    ...process.env,
    CLAUDE_TOC_CORPUS_DIR: config.corpusDir,
    CLAUDE_TOC_TRANSCRIPTS_DIR: config.transcriptsDir,
    CLAUDE_TOC_PROMPT_LOG: config.promptLog,
    ...extra,
  };
}

export function runNode(script, { input = "", args = [], config, env = {} } = {}) {
  return spawnSync("node", [script, ...args], {
    input,
    encoding: "utf-8",
    timeout: 20_000,
    env: corpusEnv(config, env),
  });
}

// Writes a synthetic topic file. Facts are given as whole markdown lines so a
// test can exercise an exact historical format.
export function writeTopic(config, id, sections) {
  mkdirSync(config.topicsDir, { recursive: true });
  const body = Object.entries(sections)
    .map(([section, facts]) => `## ${section}\n${facts.join("\n")}\n`)
    .join("\n");
  writeFileSync(join(config.topicsDir, `${id}.md`), `# ${id.replace(/_/g, " ")}\n\n${body}`);
}

export function topicPath(config, id) {
  return join(config.topicsDir, `${id}.md`);
}

export function appendPrompts(config, records) {
  const lines = records.map((record) =>
    typeof record === "string" ? record : JSON.stringify(promptRecord(record))
  );
  appendFileSync(config.promptLog, lines.map((line) => `${line}\n`).join(""));
}

export function promptRecord({
  display = "what did we decide about broadcast variants?",
  timestamp = Date.parse("2026-08-27T15:00:00Z"),
  project = "/some/project",
  sessionId = "4cc461d6-2d88-4426-966c-ba2081ca75bb",
} = {}) {
  return { display, pastedContents: {}, timestamp, project, sessionId };
}

export function appendSessions(config, records) {
  appendFileSync(
    config.sessionIndexPath,
    records.map((record) => `${JSON.stringify(record)}\n`).join("")
  );
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
