#!/usr/bin/env node
// claude-toc: Session indexer + per-turn context injection
// 1. Indexes new sessions
// 2. Matches prompt against TOC keywords
// 3. Reads matched topic .md files and injects relevant sections
// 4. Triggers periodic background analysis

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const MEMORY_DIR = path.join(require("os").homedir(), "Desktop", "claude-toc", "memory");
const INDEX_FILE = path.join(MEMORY_DIR, "sessions.jsonl");
const TOC_PATH = path.join(MEMORY_DIR, "toc.json");
const LOCK_FILE = path.join(MEMORY_DIR, ".analyzing");
const TOPICS_DIR = path.join(MEMORY_DIR, "topics");
const MAX_CHARS = 2000;
const ANALYZE_EVERY = 10;

let input = "";
const timeout = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    if (process.env.TOC_ANALYZING === "1") process.exit(0);

    // --- index session ---
    if (data.session_id && data.transcript_path) {
      if (!fs.existsSync(INDEX_FILE) || !fs.readFileSync(INDEX_FILE, "utf-8").includes(data.session_id)) {
        fs.appendFileSync(INDEX_FILE, JSON.stringify({
          session_id: data.session_id,
          transcript: data.transcript_path,
          cwd: data.cwd,
          started: new Date().toISOString(),
        }) + "\n");
      }
    }

    // --- periodic background analysis ---
    if (data.session_id) {
      const countFile = path.join(MEMORY_DIR, `.turns-${data.session_id.slice(0, 8)}`);
      let count = 1;
      try { count = parseInt(fs.readFileSync(countFile, "utf-8"), 10) + 1; } catch {}
      fs.writeFileSync(countFile, String(count));

      if (count % ANALYZE_EVERY === 0 && !isAnalyzing()) {
        triggerAnalysis(data.session_id);
      }
    }

    // --- match prompt against TOC and inject topic context ---
    const prompt = data.prompt || data.user_prompt;
    if (!prompt || !fs.existsSync(TOC_PATH)) process.exit(0);

    const toc = JSON.parse(fs.readFileSync(TOC_PATH, "utf-8"));
    const lower = prompt.toLowerCase();
    const matched = [];

    for (const [id, topic] of Object.entries(toc.topics)) {
      const hits = topic.keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
      if (hits > 0) matched.push({ id, ...topic, hits });
    }

    if (!matched.length) process.exit(0);

    matched.sort((a, b) => b.hits - a.hits);
    const parts = [];
    let chars = 0;

    for (const topic of matched.slice(0, 2)) {
      const topicFile = path.join(TOPICS_DIR, `${topic.id}.md`);
      if (!fs.existsSync(topicFile)) continue;

      const content = fs.readFileSync(topicFile, "utf-8");
      const entries = content.split("\n").filter((l) => l.startsWith("- ")).reverse();
      if (!entries.length) continue;

      const section = [`[Memory: ${topic.id.replace(/_/g, " ")}]`];
      for (const e of entries.slice(0, 10)) {
        if (chars + e.length > MAX_CHARS) break;
        section.push(e);
        chars += e.length;
      }

      parts.push(section.join("\n"));
      if (chars > MAX_CHARS) break;
    }

    if (!parts.length) process.exit(0);

    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext: parts.join("\n\n") } })
    );
  } catch {
    process.exit(0);
  }
});

function isAnalyzing() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  return Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 300_000;
}

function triggerAnalysis(sessionId) {
  fs.writeFileSync(LOCK_FILE, sessionId);
  const analyzer = path.join(__dirname, "..", "src", "analyze.js");
  const child = execFile(
    "node", [analyzer, sessionId.slice(0, 8)],
    { env: { ...process.env, TOC_ANALYZING: "1" }, timeout: 120_000 },
    () => { try { fs.unlinkSync(LOCK_FILE); } catch {} }
  );
  child.unref();
}
