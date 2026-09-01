// Hand-built status readings, shared by the tests of the summariser and of the command that
// renders it. These are the shape `summarizeStatus` takes: the gathering half of status.js
// produces them from a real corpus, and a test supplies them directly.

import { EXTRACTION_LEASE_MS } from "../../src/state.js";
import { AFTERNOON_ON_27_AUGUST_IN_NEW_YORK } from "./corpus.js";

export const NEW_YORK = "America/New_York";
export const A_MINUTE = 60_000;
export const AN_HOUR = 60 * A_MINUTE;
export const A_DAY = 24 * AN_HOUR;

export function extractionReadings(overrides = {}) {
  return {
    extraction: {
      processed: { count: 0, lastAt: null },
      waiting: 0,
      sweptAt: null,
      lease: null,
      failures: { sessions: 0, attempts: 0 },
      quarantined: 0,
      ...overrides,
    },
  };
}

export const EXTRACTED_ONCE = {
  processed: { count: 1, lastAt: AFTERNOON_ON_27_AUGUST_IN_NEW_YORK },
};

export function corpusReadings(overrides = {}) {
  return {
    corpus: {
      topics: 59,
      facts: 3101,
      prompts: 4882,
      sessions: 229,
      factsPerTopic: { min: 4, median: 31, max: 587, largest: "appsync_key_secrets_manager" },
      added: [
        { days: 7, facts: 585 },
        { days: 30, facts: 1204 },
      ],
      refreshMs: 61,
      bytes: 5 * 1024 * 1024,
      ...overrides,
    },
  };
}

export function leaseExpired(now, expiredAgo) {
  return {
    holder: "sweep-316972f2",
    startedAt: now - expiredAgo - EXTRACTION_LEASE_MS,
    expiresAt: now - expiredAgo,
  };
}

export function leaseLive(now) {
  return { holder: "sweep-316972f2", startedAt: now, expiresAt: now + EXTRACTION_LEASE_MS };
}

export function factsDated(dates) {
  return dates.map((date) => `- something happened [session:316972f2, ${date}]`);
}
