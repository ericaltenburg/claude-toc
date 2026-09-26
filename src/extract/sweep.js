import { knownSessions, knownSessionsBeforeOpening } from "../sessions/known-sessions.js";

export const SESSION_IS_IDLE_AFTER_MS = 60 * 60_000;
export const SESSIONS_PER_SWEEP = 3;

// --- Choosing what to sweep ---

// A sweep reads the one list of known sessions and takes the waiting ones: idle long enough to
// be finished with, carrying turns extraction has not read, and not quarantined. The list comes
// newest first, so today's work is searchable today and the tail drains behind it (ADR 0010).
export function createSweeper(
  config,
  state,
  {
    idleAfterMs = SESSION_IS_IDLE_AFTER_MS,
    sessionsPerSweep = SESSIONS_PER_SWEEP,
    now = () => Date.now(),
  } = {}
) {
  // The cheap half, for the hook: no transcript is opened.
  function idleSessions() {
    const recorded = state.snapshot();
    return knownSessionsBeforeOpening(config, recorded).filter((known) =>
      isReadyToExtract(known, recorded)
    );
  }

  // Lazy on purpose: opening each transcript costs a read, and a sweep wants only a few.
  function waitingSessionsNewestFirst() {
    const recorded = state.snapshot();
    return knownSessions(config, {
      recorded,
      where: (known) => isReadyToExtract(known, recorded),
    });
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

  // A session known only from the session index, its transcript rotated away, has nothing
  // left to read.
  function isReadyToExtract({ session_id: sessionId, modified, size }, recorded) {
    if (!Number.isFinite(modified)) return false;
    if (recorded.isQuarantined(sessionId)) return false;
    if (!recorded.hasUnreadTurns(sessionId, size)) return false;
    return now() - modified >= idleAfterMs;
  }

  return { candidates, idleSessions, waitingSessions };
}
