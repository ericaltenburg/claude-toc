// claude-toc: sweep and extraction state — one file, not three.
//
// Replaces the old processed.json plus .analyzing lock plus per-session .turns-*
// counters. Everything the sweep needs to know lives in state.json inside the
// corpus: which sessions have been processed, and whether an extraction is
// currently running.

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
        // corrupt state is recoverable: it is derived from work already paid for,
        // and losing it only means a session may be extracted twice.
        return EMPTY();
      }
    }
    return adoptLegacyProcessed();
  }

  // The corpus predates this file: sessions processed before the rewrite are
  // recorded in processed.json. Read it once so backfill does not pay for them
  // again. Never written to.
  function adoptLegacyProcessed() {
    const state = EMPTY();
    const legacy = config.legacyProcessedPath;
    if (!existsSync(legacy)) return state;
    try {
      state.processed = JSON.parse(readFileSync(legacy, "utf-8")) ?? {};
    } catch {
      // ignore — an unreadable legacy file just means no head start
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

  /** What extraction recorded for a session, or null if it never ran on it. */
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

  /** @returns {boolean} true if this caller now holds the extraction lock */
  function acquireExtraction(sessionId) {
    const state = load();
    const current = state.extraction;
    if (current && Date.now() - Date.parse(current.startedAt) < leaseMs) return false;

    state.extraction = { sessionId, startedAt: new Date().toISOString() };
    save(state);

    // The write above is a read-modify-write, so two sweeps can both get this
    // far. Re-read: last writer wins, and only the caller that still sees its
    // own id proceeds, so exactly one extraction starts.
    if (load().extraction?.sessionId !== sessionId) return false;

    owned = sessionId;
    return true;
  }

  /** Releases only the lock this caller took, so a slow process cannot clobber a fresh one. */
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
