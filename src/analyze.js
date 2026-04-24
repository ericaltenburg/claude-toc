#!/usr/bin/env node
// claude-toc: Analyze transcripts and extract structured memory
// Usage: node src/analyze.js [session_id]  — analyze one session
//        node src/analyze.js --all         — analyze all unprocessed

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { upsertTopic, appendToTopic, MEMORY_DIR } from "./toc.js";

const INDEX_FILE = join(MEMORY_DIR, "sessions.jsonl");
const PROCESSED_FILE = join(MEMORY_DIR, "processed.json");

// --- transcript parsing ---

function parseTranscript(transcriptPath) {
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
  const turns = [];

  for (const line of lines) {
    const entry = JSON.parse(line);
    const role = entry.role || entry.type;
    const content = entry.message?.content;

    if (role === "human" || role === "user") {
      if (typeof content === "string" && content.trim()) {
        turns.push({ role: "user", text: content.trim() });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text?.trim())
            turns.push({ role: "user", text: block.text.trim() });
        }
      }
    } else if (role === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim())
          turns.push({ role: "assistant", text: block.text.trim() });
      }
    }
  }
  return turns;
}

function turnsToText(turns) {
  return turns
    .map((t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text}`)
    .join("\n\n");
}

// --- extraction via claude ---

const EXTRACT_PROMPT = `You are a memory extraction system. Analyze this conversation and extract structured information.

Return ONLY valid JSON with this exact schema:
{
  "topic": {
    "id": "snake_case_topic_name",
    "keywords": ["keyword1", "keyword2"],
    "summary": "one sentence summary"
  },
  "context": ["durable fact 1", "durable fact 2"],
  "decisions": ["decision 1", "decision 2"]
}

Rules:
- topic.id: short reusable identifier (e.g. "broadcast_variants", "resume_project")
- keywords: words that would appear in future messages about this topic
- context: durable truths learned (e.g. "ALCS uses DynamoDB for broadcast variants")
- decisions: choices made (e.g. "will use topic-scoped memory instead of flat summarization")
- if the conversation has no meaningful content, return {"skip": true}
- deduplicate — don't extract things that are essentially the same fact reworded

CONVERSATION:
`;

function extract(conversationText) {
  try {
    const result = execSync("claude -p", {
      input: EXTRACT_PROMPT + conversationText,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
      env: {
        ...process.env,
        AWS_PROFILE: "claudecode",
        CLAUDE_CODE_USE_BEDROCK: "1",
        DISABLE_PROMPT_CACHING: "1",
        ANTHROPIC_MODEL: "global.anthropic.claude-opus-4-6-v1",
      },
    });
    const match = result.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (err) {
    console.error(`  extraction failed: ${err.message}`);
    return null;
  }
}

// --- processed tracking ---

function loadProcessed() {
  if (!existsSync(PROCESSED_FILE)) return {};
  return JSON.parse(readFileSync(PROCESSED_FILE, "utf-8"));
}

function markProcessed(sessionId, result) {
  const processed = loadProcessed();
  processed[sessionId] = {
    ts: new Date().toISOString(),
    topic: result?.topic?.id || null,
    summary: result?.topic?.summary || null,
    context: result?.context?.length || 0,
    decisions: result?.decisions?.length || 0,
  };
  writeFileSync(PROCESSED_FILE, JSON.stringify(processed, null, 2) + "\n");
}

// --- main ---

function analyzeSession(session) {
  console.log(`\nAnalyzing: ${session.session_id.slice(0, 8)} (${session.started})`);

  if (!existsSync(session.transcript)) {
    console.log("  transcript not found, skipping");
    return;
  }

  const turns = parseTranscript(session.transcript);
  const textTurns = turns.filter((t) => t.text.length > 5);

  if (textTurns.length < 2) {
    console.log("  too short, skipping");
    markProcessed(session.session_id, null);
    return;
  }

  const text = turnsToText(textTurns);
  console.log(`  ${textTurns.length} turns, ${text.length} chars`);
  console.log("  extracting...");

  const result = extract(text);

  if (!result || result.skip) {
    console.log("  nothing meaningful to extract");
    markProcessed(session.session_id, null);
    return;
  }

  // upsert topic in TOC and create/update topic file
  const topicId = result.topic.id;
  upsertTopic(topicId, {
    keywords: result.topic.keywords,
    summary: result.topic.summary,
  });

  for (const fact of result.context || []) {
    appendToTopic(topicId, "Context", fact);
  }
  for (const decision of result.decisions || []) {
    appendToTopic(topicId, "Decisions", decision);
  }

  markProcessed(session.session_id, result);

  console.log(`  → topic: ${topicId}`);
  console.log(`  → ${result.context?.length || 0} facts, ${result.decisions?.length || 0} decisions`);
  console.log(`  → ${result.topic.summary}`);
}

function main() {
  if (!existsSync(INDEX_FILE)) {
    console.log("No sessions indexed yet.");
    process.exit(0);
  }

  const sessions = readFileSync(INDEX_FILE, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  const processed = loadProcessed();
  const arg = process.argv[2];

  if (arg === "--all") {
    const unprocessed = sessions.filter((s) => !processed[s.session_id]);
    if (!unprocessed.length) {
      console.log("All sessions already processed.");
      return;
    }
    console.log(`Processing ${unprocessed.length} session(s)...`);
    for (const s of unprocessed) analyzeSession(s);
  } else if (arg) {
    const session = sessions.find((s) => s.session_id.startsWith(arg));
    if (!session) {
      console.log(`No session matching "${arg}"`);
      process.exit(1);
    }
    analyzeSession(session);
  } else {
    const unprocessed = sessions.filter((s) => !processed[s.session_id]);
    console.log(`Sessions: ${sessions.length} total, ${unprocessed.length} unprocessed`);
    for (const s of sessions) {
      const p = processed[s.session_id];
      const status = p ? `✓ ${p.topic || "skipped"}` : "pending";
      console.log(`  ${s.session_id.slice(0, 8)}  ${s.started}  ${status}`);
    }
    if (unprocessed.length) console.log(`\nRun: node src/analyze.js --all`);
  }
}

main();
