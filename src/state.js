import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";

const STATE_VERSION = 1;
const EXTRACTION_LEASE_MS = 300_000;
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
  extraction: null,
  extractorSessions: {},
  sweptAt: null,
});

export function createStateStore(
  config,
  {
    leaseMs = EXTRACTION_LEASE_MS,
    debounceMs = SWEEP_DEBOUNCE_MS,
    attemptsBeforeQuarantine = ATTEMPTS_BEFORE_QUARANTINE,
  } = {}
) {
  let owned = null;

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
          extraction: state.extraction ?? null,
          extractorSessions: state.extractorSessions ?? {},
          sweptAt: state.sweptAt ?? null,
        };
      } catch {
        return EMPTY();
      }
    }
    return adoptLegacyProcessed();
  }

  function adoptLegacyProcessed() {
    const state = EMPTY();
    const legacy = config.legacyProcessedPath;
    if (!existsSync(legacy)) return state;
    try {
      state.processed = JSON.parse(readFileSync(legacy, "utf-8")) ?? {};
    } catch {
    }
    return state;
  }

  function save(state) {
    mkdirSync(config.corpusDir, { recursive: true });
    const tmp = `${config.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, config.statePath);
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

  function claimSweep() {
    const state = load();
    const sweptAt = Date.parse(state.sweptAt ?? "");
    if (Number.isFinite(sweptAt) && Date.now() - sweptAt < debounceMs) return false;

    state.sweptAt = new Date().toISOString();
    save(state);
    return true;
  }

  function acquireExtraction(holder) {
    const state = load();
    const current = state.extraction;
    if (current && Date.now() - Date.parse(current.startedAt) < leaseMs) return false;

    state.extraction = { holder, startedAt: new Date().toISOString() };
    save(state);

    if (load().extraction?.holder !== holder) return false;

    owned = holder;
    return true;
  }

  function releaseExtraction(holder = owned) {
    if (!holder) return;
    const state = load();
    if (state.extraction?.holder !== holder) return;
    state.extraction = null;
    save(state);
    if (owned === holder) owned = null;
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
    snapshot,
    claimSweep,
    acquireExtraction,
    releaseExtraction,
  };
}
