import { homedir } from "os";
import { join } from "path";

const claudeCodeProjectDirNameFor = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");

export function createConfig(overrides = {}, env = process.env) {
  const claudeDir =
    overrides.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  const corpusDir =
    overrides.corpusDir ?? env.CLAUDE_TOC_CORPUS_DIR ?? join(claudeDir, "claude-toc");
  const transcriptsDir =
    overrides.transcriptsDir ?? env.CLAUDE_TOC_TRANSCRIPTS_DIR ?? join(claudeDir, "projects");
  const promptLog =
    overrides.promptLog ?? env.CLAUDE_TOC_PROMPT_LOG ?? join(claudeDir, "history.jsonl");

  const extractorDir = overrides.extractorDir ?? join(corpusDir, "extractor");
  const extractorCommand =
    overrides.extractorCommand ??
    env.CLAUDE_TOC_EXTRACTOR ??
    join(import.meta.dirname, "..", "bin", "toc-extract");

  return Object.freeze({
    corpusDir,
    transcriptsDir,
    promptLog,
    extractorDir,
    extractorCommand,
    extractorTranscriptsDir: join(transcriptsDir, claudeCodeProjectDirNameFor(extractorDir)),
    topicsDir: join(corpusDir, "topics"),
    topicsDirName: "topics",
    tocPath: join(corpusDir, "toc.json"),
    sessionIndexPath: join(corpusDir, "sessions.jsonl"),
    statePath: join(corpusDir, "state.json"),
    indexPath: join(corpusDir, "index.db"),
    searchLogPath: join(corpusDir, "search.log"),
    smokeQueriesPath: join(corpusDir, "smoke-queries.json"),
    legacyProcessedPath: join(corpusDir, "processed.json"),
  });
}
