import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const MEMORY_DIR = join(import.meta.dirname, "..", "memory");
const MANIFEST_PATH = join(MEMORY_DIR, "manifest.json");

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

export function createTopic(id, keywords = []) {
  const manifest = loadManifest();
  if (manifest.topics.find((t) => t.id === id)) {
    throw new Error(`Topic "${id}" already exists`);
  }

  const topicDir = join(MEMORY_DIR, "topics", id);
  mkdirSync(topicDir, { recursive: true });

  writeFileSync(join(topicDir, "context.md"), `# ${id} — Context\n\n`);
  writeFileSync(join(topicDir, "decisions.md"), `# ${id} — Decisions\n\n`);
  writeFileSync(
    join(topicDir, "state.json"),
    JSON.stringify({ created: new Date().toISOString(), entries: 0 }, null, 2) +
      "\n"
  );

  const topic = {
    id,
    keywords,
    last_active: new Date().toISOString(),
    importance: 0.5,
  };

  manifest.topics.push(topic);
  if (!manifest.default_topic) manifest.default_topic = id;
  saveManifest(manifest);

  return topic;
}

export function resolveTopic(input) {
  const manifest = loadManifest();
  if (!manifest.topics.length) return null;

  const lower = input.toLowerCase();

  // keyword match — score each topic
  let best = null;
  let bestScore = 0;
  for (const topic of manifest.topics) {
    const hits = topic.keywords.filter((kw) => lower.includes(kw)).length;
    if (hits > bestScore) {
      best = topic;
      bestScore = hits;
    }
  }

  // fallback to default topic
  return best || manifest.topics.find((t) => t.id === manifest.default_topic);
}

export function getTopicDir(topicId) {
  return join(MEMORY_DIR, "topics", topicId);
}
