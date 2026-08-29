#!/usr/bin/env node
// claude-toc: extraction trigger (SessionEnd).
//
// Takes the single extraction lock in the state file and spawns the extractor
// detached, so session exit is never blocked. Writes nothing to stdout and exits
// zero whatever happens; the spawned extractor releases the lock when it ends.

import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { createConfig } from "../src/config.js";
import { createStateStore } from "../src/state.js";

const EXTRACTOR = fileURLToPath(new URL("../src/extract.js", import.meta.url));
const STDIN_TIMEOUT_MS = 5000;

let input = "";
const timeout = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);
process.stdin.setEncoding("utf8");
process.stdin.on("error", () => process.exit(0));
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    triggerExtraction(JSON.parse(input));
  } catch {
    // a broken trigger must be invisible
  }
  process.exit(0);
});

function triggerExtraction(data) {
  if (process.env.TOC_EXTRACTING === "1") return; // fired inside the extractor
  if (!data.session_id) return;

  const config = createConfig();
  const state = createStateStore(config);
  if (!state.acquireExtraction(data.session_id)) return; // one extraction at a time

  const child = spawn("node", [EXTRACTOR, data.session_id.slice(0, 8)], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      TOC_EXTRACTING: "1",
      TOC_LOCK_SESSION: data.session_id,
    },
  });
  child.on("error", () => state.releaseExtraction(data.session_id));
  child.unref();
}
