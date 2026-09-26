import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { createConfig } from "../config.js";
import { createTopicStore } from "../corpus/topics.js";
import { bedrockBilledToOurOwnProfile, createExtractor } from "../extract/extractor.js";
import { createExtractionLock } from "../extract/lock.js";
import { createSweeper } from "../extract/sweep.js";
import { knownSessions } from "../sessions/known-sessions.js";
import { createStateStore, transcriptHasUnreadTurns } from "../sessions/progress.js";

// A retried session is chunked smaller than a swept one: the retry exists because something
// about the session failed, and a smaller slice is the cheapest thing to vary.
const CHARS_PER_RETRIED_MODEL_CALL = 60_000;

function reportExtraction(session, result) {
  const short = String(session.session_id ?? "unknown").slice(0, 8);
  console.log(`\nExtracting: ${short} (${session.started ?? "undated"})`);

  if (result.status === "extracted") {
    console.log(`  → topic: ${result.topics.join(", ")}`);
    console.log(
      `  → ${result.context} facts, ${result.decisions} decisions, ` +
        `${result.gotchas} gotchas, ${result.open} open`
    );
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

// Every command below reads the one list of known sessions, the same list the sweep reads, so
// a session a sweep would take is one a person can list, name and retry (ADR 0017).
function everyKnownSession(config) {
  return [...knownSessions(config)];
}

function sessionsMatching(config, prefix) {
  const where = (known) => known.session_id.startsWith(prefix);
  return [...knownSessions(config, { where })];
}

function listSessions(sessions, state) {
  if (!sessions.length) {
    console.log("No sessions yet.");
    return;
  }

  const unread = sessionsWithUnreadTranscript(sessions, state);
  console.log(`Sessions: ${sessions.length} total, ${unread.length} unextracted`);

  for (const session of sessions) {
    const record = state.processedRecord(session.session_id);
    console.log(
      `  ${String(session.session_id).slice(0, 8)}  ${session.started ?? "undated"}  ` +
        `${record ? `✓ ${record.topic || "skipped"}` : "pending"}`
    );
  }
  if (unread.length) console.log(`\nRun the extractor with --all to process them.`);
}

// Merging rewrites and renames corpus files, and the corpus has no backup (ADR 0001), so
// dedup prints its plan unless it is told to --apply it.
function reportDedup(config, { apply }) {
  const { merges, remaining } = createTopicStore(config).dedupTopics({ apply });
  for (const { winnerId, loserId, score } of merges) {
    const verb = apply ? "Merged" : "Would merge";
    console.log(`${verb} ${loserId} into ${winnerId} (score: ${score.toFixed(2)})`);
  }
  if (apply) {
    console.log(`Merged ${merges.length} topic pair(s). ${remaining} topics remain.`);
  } else if (merges.length) {
    console.log(
      `${merges.length} topic pair(s) would merge, leaving ${remaining} topics. ` +
        `Nothing has changed: rerun with --apply to merge them.`
    );
  } else {
    console.log(`No topic pair is similar enough to merge.`);
  }
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

function retry(config, state, prefix, callModel) {
  if (!prefix) {
    console.log("Usage: toc-extract --retry <session-id-prefix>");
    return 2;
  }

  const chosen = sessionsMatching(config, prefix);
  if (!chosen.length) {
    console.log(`No session matching "${prefix}"`);
    return 1;
  }

  for (const session of chosen) {
    const released = state.releaseQuarantine(session.session_id);
    console.log(`${session.session_id}: ${released ? "quarantine released" : "was not quarantined"}`);
  }

  extractEach(config, chosen, { callModel, maxChunkChars: CHARS_PER_RETRIED_MODEL_CALL });
  return 0;
}

function run(argv, callModel) {
  const config = createConfig();
  const arg = argv[0];

  if (arg === "--dedup") {
    reportDedup(config, { apply: argv[1] === "--apply" });
    return 0;
  }

  const state = createStateStore(config);

  if (arg === "--sweep") {
    const swept = createSweeper(config, state).candidates();
    if (!swept.length) {
      console.log("No session is idle enough to sweep.");
      return 0;
    }
    extractEach(config, swept, { callModel });
    return 0;
  }

  if (arg === "--retry") {
    return retry(config, state, argv[1], callModel);
  }

  if (!arg) {
    listSessions(everyKnownSession(config), state);
    return 0;
  }

  const chosen =
    arg === "--all"
      ? sessionsWithUnreadTranscript(everyKnownSession(config), state)
      : sessionsMatching(config, arg);

  if (!chosen.length) {
    console.log(arg === "--all" ? "Nothing unread to extract." : `No session matching "${arg}"`);
    return arg === "--all" ? 0 : 1;
  }

  extractEach(config, chosen, { callModel });
  return 0;
}

// execFileSync blocks the event loop for the whole of a model call, so no timer can renew the
// lock while one runs. Renewing synchronously before each call is the only moment there is.
export function renewingBeforeEachCall(lock, holder, callModel) {
  return (call) => {
    lock.renew(holder);
    return callModel(call);
  };
}

// Everything but the listing extracts or merges, and two of those at once lose facts: a topic
// append reads the file and writes it back whole. So every one holds the extraction lease
// (ADR 0016). A sweep spawns the extractor already holding it under TOC_LOCK_SESSION; anything
// else takes it here or refuses. Whoever holds it releases it however the command ends: a
// crash that skipped this would block extraction until the lock went stale.
export function main(argv) {
  if (!argv[0]) return run(argv);

  const config = createConfig();
  const lock = createExtractionLock(config);
  const spawnedBySweep = process.env.TOC_LOCK_SESSION;
  const holder = spawnedBySweep || randomUUID();
  if (!spawnedBySweep && !lock.acquire(holder)) {
    process.stderr.write(
      "toc-extract: an extraction is already running; try again in a few minutes\n"
    );
    return 1;
  }

  try {
    return run(argv, renewingBeforeEachCall(lock, holder, bedrockBilledToOurOwnProfile(config)));
  } finally {
    lock.release(holder);
  }
}
