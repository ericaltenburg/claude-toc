// claude-toc: the topic store — the table of contents and the topic markdown
// files that hold facts. Markdown is the source of truth.
//
// Takes a config object; it never resolves a path itself.

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
      file: `topics/${id}.md`,
      keywords: mergedKeywords,
      summary: summary || existing?.summary || "",
      last_active: new Date().toISOString(),
      entries: countEntries(id),
    };

    saveToc(toc);

    // create topic file if it doesn't exist
    const topicFile = topicPath(id);
    if (!existsSync(topicFile)) {
      writeFileSync(
        topicFile,
        `# ${id.replace(/_/g, " ")}\n\n## Context\n\n## Decisions\n`
      );
    }

    return toc.topics[id];
  }

  // --- Topic file operations ---

  function appendToTopic(topicId, section, entry, sessionId) {
    const topicFile = topicPath(topicId);
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

      // check for duplicate (substring)
      const sectionContent = content.slice(afterHeader, insertAt);
      if (sectionContent.includes(entry.slice(0, 60))) return; // skip dupe

      // check for duplicate (normalized word overlap)
      const newWords = normalize(entry);
      for (const line of sectionContent.split("\n").filter((l) => l.startsWith("- "))) {
        const existingFact = line
          .replace(/^- /, "")
          .replace(/ \[session:.*\]$/, "")
          .replace(/ \[\d{4}-\d{2}-\d{2}\]$/, "");
        if (jaccardSimilarity(newWords, normalize(existingFact)) >= 0.8) return; // skip near-dupe
      }

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
    const a = toc.topics[idA],
      b = toc.topics[idB];
    if (!a || !b) return null;
    if (a.entries !== b.entries) {
      return a.entries > b.entries
        ? { winnerId: idA, loserId: idB }
        : { winnerId: idB, loserId: idA };
    }
    // tie-break: older topic wins
    return a.last_active <= b.last_active
      ? { winnerId: idA, loserId: idB }
      : { winnerId: idB, loserId: idA };
  }

  function mergeTopics(winnerId, loserId) {
    const toc = loadToc();
    const winnerTopic = toc.topics[winnerId];
    const loserTopic = toc.topics[loserId];
    if (!winnerTopic || !loserTopic) return;

    const loserPath = topicPath(loserId);
    if (!existsSync(loserPath)) return;

    // Read loser content and transfer facts
    const loserContent = readFileSync(loserPath, "utf-8");
    for (const section of ["Context", "Decisions"]) {
      const header = `## ${section}`;
      const idx = loserContent.indexOf(header);
      if (idx === -1) continue;
      const afterHeader = loserContent.indexOf("\n", idx) + 1;
      const nextSection = loserContent.indexOf("\n## ", afterHeader);
      const block =
        nextSection === -1
          ? loserContent.slice(afterHeader)
          : loserContent.slice(afterHeader, nextSection);
      for (const line of block.split("\n").filter((l) => l.startsWith("- "))) {
        appendToTopic(winnerId, section, line.replace(/^- /, ""));
      }
    }

    // Merge keywords (union)
    winnerTopic.keywords = [
      ...new Set([...winnerTopic.keywords, ...loserTopic.keywords]),
    ];

    // Keep longer summary
    if ((loserTopic.summary || "").length > (winnerTopic.summary || "").length) {
      winnerTopic.summary = loserTopic.summary;
    }

    // Update winner entry count
    winnerTopic.entries = countEntries(winnerId);
    winnerTopic.last_active = new Date().toISOString();

    // Tombstone loser
    renameSync(loserPath, loserPath.replace(".md", ".merged.md"));

    // Remove loser from TOC
    delete toc.topics[loserId];
    saveToc(toc);
  }

  return {
    loadToc,
    upsertTopic,
    appendToTopic,
    countEntries,
    findSimilarTopic,
    pickMergeWinner,
    mergeTopics,
  };
}

// --- pure helpers ---

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
