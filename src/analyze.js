#!/usr/bin/env node
// claude-toc: Analyze transcripts and extract structured memory
// Usage: node src/analyze.js [session_id]  — analyze one session
//        node src/analyze.js --all         — analyze all unprocessed

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

import { createConfig } from "./config.js";
import { createTopicStore } from "./toc.js";
import { createStateStore } from "./state.js";

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

function buildExtractPrompt(toc, existingFacts) {
  let prompt = `You are a memory extraction system. Analyze this conversation and extract structured information.

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
`;

  const topicEntries = Object.entries(toc.topics || {});
  if (topicEntries.length > 0) {
    prompt += `\nExisting topics:\n`;
    for (const [id, t] of topicEntries) {
      prompt += `- ${id}: ${t.summary} (keywords: ${t.keywords.join(", ")})\n`;
    }
    prompt += `\nIf this conversation matches an existing topic, use that topic's id. Only create a new topic if no existing topic fits.\n`;
  }

  if (existingFacts && existingFacts.length > 0) {
    prompt += `\nKnown facts for the matched topic (DO NOT re-extract these):\n`;
    for (const fact of existingFacts) {
      prompt += `- ${fact}\n`;
    }
  }

  prompt += `\nCONVERSATION:\n`;
  return prompt;
}

function extract(conversationText, toc, existingFacts) {
  try {
    const prompt = buildExtractPrompt(toc || { topics: {} }, existingFacts || []);
    const result = execSync("claude -p", {
      input: prompt + conversationText,
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

// --- main ---

function analyzeSession(session, { topics, state }) {
  console.log(`\nAnalyzing: ${session.session_id.slice(0, 8)} (${session.started})`);

  if (!existsSync(session.transcript)) {
    console.log("  transcript not found, skipping");
    return;
  }

  const turns = parseTranscript(session.transcript);
  const textTurns = turns.filter((t) => t.text.length > 5);

  if (textTurns.length < 2) {
    console.log("  too short, skipping");
    state.markProcessed(session.session_id, null);
    return;
  }

  const text = turnsToText(textTurns);
  console.log(`  ${textTurns.length} turns, ${text.length} chars`);
  console.log("  extracting...");

  // Candidate topics and already-known facts come from the search index, which
  // is what bounds this prompt independently of corpus size (docs/adr/0002).
  // Until the index exists, extraction gets no known-facts block.
  const result = extract(text, topics.loadToc());

  if (!result || result.skip) {
    console.log("  nothing meaningful to extract");
    state.markProcessed(session.session_id, null);
    return;
  }

  // Check for similar existing topic before creating new one
  let topicId = result.topic.id;
  const match = topics.findSimilarTopic(topicId, result.topic.keywords);
  if (match) {
    console.log(`  → matched existing topic: ${match.id} (score: ${match.score.toFixed(2)})`);
    topicId = match.id;
  }

  topics.upsertTopic(topicId, {
    keywords: result.topic.keywords,
    summary: result.topic.summary,
  });

  for (const fact of result.context || []) {
    topics.appendToTopic(topicId, "Context", fact, session.session_id);
  }
  for (const decision of result.decisions || []) {
    topics.appendToTopic(topicId, "Decisions", decision, session.session_id);
  }

  state.markProcessed(session.session_id, result);

  console.log(`  → topic: ${topicId}`);
  console.log(`  → ${result.context?.length || 0} facts, ${result.decisions?.length || 0} decisions`);
  console.log(`  → ${result.topic.summary}`);
}

function dedup({ topics }) {
  const toc = topics.loadToc();
  const ids = Object.keys(toc.topics);
  const merged = new Set();
  let mergeCount = 0;

  for (let i = 0; i < ids.length; i++) {
    if (merged.has(ids[i])) continue;
    for (let j = i + 1; j < ids.length; j++) {
      if (merged.has(ids[j])) continue;
      const match = topics.findSimilarTopic(ids[j], toc.topics[ids[j]].keywords);
      if (match && match.id === ids[i] && match.score >= 0.6) {
        const { winnerId, loserId } = topics.pickMergeWinner(ids[i], ids[j]);
        topics.mergeTopics(winnerId, loserId);
        merged.add(loserId);
        mergeCount++;
        console.log(`Merged ${loserId} → ${winnerId} (score: ${match.score.toFixed(2)})`);
      }
    }
  }
  console.log(`Merged ${mergeCount} topic pair(s). ${ids.length - merged.size} topics remain.`);
}

function loadSessions(config) {
  if (!existsSync(config.sessionIndexPath)) return null;
  return readFileSync(config.sessionIndexPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function main() {
  const config = createConfig();
  const stores = { topics: createTopicStore(config), state: createStateStore(config) };
  const arg = process.argv[2];

  if (arg === "--dedup") {
    dedup(stores);
    return;
  }

  const sessions = loadSessions(config);
  if (!sessions) {
    console.log("No sessions indexed yet.");
    return;
  }

  if (arg === "--all") {
    const unprocessed = sessions.filter((s) => !stores.state.isProcessed(s.session_id));
    if (!unprocessed.length) {
      console.log("All sessions already processed.");
      return;
    }
    console.log(`Processing ${unprocessed.length} session(s)...`);
    for (const s of unprocessed) analyzeSession(s, stores);
  } else if (arg) {
    const session = sessions.find((s) => s.session_id.startsWith(arg));
    if (!session) {
      console.log(`No session matching "${arg}"`);
      process.exitCode = 1;
      return;
    }
    analyzeSession(session, stores);
  } else {
    const processed = stores.state.load().processed;
    const unprocessed = sessions.filter((s) => !processed[s.session_id]);
    console.log(`Sessions: ${sessions.length} total, ${unprocessed.length} unprocessed`);
    for (const s of sessions) {
      const p = processed[s.session_id];
      console.log(
        `  ${s.session_id.slice(0, 8)}  ${s.started}  ${p ? `✓ ${p.topic || "skipped"}` : "pending"}`
      );
    }
    if (unprocessed.length) console.log(`\nRun: node src/analyze.js --all`);
  }
}

try {
  main();
} finally {
  // Release the sweep lock the hook took on our behalf, whatever happened.
  const lockSession = process.env.TOC_LOCK_SESSION;
  if (lockSession) {
    createStateStore(createConfig()).releaseExtraction(lockSession);
  }
}
