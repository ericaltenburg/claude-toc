import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getTopicDir, loadManifest } from "./manifest.js";

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function appendContext(topicId, fact) {
  const file = join(getTopicDir(topicId), "context.md");
  const content = readFileSync(file, "utf-8");
  writeFileSync(file, content + `- ${fact} [${timestamp()}]\n`);
  bumpState(topicId);
}

export function appendDecision(topicId, decision) {
  const file = join(getTopicDir(topicId), "decisions.md");
  const content = readFileSync(file, "utf-8");
  writeFileSync(file, content + `- ${decision} [${timestamp()}]\n`);
  bumpState(topicId);
}

function bumpState(topicId) {
  const file = join(getTopicDir(topicId), "state.json");
  const state = JSON.parse(readFileSync(file, "utf-8"));
  state.entries = (state.entries || 0) + 1;
  state.last_updated = new Date().toISOString();
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}
