import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";

import {
  createExtractionLock,
  EXTRACTION_LOCK_IS_STALE_AFTER_MS,
} from "../src/extraction-lock.js";
import { idleFor, tempCorpus } from "./support/corpus.js";

const A_MINUTE = 60_000;

test("one holder at a time: a second holder is refused while the first holds the lock", () => {
  const config = tempCorpus();

  assert.equal(createExtractionLock(config).acquire("sweep-one"), true);
  assert.equal(createExtractionLock(config).acquire("sweep-two"), false);

  const held = createExtractionLock(config).held();
  assert.equal(held.holder, "sweep-one");
  assert.equal(held.pid, process.pid);
  assert.match(held.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a lock nobody renewed within the stale threshold is taken over, and not before", () => {
  const config = tempCorpus();
  createExtractionLock(config).acquire("crashed");

  idleFor(config.extractionLockPath, EXTRACTION_LOCK_IS_STALE_AFTER_MS - A_MINUTE);
  assert.equal(createExtractionLock(config).acquire("sweep-two"), false, "inside the threshold");

  idleFor(config.extractionLockPath, EXTRACTION_LOCK_IS_STALE_AFTER_MS + A_MINUTE);
  assert.equal(createExtractionLock(config).acquire("sweep-two"), true);
  assert.equal(createExtractionLock(config).held().holder, "sweep-two");
});

test("renewing moves the lock forward, and only for the holder that took it", () => {
  const config = tempCorpus();
  const lock = createExtractionLock(config);
  lock.acquire("mine");
  idleFor(config.extractionLockPath, 5 * A_MINUTE);
  const before = statSync(config.extractionLockPath).mtimeMs;

  createExtractionLock(config).renew("someone-else");
  assert.equal(statSync(config.extractionLockPath).mtimeMs, before, "not the holder's to renew");

  lock.renew("mine");
  assert.ok(statSync(config.extractionLockPath).mtimeMs > before + 4 * A_MINUTE);
});

test("releasing a lock another holder took leaves it in place", () => {
  const config = tempCorpus();
  const lock = createExtractionLock(config);
  lock.acquire("mine");

  createExtractionLock(config).release("someone-else");
  assert.equal(lock.held().holder, "mine");

  lock.release("mine");
  assert.equal(existsSync(config.extractionLockPath), false);
  assert.equal(createExtractionLock(config).acquire("next"), true);
});

test("the expiry a reader sees is the last renewal plus the stale threshold", () => {
  const config = tempCorpus();
  createExtractionLock(config).acquire("mine");
  idleFor(config.extractionLockPath, 3 * A_MINUTE);

  const { expiresAt } = createExtractionLock(config).held();

  assert.equal(
    expiresAt,
    statSync(config.extractionLockPath).mtimeMs + EXTRACTION_LOCK_IS_STALE_AFTER_MS
  );
});

test("nothing is held where no lock file exists", () => {
  assert.equal(createExtractionLock(tempCorpus()).held(), null);
});
