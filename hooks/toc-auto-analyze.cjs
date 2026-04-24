#!/usr/bin/env node
// claude-toc: Auto-analyze on session end
// Fires as SessionEnd hook — analyzes the just-finished session in background.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const MEMORY_DIR = path.join(
  require("os").homedir(),
  "Desktop",
  "claude-toc",
  "memory"
);
const LOCK_FILE = path.join(MEMORY_DIR, ".analyzing");

let input = "";
const timeout = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    if (!data.session_id) process.exit(0);

    // skip if this session was spawned by the analyzer itself
    if (process.env.TOC_ANALYZING === "1") process.exit(0);

    // skip if another analysis is already running
    if (fs.existsSync(LOCK_FILE)) {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < 300_000) process.exit(0); // lock younger than 5min
      // stale lock, remove it
    }

    // fire and forget — don't block session exit
    fs.writeFileSync(LOCK_FILE, data.session_id);

    const analyzer = path.join(__dirname, "..", "src", "analyze.js");
    const child = execFile(
      "node",
      [analyzer, data.session_id.slice(0, 8)],
      {
        env: { ...process.env, TOC_ANALYZING: "1" },
        timeout: 120_000,
      },
      () => {
        try { fs.unlinkSync(LOCK_FILE); } catch {}
      }
    );
    child.unref();
  } catch {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
  process.exit(0);
});
