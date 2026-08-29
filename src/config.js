import { homedir } from "os";
import { join } from "path";

export function createConfig(overrides = {}, env = process.env) {
  const claudeDir =
    overrides.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  const corpusDir =
    overrides.corpusDir ?? env.CLAUDE_TOC_CORPUS_DIR ?? join(claudeDir, "claude-toc");
  const transcriptsDir =
    overrides.transcriptsDir ?? env.CLAUDE_TOC_TRANSCRIPTS_DIR ?? join(claudeDir, "projects");
  const promptLog =
    overrides.promptLog ?? env.CLAUDE_TOC_PROMPT_LOG ?? join(claudeDir, "history.jsonl");

  return Object.freeze({
    corpusDir,
    transcriptsDir,
    promptLog,
    topicsDir: join(corpusDir, "topics"),
    topicsDirName: "topics",
    tocPath: join(corpusDir, "toc.json"),
    sessionIndexPath: join(corpusDir, "sessions.jsonl"),
    statePath: join(corpusDir, "state.json"),
    indexPath: join(corpusDir, "index.db"),
    legacyProcessedPath: join(corpusDir, "processed.json"),
  });
}
