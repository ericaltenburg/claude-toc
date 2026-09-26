import { readFileSync, readdirSync, mkdirSync, existsSync, renameSync } from "fs";
import { basename, join } from "path";

import { writeFileAtomically } from "../write-atomically.js";
import {
  factLine,
  factLinesIn,
  markSupersededIn,
  newSection,
  newTopicFile,
  sectionBlock,
  SECTIONS,
} from "./format.js";

export function createTopicStore(config) {
  const topicPath = (topicId) => join(config.topicsDir, `${topicId}${TOPIC_FILE}`);

  // Every topic file the corpus holds, by id. A merged topic's tombstone is not one: it is
  // what the loser of a merge leaves behind, and its facts already live in the winner.
  function topicFiles() {
    if (!existsSync(config.topicsDir)) return [];
    return readdirSync(config.topicsDir)
      .filter((file) => file.endsWith(TOPIC_FILE) && !file.endsWith(MERGED_TOMBSTONE))
      .map((file) => ({ id: basename(file, TOPIC_FILE), path: join(config.topicsDir, file) }));
  }

  // --- TOC operations ---

  function loadToc() {
    if (!existsSync(config.tocPath)) {
      return { version: 2, topics: {} };
    }
    return JSON.parse(readFileSync(config.tocPath, "utf-8"));
  }

  function saveToc(toc) {
    writeFileAtomically(config.tocPath, JSON.stringify(toc, null, 2) + "\n");
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

    writeFileAtomically(topicFile, newTopicFile(id));
  }

  // --- Topic file operations ---

  // Whether the fact was written, which it is not when the topic was never created or the
  // section already says it.
  function appendToTopic(topicId, section, entry, sessionId, date) {
    return appendFactLine(topicId, section, factLine(entry, sessionId, date), entry);
  }

  // A fact arrives here already written, attribution and all, when merging moves it between
  // topics. Sending it back through appendToTopic would attribute it a second time — the
  // merge's own date and a session of `unknown` stamped over the session and date the fact
  // came from, which is the provenance a fact *is* and the damage ADR 0013 had to repair.
  function appendFactLine(topicId, section, line, factText) {
    const topicFile = topicPath(topicId);
    if (!existsSync(topicFile)) return false;

    const content = readFileSync(topicFile, "utf-8");
    const block = sectionBlock(content, section);

    if (!block) {
      writeFileAtomically(topicFile, content + newSection(section, line));
    } else if (isDuplicateFact(block.text, factText)) {
      return false;
    } else {
      writeFileAtomically(topicFile, content.slice(0, block.end) + line + content.slice(block.end));
    }

    recountTocEntry(topicId);
    return true;
  }

  // The superseded line is marked and never deleted or reworded (ADR 0019). A topic, section or
  // text that is no longer there, or a fact already marked, leaves the file untouched.
  function markSuperseded(topicId, fact, sessionId, date) {
    const topicFile = topicPath(topicId);
    if (!existsSync(topicFile)) return false;

    const marked = markSupersededIn(readFileSync(topicFile, "utf-8"), fact, sessionId, date);
    if (marked === null) return false;

    writeFileAtomically(topicFile, marked);
    return true;
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
    return factLinesIn(readFileSync(topicFile, "utf-8")).length;
  }

  // --- Similarity ---

  // A topic is never similar to itself: it scores 1.00 against its own entry, and until that
  // entry was skipped dedup learned only that every topic resembles itself and merged nothing.
  function findSimilarTopic(candidateId, candidateKeywords) {
    const toc = loadToc();
    let best = null;
    const candidateWords = new Set(candidateId.split("_"));
    const candidateKwSet = new Set(candidateKeywords);

    for (const [id, topic] of Object.entries(toc.topics)) {
      if (id === candidateId) continue;
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
      for (const fact of factLinesIn(block.text)) {
        appendFactLine(winnerId, section, fact.line, fact.text);
      }
    }
  }

  // Merging renames and rewrites corpus files, and the corpus has no backup (ADR 0001), so the
  // pairing runs without `apply` too: one loop decides the pairs either way, and only the merge
  // itself is withheld. A plan computed by separate code could disagree with what apply then
  // does, which would make the plan worse than no plan at all.
  //
  // The plan still is not a promise. Applying a merge unions the winner's keywords, so on a
  // corpus where merges chain, a later pair can score differently once an earlier one has
  // landed. A single planned merge is exact; the tail of a longer plan is a forecast.
  function dedupTopics({ apply = true } = {}) {
    const ids = Object.keys(loadToc().topics);
    const merges = [];
    const merged = new Set();

    for (let i = 0; i < ids.length; i++) {
      if (merged.has(ids[i])) continue;
      for (let j = i + 1; j < ids.length; j++) {
        // ids[i] can lose its own pairing and be gone from the TOC by now, and a merged
        // topic is nobody's best match afterwards.
        if (merged.has(ids[i])) break;
        if (merged.has(ids[j])) continue;
        const keywords = loadToc().topics[ids[j]].keywords;
        const match = findSimilarTopic(ids[j], keywords);
        if (!match || match.id !== ids[i]) continue;
        const { winnerId, loserId } = pickMergeWinner(ids[i], ids[j]);
        if (apply) mergeTopics(winnerId, loserId);
        merged.add(loserId);
        merges.push({ winnerId, loserId, score: match.score });
      }
    }

    return { merges, remaining: ids.length - merged.size, applied: apply };
  }

  return {
    topicFiles,
    loadToc,
    upsertTopic,
    appendToTopic,
    markSuperseded,
    countEntries,
    findSimilarTopic,
    dedupTopics,
  };
}

const TOPIC_FILE = ".md";
const MERGED_TOMBSTONE = ".merged.md";

function union(a, b) {
  return [...new Set([...a, ...b])];
}

function longerSummary(a, b) {
  return (b.summary || "").length > (a.summary || "").length ? b.summary : a.summary;
}

function tombstone(loserPath) {
  renameSync(loserPath, loserPath.replace(/\.md$/, MERGED_TOMBSTONE));
}

// A fact stating a number the existing one lacks is an update, not a rewording. Changing
// 264,000 to 400,000 leaves the word overlap near 0.9, so without this the corpus would keep
// the stale value and silently drop the current one.
//
// A superseded line is not what the section currently says, so nothing is a duplicate of it: a
// value that changed and changed back is current again.
function isDuplicateFact(sectionText, entry) {
  const newWords = normalize(entry);
  const newNumbers = [...numbersIn(entry)];
  for (const { text: said, superseded } of factLinesIn(sectionText)) {
    if (superseded) continue;
    const saidNumbers = numbersIn(said);
    if (newNumbers.some((number) => !saidNumbers.has(number))) continue;
    if (said.includes(entry.slice(0, 60))) return true;
    if (jaccardSimilarity(newWords, normalize(said)) >= 0.8) return true;
  }
  return false;
}

// Re-extraction often rewrites a number without changing it, so 264,000, 264000 and 264k are
// one value, as are 1.5M and 1,500,000. The value is parsed from a decimal string ("1.5e6")
// so that a suffix never introduces float error.
const POWER_OF_TEN = { k: 3, m: 6, b: 9 };
function numbersIn(text) {
  return new Set(
    [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)([kmb](?![a-z]))?/gi)].map(([, digits, suffix]) =>
      Number(`${digits.replaceAll(",", "")}e${POWER_OF_TEN[suffix?.toLowerCase()] ?? 0}`)
    )
  );
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
