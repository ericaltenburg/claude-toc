import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { howTheTranscriptOpens } from "./transcript.js";

export const SESSION_IS_IDLE_AFTER_MS = 60 * 60_000;
export const SESSIONS_PER_SWEEP = 3;

const TRANSCRIPT_SUFFIX = ".jsonl";

const A_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Choosing what to sweep ---

export function createSweeper(
  config,
  state,
  {
    idleAfterMs = SESSION_IS_IDLE_AFTER_MS,
    sessionsPerSweep = SESSIONS_PER_SWEEP,
    now = () => Date.now(),
  } = {}
) {
  function idleSessions() {
    const recorded = state.snapshot();
    return transcriptsOnDisk()
      .filter((transcript) => isReadyToExtract(transcript, recorded))
      .sort((a, b) => b.modified - a.modified);
  }

  // Lazy on purpose: opening each transcript costs a read, and a sweep wants only a few.
  function* waitingSessionsNewestFirst() {
    for (const transcript of idleSessions()) {
      const opening = howTheTranscriptOpens(transcript.path);
      if (opening.isTheExtractionPrompt) continue;
      yield {
        session_id: transcript.sessionId,
        transcript: transcript.path,
        cwd: opening.cwd,
      };
    }
  }

  function waitingSessions() {
    return [...waitingSessionsNewestFirst()];
  }

  function candidates() {
    const chosen = [];
    for (const waiting of waitingSessionsNewestFirst()) {
      if (chosen.length === sessionsPerSweep) break;
      chosen.push(waiting);
    }
    return chosen;
  }

  function isReadyToExtract({ sessionId, path, modified, size }, recorded) {
    if (isTheExtractorsOwnSession(sessionId, path, recorded)) return false;
    if (recorded.isQuarantined(sessionId)) return false;
    if (!recorded.hasUnreadTurns(sessionId, size)) return false;
    return now() - modified >= idleAfterMs;
  }

  function isTheExtractorsOwnSession(sessionId, path, recorded) {
    return recorded.isExtractorSession(sessionId) || path.startsWith(config.extractorTranscriptsDir);
  }

  function transcriptsOnDisk() {
    if (!existsSync(config.transcriptsDir)) return [];

    const transcripts = [];
    for (const entry of readdirSync(config.transcriptsDir, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_SUFFIX)) continue;
      const sessionId = entry.name.slice(0, -TRANSCRIPT_SUFFIX.length);
      if (!A_SESSION_ID.test(sessionId)) continue;

      const path = join(entry.parentPath, entry.name);
      const stats = statOrNull(path);
      if (!stats) continue;
      transcripts.push({
        sessionId,
        path,
        modified: stats.mtimeMs,
        size: stats.size,
      });
    }
    return transcripts;
  }

  return { candidates, idleSessions, waitingSessions };
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

