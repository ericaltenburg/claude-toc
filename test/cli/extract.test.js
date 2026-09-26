import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";

import { renewingBeforeEachCall } from "../../src/cli/extract.js";
import { createExtractor } from "../../src/extract/extractor.js";
import { createExtractionLock } from "../../src/extract/lock.js";
import {
  appendSessions,
  EXTRACTOR,
  idleFor,
  runCli,
  tempCorpus,
  transcriptPath,
  writeTranscript,
} from "../support/corpus.js";

const A_MINUTE = 60_000;
const SESSION = "316972f2-1111-2222-3333-444455556666";
const A_SWEEP_IN_FLIGHT = "dddddddd-1111-2222-3333-444455556666";

const EVERY_EXTRACTION_ENTRY_POINT = [
  ["--sweep"],
  ["--all"],
  ["316972f2"],
  ["--retry", "316972f2"],
  ["--dedup"],
];

// No session is indexed and no transcript is idle, so an entry point that ignored the lock
// would find nothing to do and exit zero rather than reach a model.
test("every manual extraction refuses while another holder has the lock", () => {
  const config = tempCorpus();
  createExtractionLock(config).acquire(A_SWEEP_IN_FLIGHT);

  for (const args of EVERY_EXTRACTION_ENTRY_POINT) {
    const result = runCli(EXTRACTOR, { args, config });

    assert.equal(result.status, 1, `toc-extract ${args.join(" ")}`);
    assert.match(result.stderr, /an extraction is already running/);
  }
  assert.equal(
    createExtractionLock(config).held().holder,
    A_SWEEP_IN_FLIGHT,
    "the refusal released nothing"
  );
  assert.equal(runCli(EXTRACTOR, { args: [], config }).status, 0, "listing needs no lock");
});

test("a manual extraction takes the lock and gives it back however it ends", () => {
  const config = tempCorpus();

  for (const args of EVERY_EXTRACTION_ENTRY_POINT) {
    runCli(EXTRACTOR, { args, config });
    assert.equal(existsSync(config.extractionLockPath), false, `toc-extract ${args.join(" ")}`);
  }
});

test("an extractor a sweep spawned uses the sweep's lock and releases it", () => {
  const config = tempCorpus();
  createExtractionLock(config).acquire(A_SWEEP_IN_FLIGHT);

  const result = runCli(EXTRACTOR, {
    args: ["--sweep"],
    config,
    env: { TOC_LOCK_SESSION: A_SWEEP_IN_FLIGHT },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(config.extractionLockPath), false);
});

// --- One list of sessions ---

// One turn is too little to extract, so these reach the extractor and stop short of a model.
const TOO_SHORT_TO_EXTRACT = [{ role: "user", text: "where do broadcast variants live?" }];

test("a session only its transcript knows is listed, and found by --all and by its prefix", () => {
  const config = tempCorpus();
  writeTranscript(config, SESSION, TOO_SHORT_TO_EXTRACT);

  const listing = runCli(EXTRACTOR, { args: [], config });
  const all = runCli(EXTRACTOR, { args: ["--all"], config });
  const byPrefix = runCli(EXTRACTOR, { args: ["316972f2"], config });

  assert.match(listing.stdout, /1 total, 1 unextracted/);
  assert.match(listing.stdout, /316972f2  undated  pending/);
  for (const found of [all, byPrefix]) {
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.stdout, /Extracting: 316972f2 \(undated\)\n  nothing-to-extract/);
  }
});

test("a session the logger recorded still lists after its transcript rotated away", () => {
  const config = tempCorpus();
  appendSessions(config, [
    {
      session_id: SESSION,
      transcript: transcriptPath(config, SESSION),
      cwd: "/work/alcs",
      started: "2026-08-27T15:00:00.000Z",
    },
  ]);

  const listing = runCli(EXTRACTOR, { args: [], config });

  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /1 total, 0 unextracted/);
  assert.match(listing.stdout, /316972f2  2026-08-27T15:00:00.000Z  pending/);
});

test("a session known from both its transcript and the logger is one session", () => {
  const config = tempCorpus();
  const transcript = writeTranscript(config, SESSION, TOO_SHORT_TO_EXTRACT);
  appendSessions(config, [
    { session_id: SESSION, transcript, cwd: "/work/alcs", started: "2026-08-27T15:00:00.000Z" },
  ]);

  const listing = runCli(EXTRACTOR, { args: [], config });

  assert.match(listing.stdout, /1 total, 1 unextracted/);
  assert.match(listing.stdout, /316972f2  2026-08-27T15:00:00.000Z  pending/);
});

test("every model call renews the lock before it is made", () => {
  const config = tempCorpus();
  const transcript = writeTranscript(config, SESSION, [
    { role: "user", text: "where do broadcast variants live?" },
    { role: "assistant", text: "in dynamodb, keyed by show id" },
  ]);
  const lock = createExtractionLock(config);
  lock.acquire(A_SWEEP_IN_FLIGHT);
  idleFor(config.extractionLockPath, 5 * A_MINUTE);

  const renewedAtCallTime = [];
  const callModel = renewingBeforeEachCall(lock, A_SWEEP_IN_FLIGHT, () => {
    renewedAtCallTime.push(statSync(config.extractionLockPath).mtimeMs);
    return JSON.stringify({ skip: true });
  });
  const extractor = createExtractor(config, { callModel });
  extractor.extractSession({ session_id: SESSION, transcript });
  extractor.close();

  assert.equal(renewedAtCallTime.length, 1);
  assert.ok(
    renewedAtCallTime[0] > Date.now() - A_MINUTE,
    "a call can block for minutes, so the lock is renewed before it rather than during it"
  );
});
