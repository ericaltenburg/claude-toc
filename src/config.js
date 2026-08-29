// claude-toc: the one place any path is resolved.
//
// The corpus lives outside this repository (it is distilled from work sessions
// and this repo is public), so nothing may derive a path from its own file
// location. Every module takes this object; this file is the only one allowed to
// read the home directory or the environment.

import { homedir } from "os";
import { join } from "path";

/**
 * @param {{ claudeDir?: string, corpusDir?: string, transcriptsDir?: string, promptLog?: string }} overrides
 * @param {Record<string, string | undefined>} env
 */
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
    // roots
    corpusDir,
    transcriptsDir,
    promptLog,
    // derived from the corpus root
    topicsDir: join(corpusDir, "topics"),
    tocPath: join(corpusDir, "toc.json"),
    sessionIndexPath: join(corpusDir, "sessions.jsonl"),
    statePath: join(corpusDir, "state.json"),
    // pre-rewrite processed-sessions file, read once and never written (src/state.js)
    legacyProcessedPath: join(corpusDir, "processed.json"),
  });
}
