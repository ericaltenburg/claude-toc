#!/usr/bin/env node
// claude-toc: Read and display conversations from Claude transcripts
// Usage: node src/read-session.js [session_id]
//   No args = list all indexed sessions
//   With arg = show conversation from that session

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const MEMORY_DIR = join(import.meta.dirname, "..", "memory");
const INDEX_FILE = join(MEMORY_DIR, "sessions.jsonl");

function listSessions() {
  if (!existsSync(INDEX_FILE)) {
    console.log("No sessions indexed yet.");
    return;
  }
  const lines = readFileSync(INDEX_FILE, "utf-8").trim().split("\n");
  console.log("Indexed sessions:\n");
  for (const line of lines) {
    const s = JSON.parse(line);
    console.log(`  ${s.session_id.slice(0, 8)}  ${s.started}  ${s.cwd}`);
  }
}

function readTranscript(sessionId) {
  if (!existsSync(INDEX_FILE)) {
    console.log("No sessions indexed.");
    return;
  }
  const lines = readFileSync(INDEX_FILE, "utf-8").trim().split("\n");
  const session = lines
    .map((l) => JSON.parse(l))
    .find((s) => s.session_id.startsWith(sessionId));

  if (!session) {
    console.log(`No session matching "${sessionId}"`);
    return;
  }

  if (!existsSync(session.transcript)) {
    console.log(`Transcript not found: ${session.transcript}`);
    return;
  }

  const transcript = readFileSync(session.transcript, "utf-8").trim().split("\n");

  for (const line of transcript) {
    const entry = JSON.parse(line);
    const role = entry.role || entry.type;

    if (role === "human") {
      const msg = entry.message?.content;
      if (typeof msg === "string") {
        console.log(`\n>>> YOU: ${msg}`);
      } else if (Array.isArray(msg)) {
        for (const block of msg) {
          if (block.type === "text") console.log(`\n>>> YOU: ${block.text}`);
        }
      }
    } else if (role === "assistant") {
      const content = entry.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          console.log(`\n<<< CLAUDE: ${block.text}`);
        } else if (block.type === "tool_use") {
          console.log(`\n    [tool: ${block.name}]`);
        }
      }
    }
  }
}

const arg = process.argv[2];
if (!arg) listSessions();
else readTranscript(arg);
