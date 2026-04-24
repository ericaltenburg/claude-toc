#!/usr/bin/env node

import { createInterface } from "readline";
import { execSync } from "child_process";
import { createTopic, resolveTopic, loadManifest } from "./manifest.js";
import { retrieveContext } from "./retrieve.js";
import { appendContext, appendDecision } from "./memory.js";

function sendToClaude(prompt) {
  try {
    const result = execSync("claude -p", {
      input: prompt,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
      env: {
        ...process.env,
        AWS_PROFILE: "claudecode",
        CLAUDE_CODE_USE_BEDROCK: "1",
        DISABLE_PROMPT_CACHING: "1",
        ANTHROPIC_MODEL: "global.anthropic.claude-opus-4-6-v1",
      },
    });
    return result.trim();
  } catch (err) {
    return `[error] ${err.stderr || err.message}`;
  }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

let debug = false;

// ensure at least one topic exists
function ensureDefaultTopic() {
  const manifest = loadManifest();
  if (!manifest.topics.length) {
    console.log("No topics found. Creating default topic...");
    createTopic("general", ["help", "question", "idea"]);
    console.log('Created topic: "general"\n');
  }
}

function buildPrompt(userInput, contextBlock) {
  if (!contextBlock) return userInput;
  return `${contextBlock}\n\n[User Message]\n${userInput}`;
}

async function handleCommand(input) {
  const [cmd, ...args] = input.slice(1).split(" ");
  const arg = args.join(" ");

  switch (cmd) {
    case "new": {
      const [id, ...kw] = arg.split(" ");
      if (!id) return console.log("Usage: /new <topic_id> [keywords...]");
      createTopic(id, kw);
      console.log(`Created topic: "${id}"`);
      break;
    }
    case "add": {
      const [type, topicId, ...rest] = arg.split(" ");
      const text = rest.join(" ");
      if (!text)
        return console.log("Usage: /add <context|decision> <topic> <text>");
      if (type === "context") appendContext(topicId, text);
      else if (type === "decision") appendDecision(topicId, text);
      else return console.log("Type must be 'context' or 'decision'");
      console.log(`Added ${type} to "${topicId}"`);
      break;
    }
    case "topics": {
      const manifest = loadManifest();
      if (!manifest.topics.length) return console.log("No topics.");
      for (const t of manifest.topics) {
        console.log(
          `  ${t.id} [${t.keywords.join(", ")}] importance=${t.importance}`
        );
      }
      break;
    }
    case "context": {
      const topicId = arg || loadManifest().default_topic;
      if (!topicId) return console.log("No topic specified.");
      const ctx = retrieveContext(topicId);
      console.log(ctx || "(empty)");
      break;
    }
    case "help":
      console.log(
        [
          "Commands:",
          "  /new <id> [keywords...]       Create a topic",
          "  /add context <topic> <text>   Add a context entry",
          "  /add decision <topic> <text>  Add a decision entry",
          "  /topics                       List all topics",
          "  /context [topic]              Show retrieved context",
          "  /debug                        Toggle debug mode",
          "  /quit                         Exit",
        ].join("\n")
      );
      break;
    case "debug":
      debug = !debug;
      console.log(`Debug mode: ${debug ? "on" : "off"}`);
      break;
    default:
      console.log(`Unknown command: /${cmd}. Type /help for commands.`);
  }
}

async function main() {
  console.log("claude-toc v0.1.0 — Topic-Scoped Memory");
  console.log("Type /help for commands, or just type a message.\n");

  ensureDefaultTopic();

  while (true) {
    const input = await prompt("you> ");
    if (!input || input === "/quit") {
      console.log("bye");
      rl.close();
      break;
    }

    if (input.startsWith("/")) {
      await handleCommand(input);
      continue;
    }

    // topic detection + context retrieval
    const topic = resolveTopic(input);
    const contextBlock = topic ? retrieveContext(topic.id) : null;
    const assembled = buildPrompt(input, contextBlock);

    if (topic) {
      process.stdout.write(`[${topic.id}] `);
    }

    if (debug) {
      console.log("--- Assembled Prompt ---");
      console.log(assembled);
      console.log("--- End Prompt ---\n");
    }

    console.log("thinking...\n");

    const response = sendToClaude(assembled);
    console.log(response);
    console.log();
  }
}

main();
