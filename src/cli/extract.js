import { existsSync, statSync } from "node:fs";

import { createConfig } from "../config.js";
import { createExtractor } from "../extract.js";
import { indexedSessions } from "../session-index.js";
import { createStateStore, transcriptHasUnreadTurns } from "../state.js";
import { createSweeper } from "../sweep.js";
import { createTopicStore } from "../toc.js";

// A retried session is chunked smaller than a swept one: the retry exists because something
// about the session failed, and a smaller slice is the cheapest thing to vary.
const CHARS_PER_RETRIED_MODEL_CALL = 60_000;

function reportExtraction(session, result) {
  const short = String(session.session_id ?? "unknown").slice(0, 8);
  console.log(`\nExtracting: ${short} (${session.started ?? "undated"})`);

  if (result.status === "extracted") {
    console.log(`  → topic: ${result.topics.join(", ")}`);
    console.log(`  → ${result.context} facts, ${result.decisions} decisions`);
    console.log(`  → ${result.candidates.length} candidate topic(s), ${result.chunks} chunk(s)`);
    return;
  }
  if (result.status === "failed") {
    console.log(`  failed (attempt ${result.attempts}): ${result.error}`);
    return;
  }
  if (result.status === "quarantined") {
    console.log(`  quarantined: ${result.error ?? "already quarantined"}`);
    return;
  }
  console.log(`  ${result.status}`);
}

function sessionsWithUnreadTranscript(sessions, state) {
  return sessions.filter((session) => hasUnreadTranscript(session, state));
}

function hasUnreadTranscript(session, state) {
  if (state.isQuarantined(session.session_id)) return false;
  if (!session.transcript || !existsSync(session.transcript)) return false;
  return transcriptHasUnreadTurns(
    statSync(session.transcript).size,
    state.extractionOffset(session.session_id)
  );
}

function listSessions(sessions, state) {
  const unread = sessionsWithUnreadTranscript(sessions, state);
  console.log(`Sessions: ${sessions.length} total, ${unread.length} unextracted`);

  for (const session of sessions) {
    const record = state.processedRecord(session.session_id);
    console.log(
      `  ${String(session.session_id).slice(0, 8)}  ${session.started}  ` +
        `${record ? `✓ ${record.topic || "skipped"}` : "pending"}`
    );
  }
  if (unread.length) console.log(`\nRun the extractor with --all to process them.`);
}

function reportDedup(config) {
  const { merges, remaining } = createTopicStore(config).dedupTopics();
  for (const { winnerId, loserId, score } of merges) {
    console.log(`Merged ${loserId} → ${winnerId} (score: ${score.toFixed(2)})`);
  }
  console.log(`Merged ${merges.length} topic pair(s). ${remaining} topics remain.`);
}

function extractEach(config, sessions, options = {}) {
  const extractor = createExtractor(config, { log: (line) => console.log(line), ...options });
  try {
    for (const session of sessions) {
      reportExtraction(session, extractor.extractSession(session));
    }
  } finally {
    extractor.close();
  }
}

function retry(config, state, sessions, prefix) {
  if (!prefix) {
    console.log("Usage: toc-extract --retry <session-id-prefix>");
    return 2;
  }

  const chosen = sessions.filter((session) => String(session.session_id).startsWith(prefix));
  if (!chosen.length) {
    console.log(`No session matching "${prefix}"`);
    return 1;
  }

  for (const session of chosen) {
    const released = state.releaseQuarantine(session.session_id);
    console.log(`${session.session_id}: ${released ? "quarantine released" : "was not quarantined"}`);
  }

  extractEach(config, chosen, { maxChunkChars: CHARS_PER_RETRIED_MODEL_CALL });
  return 0;
}

function run(argv) {
  const config = createConfig();
  const arg = argv[0];

  if (arg === "--dedup") {
    reportDedup(config);
    return 0;
  }

  const state = createStateStore(config);

  if (arg === "--sweep") {
    const swept = createSweeper(config, state).candidates();
    if (!swept.length) {
      console.log("No session is idle enough to sweep.");
      return 0;
    }
    extractEach(config, swept);
    return 0;
  }

  const sessions = indexedSessions(config);
  if (!sessions) {
    console.log("No sessions indexed yet.");
    return 0;
  }

  if (arg === "--retry") {
    return retry(config, state, sessions, argv[1]);
  }

  if (!arg) {
    listSessions(sessions, state);
    return 0;
  }

  const chosen =
    arg === "--all"
      ? sessionsWithUnreadTranscript(sessions, state)
      : sessions.filter((session) => String(session.session_id).startsWith(arg));

  if (!chosen.length) {
    console.log(arg === "--all" ? "Nothing unread to extract." : `No session matching "${arg}"`);
    return arg === "--all" ? 0 : 1;
  }

  extractEach(config, chosen);
  return 0;
}

// A sweep spawns the extractor holding the extraction lease under TOC_LOCK_SESSION, so
// whoever holds it releases it however the command ends: a crash that skipped this would
// block extraction until the lease expired.
export function main(argv) {
  try {
    return run(argv);
  } finally {
    const lockSession = process.env.TOC_LOCK_SESSION;
    if (lockSession) {
      createStateStore(createConfig()).releaseExtraction(lockSession);
    }
  }
}
