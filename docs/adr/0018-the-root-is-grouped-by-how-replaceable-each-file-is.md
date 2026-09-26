# ADR 0018: The root is grouped by how replaceable each file is

**Status:** accepted (2026-09-25)

## Context

Every file claude-toc keeps sat flat in one directory, `~/.claude/claude-toc/` or
`CLAUDE_TOC_CORPUS_DIR`. That directory mixed three kinds of file that call for opposite
handling. The topic markdown and `toc.json` are the source of truth and cannot be rebuilt
(ADR 0001). `state.json` and the logs are history: they cannot be rebuilt either, but losing
them costs re-extraction and lost measurements, not facts. `index.db`, the extractor's scratch
files and the extraction lock are disposable, and the index rebuilds itself. Nothing on disk
said which was which, so neither a backup nor a clean-up could be done without reading the
code first.

The repo is also being packaged as a Claude Code plugin, which offers `${CLAUDE_PLUGIN_DATA}`
as a data directory.

## Decision

**The root keeps its location and its override, and under it each file goes in the group
that says how replaceable it is:**

```
<root>/
  corpus/   topics/*.md, toc.json                                the source of truth
  ledger/   state.json, sessions.jsonl, spend.jsonl, search.log   history
  config/   smoke-queries.json, model-rates.json                  hand-edited settings
  cache/    index.db (+ -wal, -shm), extractor/, extraction.lock  disposable
```

`corpus/` is what a backup has to cover, and all it has to cover. `ledger/` cannot be rebuilt
either, but nothing in it is a fact. `config/` is written by a person and never by the code.
`cache/` is safe to delete while nothing is running: the index is rebuilt on the next open,
and the extractor's scratch files and the lock exist only for the length of a run.

`toc.json` records each topic's file relative to itself, as `topics/<id>.md`. Both now sit in
`corpus/`, so those entries are unchanged.

**The root is not in `${CLAUDE_PLUGIN_DATA}`.** Claude Code deletes that directory when the
plugin is uninstalled, and the corpus is the one thing this project must never lose.
Uninstalling to reinstall is routine; it must not cost four months of facts.

**Each writer creates its own file's directory** before writing, rather than the root. A
fresh root gets only the groups something has written to.

## Consequences

- An existing root must be migrated before this code runs against it. Code on the new
  layout that finds a flat root sees an empty corpus and an empty ledger: the next sweep
  would re-extract every session into a second corpus beside the old files. The migration
  moves each file into its group, and the old files are untouched until then.
- The extractor's working directory moves to `cache/extractor/`. The sweep's guard against
  ingesting the extractor's own transcripts (ADR 0011, layer 2) still looks for them under
  the project directory named after `<root>/extractor`, where the pre-Bedrock transcripts
  are. Nothing new lands there since ADR 0012, and the guard and that path go together.
- `config/` does not exist until someone creates a settings file. Its absence is the
  default, and both files in it are optional.
- Deleting `cache/` while an extraction is running removes the lock under it, and a second
  extractor could then start beside the first. "Safe to delete" means when nothing is
  running.
