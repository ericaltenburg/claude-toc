import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createConfig } from "../../src/config.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const LOGGER_HOOK = join(REPO_ROOT, "hooks", "toc-logger.mjs");
export const SWEEP_HOOK = join(REPO_ROOT, "hooks", "toc-sweep.mjs");
export const EXTRACTOR = join(REPO_ROOT, "bin", "toc-extract");
export const SPEND_REPORT = join(REPO_ROOT, "bin", "toc-spend");

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
    CLAUDE_TOC_NODE: process.execPath,
    CLAUDE_TOC_CORPUS_DIR: config.corpusDir,
    CLAUDE_TOC_TRANSCRIPTS_DIR: config.transcriptsDir,
    CLAUDE_TOC_PROMPT_LOG: config.promptLog,
    ...extra,
  };
}

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

export function transcriptPath(config, sessionId, { projectDir = config.transcriptsDir } = {}) {
  return join(projectDir, `${sessionId}.jsonl`);
}

export function appendTranscript(config, sessionId, turns, options = {}) {
  const path = transcriptPath(config, sessionId, options);
  const lines = turns.map((turn) => transcriptRecord(turn, options));
  appendFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

function transcriptRecord({ role = "user", text, at }, { cwd = null, at: whenTheTurnsHappened } = {}) {
  const content = role === "user" ? aBareString(text) : textBlocks(text);
  const timestamp = at ?? whenTheTurnsHappened;
  return JSON.stringify({
    type: role,
    cwd,
    ...(timestamp ? { timestamp: new Date(timestamp).toISOString() } : {}),
    message: { content },
  });
}

const aBareString = (text) => text;
const textBlocks = (text) => [{ type: "text", text }];

export function writeTranscript(config, sessionId, turns, options = {}) {
  const path = transcriptPath(config, sessionId, options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return appendTranscript(config, sessionId, turns, options);
}

export function writeRawTranscript(config, sessionId, records, options = {}) {
  const path = transcriptPath(config, sessionId, options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
}

export function idleFor(path, ms) {
  const { atime } = statSync(path);
  utimesSync(path, atime, new Date(Date.now() - ms));
  return path;
}

export function fakeExtractor(config, { writesTo }) {
  const path = join(config.corpusDir, "fake-extractor.sh");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$PWD $*" >> "${writesTo}"\n`, { mode: 0o755 });
  return path;
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
