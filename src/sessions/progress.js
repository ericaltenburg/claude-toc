import { readFileSync, mkdirSync, existsSync } from "fs";

import { writeFileAtomically } from "../write-atomically.js";

const STATE_VERSION = 1;
export const SWEEP_DEBOUNCE_MS = 60_000;
export const ATTEMPTS_BEFORE_QUARANTINE = 3;
export const START_OF_TRANSCRIPT = 0;

export function transcriptHasUnreadTurns(size, offset) {
  return size !== offset;
}

const EMPTY = () => ({
  version: STATE_VERSION,
  processed: {},
  offsets: {},
  failures: {},
  quarantined: {},
  extractorSessions: {},
  sweptAt: null,
});

export function createStateStore(
  config,
  { debounceMs = SWEEP_DEBOUNCE_MS, attemptsBeforeQuarantine = ATTEMPTS_BEFORE_QUARANTINE } = {}
) {
  // A state file written before ADR 0016 still carries an `extraction` lease. Only the fields
  // named here are read, so it is dropped on load and gone after the next save.
  function load() {
    if (existsSync(config.statePath)) {
      try {
        const state = JSON.parse(readFileSync(config.statePath, "utf-8"));
        return {
          version: state.version ?? STATE_VERSION,
          processed: state.processed ?? {},
          offsets: state.offsets ?? {},
          failures: state.failures ?? {},
          quarantined: state.quarantined ?? {},
          extractorSessions: state.extractorSessions ?? {},
          sweptAt: state.sweptAt ?? null,
        };
      } catch {
        return EMPTY();
      }
    }
    return EMPTY();
  }

  function save(state) {
    mkdirSync(config.corpusDir, { recursive: true });
    writeFileAtomically(config.statePath, JSON.stringify(state, null, 2) + "\n");
  }

  function processedRecord(sessionId) {
    return load().processed[sessionId] ?? null;
  }

  function processedEntry(result) {
    return {
      ts: new Date().toISOString(),
      topic: result?.topic?.id ?? null,
      topics: result?.topics ?? (result?.topic?.id ? [result.topic.id] : []),
      summary: result?.topic?.summary ?? null,
      context: result?.context?.length ?? 0,
      decisions: result?.decisions?.length ?? 0,
    };
  }

  function extractionOffset(sessionId) {
    return offsetIn(load(), sessionId);
  }

  function snapshot() {
    const state = load();
    return {
      isQuarantined: (sessionId) => Boolean(state.quarantined[sessionId]),
      isExtractorSession: (sessionId) => Boolean(state.extractorSessions[sessionId]),
      extractionOffset: (sessionId) => offsetIn(state, sessionId),
      hasUnreadTurns: (sessionId, size) => transcriptHasUnreadTurns(size, offsetIn(state, sessionId)),
    };
  }

  function recordExtraction(sessionId, { offset, result = null } = {}) {
    const state = load();
    if (Number.isInteger(offset)) state.offsets[sessionId] = offset;
    delete state.failures[sessionId];
    state.processed[sessionId] = processedEntry(result);
    save(state);
  }

  function recordFailure(sessionId, error) {
    const state = load();
    const attempts = (state.failures[sessionId]?.attempts ?? 0) + 1;
    const record = { attempts, ts: new Date().toISOString(), error: String(error ?? "") };

    if (attempts >= attemptsBeforeQuarantine) {
      delete state.failures[sessionId];
      state.quarantined[sessionId] = record;
    } else {
      state.failures[sessionId] = record;
    }

    save(state);
    return { attempts, quarantined: attempts >= attemptsBeforeQuarantine };
  }

  function isQuarantined(sessionId) {
    return Boolean(load().quarantined[sessionId]);
  }

  function releaseQuarantine(sessionId) {
    const state = load();
    if (!state.quarantined[sessionId]) return false;

    delete state.quarantined[sessionId];
    delete state.failures[sessionId];
    save(state);
    return true;
  }

  function claimSweep() {
    const state = load();
    const sweptAt = Date.parse(state.sweptAt ?? "");
    if (Number.isFinite(sweptAt) && Date.now() - sweptAt < debounceMs) return false;

    state.sweptAt = new Date().toISOString();
    save(state);
    return true;
  }

  function offsetIn(state, sessionId) {
    const offset = state.offsets[sessionId];
    return Number.isInteger(offset) && offset >= 0 ? offset : START_OF_TRANSCRIPT;
  }

  return {
    load,
    processedRecord,
    extractionOffset,
    recordExtraction,
    recordFailure,
    isQuarantined,
    releaseQuarantine,
    snapshot,
    claimSweep,
  };
}
