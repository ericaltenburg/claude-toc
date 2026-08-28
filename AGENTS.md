# claude-toc

Topic-scoped memory for Claude Code: distil past sessions into per-topic fact files, then query them on demand.

## Status: the code on disk is a POC whose retrieval half never ran

Read this before trusting anything in `hooks/` or `src/`.

The write path works and has produced a real corpus (41 topic files, four months). The read path has never executed once: `toc-logger.cjs` emits `hookSpecificOutput` without the required `hookEventName`, so every payload was rejected from the initial commit onward. Its keyword matcher is also unsafe, doing raw substring tests that match `tps` inside every `https://`.

Both are being replaced rather than fixed. Treat the existing injection code as an artifact.

## Design

`docs/superpowers/specs/2026-08-28-claude-toc-pull-memory-design.md` is authoritative for architecture, schema, components, and rollout. Read it before changing `hooks/` or `src/`.

The shape in one line: a `UserPromptSubmit` hook sweeps transcript mtimes and spawns detached extraction, and retrieval happens only when the user runs `/toc-search`.

Retrieval is **pull**. The user asks; nothing is injected speculatively. Earlier versions of this file claimed the opposite.

## Working here

**The corpus lives outside this repo, at `~/.claude/claude-toc/`.** This repo is public and the corpus is distilled from work sessions, holding internal service names, account ids, ticket ids, and hostnames. Keeping it here meant one `git add -A` from publishing it, so it moved out. Only source and planning docs live in the repo. Write corpus data to `~/.claude/claude-toc/`, never under the repo. Test fixtures and doc examples use synthetic facts; the eval's expected values live with the corpus.

**Markdown is the source of truth.** `topics/*.md` and `toc.json` are canonical; `index.db` is derived, so dropping and rebuilding it is always safe. The corpus is irreplaceable and has no git backup, so treat local deletion as permanent.

**Extraction eats its own output unless excluded.** `claude -p` persists a session transcript, so extractor runs land in `~/.claude/projects/` looking exactly like real work, and 82 such transcripts already exist. Anything that globs transcripts filters them by the `--session-id` values recorded in `~/.claude/claude-toc/state.json` and by the extractor's fixed cwd.

**Hooks exit 0 and write nothing.** A hook emitting a malformed payload discards its own output and surfaces an error on every prompt the user sends. The sweep hook does glob, stat, spawn, exit.

**Facts carry a date and a session id**, as `- text [session:abcd1234, 2026-08-27]`. An older bare `[2026-08-27]` form also exists in the corpus, so parsers accept both.

## Constraints

- Hooks: Node stdlib only, CommonJS, complete in under 5 seconds. `src/` may take dependencies.
- Extraction runs on Bedrock through the `claudecode` AWS profile, requiring ada credentials.
- Extraction uses Haiku 4.5, falling back to Sonnet 5 when a slice exceeds the 200K context window.
