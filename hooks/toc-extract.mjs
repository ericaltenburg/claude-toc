#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { createConfig } from "../src/config.js";
import { createStateStore } from "../src/state.js";

const EXTRACTOR = fileURLToPath(new URL("../bin/toc-extract", import.meta.url));
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
  }
  process.exit(0);
});

function triggerExtraction(data) {
  if (process.env.TOC_EXTRACTING === "1") return;
  if (!data.session_id) return;

  const config = createConfig();
  const state = createStateStore(config);
  if (!state.acquireExtraction(data.session_id)) return;

  const child = spawn(EXTRACTOR, [data.session_id.slice(0, 8)], {
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
