// The session index: one line per session the logger hook saw, written when its first prompt
// was submitted. It is the only record of a session's working directory and start once its
// transcript has rotated away, so this module owns its record shape, writing and reading both
// (ADR 0013).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import { parseJsonLine } from "../json-lines.js";

export function indexedSessions(config) {
  if (!existsSync(config.sessionIndexPath)) return null;
  return readFileSync(config.sessionIndexPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parsedOrNull)
    .filter(Boolean);
}

export function alreadyIndexed(config, sessionId) {
  return (
    existsSync(config.sessionIndexPath) &&
    readFileSync(config.sessionIndexPath, "utf-8").includes(sessionId)
  );
}

export function recordSession(config, { sessionId, transcript, project, started }) {
  mkdirSync(config.corpusDir, { recursive: true });
  appendFileSync(
    config.sessionIndexPath,
    JSON.stringify({
      session_id: sessionId,
      transcript: transcript ?? null,
      cwd: project ?? null,
      started: started ?? null,
    }) + "\n"
  );
}

export function parseSessionRecord(line) {
  const record = parseJsonLine(line);
  if (!record?.session_id) return null;

  return {
    sessionId: record.session_id,
    transcriptPath: record.transcript ?? null,
    project: record.cwd ?? null,
    startedAt: record.started ?? null,
  };
}

function parsedOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
