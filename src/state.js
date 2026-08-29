import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";

const STATE_VERSION = 1;
const EXTRACTION_LEASE_MS = 300_000;

const EMPTY = () => ({ version: STATE_VERSION, processed: {}, extraction: null });

export function createStateStore(config, { leaseMs = EXTRACTION_LEASE_MS } = {}) {
  let owned = null;

  function load() {
    if (existsSync(config.statePath)) {
      try {
        const state = JSON.parse(readFileSync(config.statePath, "utf-8"));
        return {
          version: state.version ?? STATE_VERSION,
          processed: state.processed ?? {},
          extraction: state.extraction ?? null,
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

  function isProcessed(sessionId) {
    return Boolean(load().processed[sessionId]);
  }

  function processedRecord(sessionId) {
    return load().processed[sessionId] ?? null;
  }

  function markProcessed(sessionId, result) {
    const state = load();
    state.processed[sessionId] = {
      ts: new Date().toISOString(),
      topic: result?.topic?.id ?? null,
      summary: result?.topic?.summary ?? null,
      context: result?.context?.length ?? 0,
      decisions: result?.decisions?.length ?? 0,
    };
    save(state);
  }

  function acquireExtraction(sessionId) {
    const state = load();
    const current = state.extraction;
    if (current && Date.now() - Date.parse(current.startedAt) < leaseMs) return false;

    state.extraction = { sessionId, startedAt: new Date().toISOString() };
    save(state);

    if (load().extraction?.sessionId !== sessionId) return false;

    owned = sessionId;
    return true;
  }

  function releaseExtraction(sessionId = owned) {
    if (!sessionId) return;
    const state = load();
    if (state.extraction?.sessionId !== sessionId) return;
    state.extraction = null;
    save(state);
    if (owned === sessionId) owned = null;
  }

  return {
    load,
    isProcessed,
    processedRecord,
    markProcessed,
    acquireExtraction,
    releaseExtraction,
  };
}
