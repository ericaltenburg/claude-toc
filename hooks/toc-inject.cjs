#!/usr/bin/env node
// claude-toc: Inject topic table of contents at session start

const fs = require("fs");
const path = require("path");

const MEMORY_DIR = path.join(require("os").homedir(), "Desktop", "claude-toc", "memory");
const TOC_PATH = path.join(MEMORY_DIR, "toc.json");

let input = "";
const timeout = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    if (process.env.TOC_ANALYZING === "1") process.exit(0);
    if (!fs.existsSync(TOC_PATH)) process.exit(0);

    const toc = JSON.parse(fs.readFileSync(TOC_PATH, "utf-8"));
    const topics = Object.entries(toc.topics);
    if (!topics.length) process.exit(0);

    const lines = [
      "[Memory TOC — topics from past sessions. Details injected when relevant.]",
    ];

    for (const [id, t] of topics) {
      lines.push(
        `- ${id} [${t.keywords.slice(0, 5).join(", ")}] (${t.entries || 0} entries)${t.summary ? ": " + t.summary : ""}`
      );
    }

    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext: lines.join("\n") } })
    );
  } catch {
    process.exit(0);
  }
});
