import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

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

function parsedOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
