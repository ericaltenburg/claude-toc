#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";

import { createConfig } from "../src/config.js";

const STDIN_TIMEOUT_MS = 5000;

let input = "";
const timeout = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);
process.stdin.setEncoding("utf8");
process.stdin.on("error", () => process.exit(0));
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    indexSession(JSON.parse(input));
  } catch {
  }
  process.exit(0);
});

function indexSession(data) {
  if (process.env.TOC_EXTRACTING === "1") return;
  if (!data.session_id || !data.transcript_path) return;

  const config = createConfig();
  const alreadyIndexed =
    existsSync(config.sessionIndexPath) &&
    readFileSync(config.sessionIndexPath, "utf-8").includes(data.session_id);
  if (alreadyIndexed) return;

  mkdirSync(config.corpusDir, { recursive: true });
  appendFileSync(
    config.sessionIndexPath,
    JSON.stringify({
      session_id: data.session_id,
      transcript: data.transcript_path,
      cwd: data.cwd,
      started: new Date().toISOString(),
    }) + "\n"
  );
}
