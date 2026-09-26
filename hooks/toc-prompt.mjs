#!/usr/bin/env node

// The one UserPromptSubmit hook: it records the session, then sweeps idle ones into a
// detached extractor. It says nothing and always exits 0, because anything it prints to
// stdout becomes context and a failure here must not cost the user their prompt.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

import { createConfig } from "../src/config.js";
import { createExtractionLock } from "../src/extract/lock.js";
import { createSweeper } from "../src/extract/sweep.js";
import { createStateStore } from "../src/sessions/progress.js";
import { alreadyIndexed, recordSession } from "../src/sessions/registry.js";

const STDIN_TIMEOUT_MS = 5000;

let input = "";
const timeout = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);
process.stdin.setEncoding("utf8");
process.stdin.on("error", () => process.exit(0));
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  if (process.env.TOC_EXTRACTING !== "1") {
    // Apart, so a payload the recorder cannot read still leaves the sweep to run.
    swallowingErrors(() => indexSession(JSON.parse(input)));
    swallowingErrors(sweep);
  }
  process.exit(0);
});

function swallowingErrors(step) {
  try {
    step();
  } catch {
  }
}

function indexSession(data) {
  if (!data.session_id || !data.transcript_path) return;

  const config = createConfig();
  if (alreadyIndexed(config, data.session_id)) return;

  recordSession(config, {
    sessionId: data.session_id,
    transcript: data.transcript_path,
    project: data.cwd,
    started: new Date().toISOString(),
  });
}

function sweep() {
  const config = createConfig();
  const state = createStateStore(config);
  if (!state.claimSweep()) return;
  if (!createSweeper(config, state).idleSessions().length) return;

  const lock = createExtractionLock(config);
  const lockSession = randomUUID();
  if (!lock.acquire(lockSession)) return;

  mkdirSync(config.extractorDir, { recursive: true });
  const child = spawn(config.extractorCommand, ["--sweep"], {
    cwd: config.extractorDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      TOC_EXTRACTING: "1",
      TOC_LOCK_SESSION: lockSession,
    },
  });
  child.on("error", () => lock.release(lockSession));
  child.unref();
}
