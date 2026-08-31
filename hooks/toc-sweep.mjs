#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

import { createConfig } from "../src/config.js";
import { createStateStore } from "../src/state.js";
import { createSweeper } from "../src/sweep.js";

const STDIN_TIMEOUT_MS = 5000;

const timeout = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    sweep();
  } catch {
  }
  process.exit(0);
});

function sweep() {
  if (process.env.TOC_EXTRACTING === "1") return;

  const config = createConfig();
  const state = createStateStore(config);
  if (!state.claimSweep()) return;
  if (!createSweeper(config, state).idleSessions().length) return;

  const lockSession = randomUUID();
  if (!state.acquireExtraction(lockSession)) return;

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
  child.on("error", () => state.releaseExtraction(lockSession));
  child.unref();
}
