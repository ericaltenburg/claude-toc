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

  // corpusDir is the root. Under it, files are grouped by how replaceable they are (ADR 0018).
  const corpus = join(corpusDir, "corpus");
  const ledger = join(corpusDir, "ledger");
  const settings = join(corpusDir, "config");
  const cache = join(corpusDir, "cache");

  const extractorDir = overrides.extractorDir ?? join(cache, "extractor");
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
    awsProfile: overrides.awsProfile ?? env.CLAUDE_TOC_AWS_PROFILE ?? "claudecode",
    awsRegion: overrides.awsRegion ?? env.CLAUDE_TOC_AWS_REGION ?? env.AWS_REGION ?? "us-west-2",
    topicsDir: join(corpus, "topics"),
    // toc.json records each topic's file relative to itself, and both live in corpus/.
    topicsDirName: "topics",
    tocPath: join(corpus, "toc.json"),
    statePath: join(ledger, "state.json"),
    sessionIndexPath: join(ledger, "sessions.jsonl"),
    spendLogPath: join(ledger, "spend.jsonl"),
    searchLogPath: join(ledger, "search.log"),
    smokeQueriesPath: join(settings, "smoke-queries.json"),
    modelRatesPath: join(settings, "model-rates.json"),
    indexPath: join(cache, "index.db"),
    extractionLockPath: join(cache, "extraction.lock"),
  });
}
