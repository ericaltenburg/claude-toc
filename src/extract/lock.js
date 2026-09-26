import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";

import { CALL_TIMEOUT_MS } from "./bedrock.js";

// A holder renews before every model call and a call is killed at its timeout, so a live
// holder never goes longer than one call and the work between two without renewing. Twice
// a call covers that with room to spare, and a lock older than it belongs to a process that
// died. ADR 0016 records why a fixed lease stopped being enough.
export const EXTRACTION_LOCK_IS_STALE_AFTER_MS = 2 * CALL_TIMEOUT_MS;

// The extraction lease, held as a file created exclusively: O_EXCL makes taking it atomic,
// and its modification time is its last renewal. It sits beside state.json rather than in it
// because state.json records what extraction has done, and this is who is doing it now.
export function createExtractionLock(config) {
  const path = config.extractionLockPath;

  function acquire(holder) {
    if (created(holder)) return true;
    if (!isStale()) return false;
    // ponytail: two takers that both find the lock stale can both remove it, the second
    // removing the first's fresh lock, and then both extract. That takes a dead holder and
    // two prompts inside the same moment; stealing by rename would close it if it ever bites.
    rmSync(path, { force: true });
    return created(holder);
  }

  function created(holder) {
    mkdirSync(config.corpusDir, { recursive: true });
    const lock = { holder, startedAt: new Date().toISOString(), pid: process.pid };
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  }

  // Judged by the modification time alone: a lock its taker has created but not yet written
  // reads as empty, and treating that as stale would steal a lock seconds old.
  function isStale() {
    try {
      return statSync(path).mtimeMs + EXTRACTION_LOCK_IS_STALE_AFTER_MS <= Date.now();
    } catch {
      return true;
    }
  }

  function held() {
    try {
      const { mtimeMs } = statSync(path);
      const { holder, startedAt, pid } = JSON.parse(readFileSync(path, "utf-8"));
      return { holder, startedAt, pid, expiresAt: mtimeMs + EXTRACTION_LOCK_IS_STALE_AFTER_MS };
    } catch {
      return null;
    }
  }

  function isHeldBy(holder) {
    return Boolean(holder) && held()?.holder === holder;
  }

  function renew(holder) {
    if (!isHeldBy(holder)) return;
    const now = new Date();
    utimesSync(path, now, now);
  }

  function release(holder) {
    if (isHeldBy(holder)) rmSync(path, { force: true });
  }

  return { acquire, renew, release, held };
}
