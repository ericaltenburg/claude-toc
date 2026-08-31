import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfig } from "../../src/config.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const LOGGER_HOOK = join(REPO_ROOT, "hooks", "toc-logger.mjs");
export const EXTRACT_HOOK = join(REPO_ROOT, "hooks", "toc-extract.mjs");
export const EXTRACTOR = join(REPO_ROOT, "bin", "toc-extract");

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
    // The node on PATH may predate built-in sqlite; the one running the tests does not.
    CLAUDE_TOC_NODE: process.execPath,
    CLAUDE_TOC_CORPUS_DIR: config.corpusDir,
    CLAUDE_TOC_TRANSCRIPTS_DIR: config.transcriptsDir,
    CLAUDE_TOC_PROMPT_LOG: config.promptLog,
    ...extra,
  };
}

// A command that resolves node itself, as the hooks and the shipped wrappers do.
export function runCli(command, { input = "", args = [], config, env = {} } = {}) {
  return spawnSync(command, args, {
    input,
    encoding: "utf-8",
    timeout: 20_000,
    env: corpusEnv(config, env),
  });
}

export function runNode(script, { args = [], ...options } = {}) {
  return runCli("node", { ...options, args: [script, ...args] });
}

export const LATE_ON_26_AUGUST_IN_NEW_YORK = Date.parse("2026-08-27T03:30:00Z");
export const AFTERNOON_ON_27_AUGUST_IN_NEW_YORK = Date.parse("2026-08-27T15:00:00Z");

export function writeTopic(config, id, wholeFactLinesBySection) {
  mkdirSync(config.topicsDir, { recursive: true });
  const body = Object.entries(wholeFactLinesBySection)
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

export function transcriptPath(config, sessionId) {
  return join(config.transcriptsDir, `${sessionId}.jsonl`);
}

// Claude Code's transcript shape: a user turn is a bare string, an assistant turn is blocks.
export function appendTranscript(config, sessionId, turns) {
  const lines = turns.map(({ role = "user", text }) =>
    JSON.stringify({
      type: role,
      message: { content: role === "user" ? text : [{ type: "text", text }] },
    })
  );
  appendFileSync(transcriptPath(config, sessionId), lines.map((line) => `${line}\n`).join(""));
  return transcriptPath(config, sessionId);
}

export function writeTranscript(config, sessionId, turns) {
  writeFileSync(transcriptPath(config, sessionId), "");
  return appendTranscript(config, sessionId, turns);
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
