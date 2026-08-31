import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";

export function createTopicStore(config) {
  const topicPath = (topicId) => join(config.topicsDir, `${topicId}.md`);

  // --- TOC operations ---

  function loadToc() {
    if (!existsSync(config.tocPath)) {
      return { version: 2, topics: {} };
    }
    return JSON.parse(readFileSync(config.tocPath, "utf-8"));
  }

  function saveToc(toc) {
    mkdirSync(config.corpusDir, { recursive: true });
    writeFileSync(config.tocPath, JSON.stringify(toc, null, 2) + "\n");
  }

  function upsertTopic(id, { keywords = [], summary = "" } = {}) {
    mkdirSync(config.topicsDir, { recursive: true });
    const toc = loadToc();

    const existing = toc.topics[id];
    const mergedKeywords = existing
      ? [...new Set([...existing.keywords, ...keywords])]
      : keywords;

    toc.topics[id] = {
      file: `${config.topicsDirName}/${id}.md`,
      keywords: mergedKeywords,
      summary: summary || existing?.summary || "",
      last_active: new Date().toISOString(),
      entries: countEntries(id),
    };

    saveToc(toc);
    createTopicFileUnlessPresent(id);

    return toc.topics[id];
  }

  function createTopicFileUnlessPresent(id) {
    const topicFile = topicPath(id);
    if (existsSync(topicFile)) return;

    const headings = SECTIONS.map((section) => `## ${section}\n`).join("\n");
    writeFileSync(topicFile, `# ${id.replace(/_/g, " ")}\n\n${headings}`);
  }

  // --- Topic file operations ---

  function appendToTopic(topicId, section, entry, sessionId, date) {
    const topicFile = topicPath(topicId);
    if (!existsSync(topicFile)) return;

    const content = readFileSync(topicFile, "utf-8");
    const line = factLine(entry, sessionId, date);
    const block = sectionBlock(content, section);

    if (!block) {
      writeFileSync(topicFile, `${content}\n## ${section}\n\n${line}`);
    } else if (isDuplicateFact(block.text, entry)) {
      return;
    } else {
      writeFileSync(topicFile, content.slice(0, block.end) + line + content.slice(block.end));
    }

    recountTocEntry(topicId);
  }

  function recountTocEntry(topicId) {
    const toc = loadToc();
    if (!toc.topics[topicId]) return;

    toc.topics[topicId].entries = countEntries(topicId);
    toc.topics[topicId].last_active = new Date().toISOString();
    saveToc(toc);
  }

  function countEntries(topicId) {
    const topicFile = topicPath(topicId);
    if (!existsSync(topicFile)) return 0;
    return readFileSync(topicFile, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("- ")).length;
  }

  // --- Similarity ---

  function findSimilarTopic(candidateId, candidateKeywords) {
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

  // --- Merging ---

  function pickMergeWinner(idA, idB) {
    const toc = loadToc();
    const a = toc.topics[idA];
    const b = toc.topics[idB];
    if (!a || !b) return null;

    const mostFacts = a.entries > b.entries ? idA : idB;
    const leastRecentlyActive = a.last_active <= b.last_active ? idA : idB;
    const winnerId = a.entries === b.entries ? leastRecentlyActive : mostFacts;

    return { winnerId, loserId: winnerId === idA ? idB : idA };
  }

  function mergeTopics(winnerId, loserId) {
    const toc = loadToc();
    const winnerTopic = toc.topics[winnerId];
    const loserTopic = toc.topics[loserId];
    if (!winnerTopic || !loserTopic) return;

    const loserPath = topicPath(loserId);
    if (!existsSync(loserPath)) return;

    transferFacts(readFileSync(loserPath, "utf-8"), winnerId);

    winnerTopic.keywords = union(winnerTopic.keywords, loserTopic.keywords);
    winnerTopic.summary = longerSummary(winnerTopic, loserTopic);
    winnerTopic.entries = countEntries(winnerId);
    winnerTopic.last_active = new Date().toISOString();

    tombstone(loserPath);
    delete toc.topics[loserId];
    saveToc(toc);
  }

  function transferFacts(loserContent, winnerId) {
    for (const section of SECTIONS) {
      const block = sectionBlock(loserContent, section);
      if (!block) continue;
      for (const fact of factLines(block.text)) {
        appendToTopic(winnerId, section, fact);
      }
    }
  }

  function dedupTopics() {
    const ids = Object.keys(loadToc().topics);
    const merges = [];
    const merged = new Set();

    for (let i = 0; i < ids.length; i++) {
      if (merged.has(ids[i])) continue;
      for (let j = i + 1; j < ids.length; j++) {
        if (merged.has(ids[j])) continue;
        const keywords = loadToc().topics[ids[j]].keywords;
        const match = findSimilarTopic(ids[j], keywords);
        if (!match || match.id !== ids[i]) continue;
        const { winnerId, loserId } = pickMergeWinner(ids[i], ids[j]);
        mergeTopics(winnerId, loserId);
        merged.add(loserId);
        merges.push({ winnerId, loserId, score: match.score });
      }
    }

    return { merges, remaining: ids.length - merged.size };
  }

  return {
    loadToc,
    upsertTopic,
    appendToTopic,
    countEntries,
    findSimilarTopic,
    dedupTopics,
  };
}

const SECTIONS = ["Context", "Decisions"];
const MERGED_TOMBSTONE = ".merged.md";
const SESSION_ID_LENGTH_ON_A_FACT = 8;

function factLine(entry, sessionId, whenTheConversationHappened) {
  const date = whenTheConversationHappened ?? new Date().toISOString().slice(0, 10);
  const session = sessionId?.slice(0, SESSION_ID_LENGTH_ON_A_FACT) || "unknown";
  return `- ${entry} [session:${session}, ${date}]\n`;
}

function union(a, b) {
  return [...new Set([...a, ...b])];
}

function longerSummary(a, b) {
  return (b.summary || "").length > (a.summary || "").length ? b.summary : a.summary;
}

function tombstone(loserPath) {
  renameSync(loserPath, loserPath.replace(".md", MERGED_TOMBSTONE));
}

function sectionBlock(content, section) {
  const idx = content.indexOf(`## ${section}`);
  if (idx === -1) return null;
  const start = content.indexOf("\n", idx) + 1;
  const nextSection = content.indexOf("\n## ", start);
  const end = nextSection === -1 ? content.length : nextSection;
  return { text: content.slice(start, end), end };
}

function factLines(sectionText) {
  return sectionText
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^- /, ""));
}

function isDuplicateFact(sectionText, entry) {
  if (sectionText.includes(entry.slice(0, 60))) return true;
  const newWords = normalize(entry);
  for (const fact of factLines(sectionText)) {
    const bare = fact
      .replace(/ \[session:.*\]$/, "")
      .replace(/ \[\d{4}-\d{2}-\d{2}\]$/, "");
    if (jaccardSimilarity(newWords, normalize(bare)) >= 0.8) return true;
  }
  return false;
}

const normalize = (s) =>
  new Set(
    s
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );

function jaccardSimilarity(setA, setB) {
  const a = new Set([...setA].map((s) => s.toLowerCase()));
  const b = new Set([...setB].map((s) => s.toLowerCase()));
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}
