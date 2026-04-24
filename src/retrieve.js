import { readFileSync } from "fs";
import { join } from "path";
import { getTopicDir } from "./manifest.js";

const MAX_CONTEXT_TOKENS_ESTIMATE = 500;
const CHARS_PER_TOKEN = 4; // rough estimate
const MAX_CHARS = MAX_CONTEXT_TOKENS_ESTIMATE * CHARS_PER_TOKEN;

function readTopicFile(topicId, filename) {
  try {
    return readFileSync(join(getTopicDir(topicId), filename), "utf-8").trim();
  } catch {
    return "";
  }
}

function extractEntries(content) {
  // each entry is a line starting with "- "
  return content
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .reverse(); // most recent first
}

export function retrieveContext(topicId) {
  const context = readTopicFile(topicId, "context.md");
  const decisions = readTopicFile(topicId, "decisions.md");

  const contextEntries = extractEntries(context);
  const decisionEntries = extractEntries(decisions);

  // build context block within budget
  const parts = [];
  let charCount = 0;

  if (contextEntries.length) {
    parts.push("[Relevant Context]");
    for (const entry of contextEntries) {
      if (charCount + entry.length > MAX_CHARS * 0.6) break;
      parts.push(entry);
      charCount += entry.length;
    }
  }

  if (decisionEntries.length) {
    parts.push("\n[Recent Decisions]");
    for (const entry of decisionEntries) {
      if (charCount + entry.length > MAX_CHARS) break;
      parts.push(entry);
      charCount += entry.length;
    }
  }

  return parts.length > 1 ? parts.join("\n") : null;
}
