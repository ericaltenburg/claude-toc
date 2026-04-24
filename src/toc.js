import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const MEMORY_DIR = join(import.meta.dirname, "..", "memory");
const TOC_PATH = join(MEMORY_DIR, "toc.json");
const TOPICS_DIR = join(MEMORY_DIR, "topics");

// --- TOC operations ---

export function loadToc() {
  if (!existsSync(TOC_PATH)) {
    return { version: 2, topics: {} };
  }
  return JSON.parse(readFileSync(TOC_PATH, "utf-8"));
}

function saveToc(toc) {
  writeFileSync(TOC_PATH, JSON.stringify(toc, null, 2) + "\n");
}

export function upsertTopic(id, { keywords = [], summary = "" } = {}) {
  mkdirSync(TOPICS_DIR, { recursive: true });
  const toc = loadToc();

  const existing = toc.topics[id];
  const mergedKeywords = existing
    ? [...new Set([...existing.keywords, ...keywords])]
    : keywords;

  toc.topics[id] = {
    file: `topics/${id}.md`,
    keywords: mergedKeywords,
    summary: summary || existing?.summary || "",
    last_active: new Date().toISOString(),
    entries: countEntries(id),
  };

  saveToc(toc);

  // create topic file if it doesn't exist
  const topicFile = join(TOPICS_DIR, `${id}.md`);
  if (!existsSync(topicFile)) {
    writeFileSync(
      topicFile,
      `# ${id.replace(/_/g, " ")}\n\n## Context\n\n## Decisions\n`
    );
  }

  return toc.topics[id];
}

export function resolveTopic(input) {
  const toc = loadToc();
  const lower = input.toLowerCase();

  let best = null;
  let bestScore = 0;

  for (const [id, topic] of Object.entries(toc.topics)) {
    const hits = topic.keywords.filter((kw) =>
      lower.includes(kw.toLowerCase())
    ).length;
    if (hits > bestScore) {
      best = { id, ...topic };
      bestScore = hits;
    }
  }

  return best;
}

export function resolveAllTopics(input) {
  const toc = loadToc();
  const lower = input.toLowerCase();
  const matched = [];

  for (const [id, topic] of Object.entries(toc.topics)) {
    const hits = topic.keywords.filter((kw) =>
      lower.includes(kw.toLowerCase())
    ).length;
    if (hits > 0) matched.push({ id, ...topic, hits });
  }

  return matched.sort((a, b) => b.hits - a.hits);
}

// --- Topic file operations ---

export function appendToTopic(topicId, section, entry, sessionId) {
  const topicFile = join(TOPICS_DIR, `${topicId}.md`);
  if (!existsSync(topicFile)) return;

  const content = readFileSync(topicFile, "utf-8");
  const ts = new Date().toISOString().slice(0, 10);
  const sid = sessionId?.slice(0, 8) || "unknown";
  const line = `- ${entry} [session:${sid}, ${ts}]\n`;

  // find the section header and append after it
  const header = `## ${section}`;
  const idx = content.indexOf(header);
  if (idx === -1) {
    // section doesn't exist, add it
    writeFileSync(topicFile, content + `\n${header}\n\n${line}`);
  } else {
    // find end of section header line, insert after
    const afterHeader = content.indexOf("\n", idx) + 1;
    // find next section or end of file
    const nextSection = content.indexOf("\n## ", afterHeader);
    const insertAt = nextSection === -1 ? content.length : nextSection;

    // check for duplicate
    const sectionContent = content.slice(afterHeader, insertAt);
    if (sectionContent.includes(entry.slice(0, 60))) return; // skip dupe

    writeFileSync(
      topicFile,
      content.slice(0, insertAt) + line + content.slice(insertAt)
    );
  }

  // update TOC entry count
  const toc = loadToc();
  if (toc.topics[topicId]) {
    toc.topics[topicId].entries = countEntries(topicId);
    toc.topics[topicId].last_active = new Date().toISOString();
    saveToc(toc);
  }
}

export function readTopicSection(topicId, section) {
  const topicFile = join(TOPICS_DIR, `${topicId}.md`);
  if (!existsSync(topicFile)) return [];

  const content = readFileSync(topicFile, "utf-8");
  const header = `## ${section}`;
  const idx = content.indexOf(header);
  if (idx === -1) return [];

  const afterHeader = content.indexOf("\n", idx) + 1;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionContent =
    nextSection === -1
      ? content.slice(afterHeader)
      : content.slice(afterHeader, nextSection);

  return sectionContent
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .reverse(); // most recent first
}

export function readTopicFile(topicId) {
  const topicFile = join(TOPICS_DIR, `${topicId}.md`);
  if (!existsSync(topicFile)) return null;
  return readFileSync(topicFile, "utf-8");
}

function countEntries(topicId) {
  const topicFile = join(TOPICS_DIR, `${topicId}.md`);
  if (!existsSync(topicFile)) return 0;
  return readFileSync(topicFile, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("- ")).length;
}

// --- Similarity ---

export function jaccardSimilarity(setA, setB) {
  const a = new Set([...setA].map(s => s.toLowerCase()));
  const b = new Set([...setB].map(s => s.toLowerCase()));
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function findSimilarTopic(candidateId, candidateKeywords) {
  const toc = loadToc();
  let best = null;
  const candidateWords = new Set(candidateId.split("_"));
  const candidateKwSet = new Set(candidateKeywords);

  for (const [id, topic] of Object.entries(toc.topics)) {
    const kwScore = jaccardSimilarity(candidateKwSet, new Set(topic.keywords));
    const idScore = jaccardSimilarity(candidateWords, new Set(id.split("_")));
    const score = 0.7 * kwScore + 0.3 * idScore;
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { id, score, topic };
    }
  }
  return best;
}

export { MEMORY_DIR, TOPICS_DIR, TOC_PATH };
