# claude-toc: Pull-Based Queryable Memory

**Date:** 2026-08-28
**Status:** Approved, not yet implemented
**Supersedes:** the retrieval half of `design.md` (topic routing plus per-prompt injection)

## Problem

claude-toc was built to replace lossy context compression with topic-scoped memory and dynamic retrieval. The write half works. The read half has never worked, and if it had worked it would have been harmful.

Measured findings from investigating the running system on 2026-08-28:

1. **Injection never fired once.** `hookSpecificOutput` in `toc-logger.cjs` has always omitted the required `hookEventName` field. The file has exactly one commit (`d579ab8`, "initial: claude-toc POC"), so every payload has been rejected since 2026-04-23. Four months, 212 logged sessions, zero retrievals.
2. **The matcher would have injected mostly noise.** Replaying the real matcher against all 4650 prompts in `~/.claude/history.jsonl`: 73.5% of prompts matched at least one topic, averaging 1788 injected chars, 6.1M chars total. The matcher does a raw substring test with no word boundary and no minimum keyword length, and 113 of 1025 keywords are 4 chars or shorter. `tps` matched 373 prompts but is a whole word in 3, because it is inside every `https://`. `cti` matched 227 with 4 real hits, via `action` and `function`. `pd` matched 152 with 0 real hits, via `update`.
3. **Coverage is 17%.** 738 transcripts exist on disk; `processed.json` has 126 entries. The per-10-turn and SessionEnd triggers miss most sessions. Note the counts do not subtract cleanly: of those 126 processed sessions only about 42 still have transcripts on disk, the rest having rotated away. So the unprocessed, non-extractor total is 738 minus 42 minus 82, which is the 614 figure used throughout this document.
4. **The extractor pollutes its own corpus.** 82 transcripts contain the extraction prompt, because `claude -p` persists sessions into whichever project dir the hook inherited. None have been ingested yet only because the current code never globs. Glob-based sweeping would activate this latent recursion.
5. **Temporal queries are unserved.** Dates exist only as text inside markdown lines (`[session:abcd1234, 2026-08-27]`), not as queryable fields. Reconstructing "what did we do yesterday" required falling back to `history.jsonl`; the curated corpus could not answer it.

Underlying all of it: the project defined success criteria (reduced repetition, lower token usage, higher relevance) and never measured any of them. That absence is why a completely dead code path survived four months unnoticed.

## Approach

Invert the model. Stop pushing speculative context into every prompt; expose memory as something queried on demand.

| Decision | Choice | Rationale |
|---|---|---|
| Who retrieves | You only, explicitly, via `/toc-search` | Precision stops being critical because nothing is spent unless asked. Removes the injection failure mode entirely. |
| Corpus | Distilled topic facts plus `history.jsonl` prompts | Facts carry the insight, prompts carry the timeline. Reconstructing 8/27 needed both. |
| Query translation | Claude writes the SQL | No date parser or NL layer to build. Handles vague and temporal questions natively. Claude is already in the loop the moment the command is typed. |
| Extraction trigger | `UserPromptSubmit` hook sweeping transcript mtimes | Independent of sessions ever being killed. No daemon. No query latency. |
| Storage | SQLite FTS5 as a derived index over markdown | Word-boundary tokenization kills the substring bug by construction. Compact aggregated results cost fewer tokens per query than raw grep matches. |
| Extraction model | Haiku 4.5, Sonnet 5 fallback | $1/$5 per 1M versus $5/$25 for the current Opus 4.6. Fact extraction is information retrieval, not reasoning. |
| Backfill | All 614 unprocessed transcripts, newest first | Search quality is bounded by coverage. |

Markdown stays the source of truth. `index.db` is disposable and rebuildable, so the corpus is never trapped in a binary and stays greppable and git-diffable.

## Architecture

```
SOURCES (owned by Claude Code, never written by us)
  ~/.claude/projects/**/*.jsonl     full transcripts, both sides
  ~/.claude/history.jsonl           prompts, timestamps, project paths

WRITE PATH (expensive, async, best-effort)
  UserPromptSubmit hook
    -> toc-sweep.cjs: glob + stat, debounce, lock, pick <=3 idle candidates
    -> spawn detached, exit 0 immediately, emit nothing
         -> extract.js per session: read slice from recorded offset,
            call Haiku, upsert topic, append dated facts, advance offset

INDEX PATH (cheap, derived, disposable)
  index-build.js: memory/topics/*.md + toc.json + history.jsonl -> memory/index.db

READ PATH (on demand)
  /toc-search "what did we do yesterday"
    -> refresh index incrementally
    -> Claude writes SQL, runs it via sqlite3, summarizes rows
```

Freshness is tiered on purpose. Prompts are indexed with no model call, so recent activity is queryable immediately. Distilled facts lag by the idle threshold.

Two load-bearing properties:

- **The hook never blocks and never speaks.** Glob, stat, spawn, exit 0, empty stdout. No `additionalContext` means no injection, no relevance guessing, and no payload that can fail validation.
- **`index.db` is disposable.** Everything in it is reconstructible from markdown plus `history.jsonl`.

Defaults, all configurable: idle threshold 60 min, sweep debounce 60 s, max 3 sessions per sweep so a backlog drains gradually, single extraction lock.

## Schema

```sql
CREATE TABLE topics (
  id TEXT PRIMARY KEY, summary TEXT, keywords TEXT,
  last_active TEXT, fact_count INTEGER
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY, topic_id TEXT NOT NULL,
  section TEXT,                     -- 'context' | 'decisions'
  text TEXT NOT NULL,
  session_id TEXT, fact_date TEXT,  -- YYYY-MM-DD, NULL if unparseable
  source_file TEXT, line_no INTEGER
);
CREATE INDEX idx_facts_date    ON facts(fact_date);
CREATE INDEX idx_facts_topic   ON facts(topic_id);
CREATE INDEX idx_facts_session ON facts(session_id);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
  local_date TEXT NOT NULL, local_time TEXT,
  session_id TEXT, project TEXT, text TEXT NOT NULL, is_slash INTEGER
);
CREATE INDEX idx_prompts_date    ON prompts(local_date);
CREATE INDEX idx_prompts_session ON prompts(session_id);
CREATE INDEX idx_prompts_project ON prompts(project);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, project TEXT, transcript_path TEXT,
  first_ts INTEGER, last_ts INTEGER, prompt_count INTEGER,
  extracted_offset INTEGER, extracted_at TEXT, topic_id TEXT
);

CREATE VIRTUAL TABLE facts_fts   USING fts5(text, content='facts',   content_rowid='id', tokenize='porter unicode61');
CREATE VIRTUAL TABLE prompts_fts USING fts5(text, content='prompts', content_rowid='id', tokenize='porter unicode61');
```

Three deliberate choices:

- **`local_date` is precomputed at index time.** SQLite has no local timezone. Computing "yesterday" in SQL would silently use UTC and misfile everything after 8pm Eastern.
- **`section` preserves facts versus decisions.** This is the differentiator `design.md` claims over claude-mem, and current retrieval discards it by flattening every `- ` line into one stream.
- **FTS5 external-content tables** index without duplicating text. `porter unicode61` gives word-boundary tokenization plus stemming, which is where the substring bug dies.

## Components

| File | Job |
|---|---|
| `hooks/toc-sweep.cjs` | Hook entry. Glob, stat, debounce, lock, pick candidates, detached spawn, exit 0, emit nothing. |
| `src/extract.js` | One session slice to facts. Existing `analyze.js` logic plus `--session-id`, fixed cwd, Haiku, chunking with Sonnet 5 fallback. |
| `src/index-build.js` | Markdown plus `history.jsonl` to `index.db`. Idempotent; incremental and full rebuild. |
| `src/schema.sql` | Schema above, with a `schema_version` row. |
| `src/backfill.js` | One-off 614-session run. Resumable, rate-limited, newest first, excludes the 82 by content sniff. |
| `~/.claude/skills/toc-search/SKILL.md` | Read path. Schema reference, query recipes, presentation rules. |
| `memory/state.json` | Offsets, excluded session ids, fail counts, last-swept timestamp. |

**Removed:** `hooks/toc-inject.cjs`, the injection block in `toc-logger.cjs` (lines 54 to 101), the `SessionEnd` hook registration, the keyword matcher in `src/toc.js`, `src/read-session.js` (superseded by SQL), the `ANALYZE_EVERY` turn counters and their 208 leaked `.turns-*` files, `processed.json` and `.analyzing` (folded into `state.json`).

**The markdown parser must accept both existing fact formats:** `- text [session:abcd1234, 2026-08-27]` and the older bare `- text [2026-08-27]` that `toc.js:119` also strips. Lines matching neither get `fact_date NULL` rather than being dropped.

**Index refresh happens inside `/toc-search`.** Incremental over 41 files and 4650 prompts is sub-second, so there is no separate refresh trigger and no staleness question on the read path.

### Excluding the extractor's own sessions

Four layers, first is authoritative:

1. **We own the session id.** Spawn `claude -p --session-id <uuid>`, writing that uuid into `state.json` before the spawn. The sweeper skips any id in the set.
2. **Fixed cwd.** Spawn with cwd set to the claude-toc directory so extractor transcripts land in one predictable project dir excluded by path. Also stops polluting real project dirs, which happens today.
3. **Keep the `TOC_ANALYZING=1` env guard** so a hook firing inside the extractor exits immediately.
4. **One-time content sniff for backfill only**, matching the extraction-prompt marker in the first few KB, since the existing 82 predate the id registry.

## Error handling

The hook is the highest-stakes component because it runs on every message. Its contract is absolute: wrap the entire body in try/catch, exit 0 on any failure, never write to stdout or stderr. A broken sweep must be invisible.

Extraction failures do not advance the offset, so the slice retries next sweep. `state.json` carries a per-session `fail_count` and quarantines after 3 attempts, surfaced by `/toc-search --health` rather than skipped silently.

| Failure | Handling |
|---|---|
| Model returns non-JSON | Strip fenced blocks, retry parse once, else no offset advance and `fail_count`++ |
| Slice exceeds Haiku's 200K context | Split into chunks; a failing chunk escalates to Sonnet 5; then quarantine |
| Stale lock | Break locks older than 15 min; keep the existing 5-min mtime check for the normal path |
| Concurrent sessions firing the hook | Single extraction lock plus the 60 s debounce |
| `index.db` corrupt or schema drift | `schema_version` mismatch triggers drop and full rebuild, always safe since derived |
| Malformed `history.jsonl` line | Skip per line, never abort the build |
| Transcript missing | Tolerated. About 84 processed sessions have already rotated away; `sessions` row keeps a null `transcript_path` |

Topic markdown writes are append-only and happen only after the model call succeeds, so a crash cannot leave a half-written fact.

## Testing

The gap that let this project die quietly was having success criteria and never measuring them, so the important test is not a unit test.

**Golden-query eval, run after every index build.** A dozen questions with known-correct answers, seeded from the 2026-08-27 reconstruction already verified by hand:

- "what did we do yesterday" surfaces the OpenSearch i8g migration, the ALCS appupgrade MCM, and the ALVSS lambda work
- "when did we decide on i8g over i7i" returns a fact dated 2026-08-27
- "opensearch masters" ranks `opensearch_i3_to_i8g_migration` first

If the suite passes and a query still feels wrong, the suite was incomplete and gains a case.

**Unit tests** where silent wrongness is likely: the markdown fact parser across both date formats plus malformed and unicode lines, `local_date` across a DST boundary and an after-8pm-Eastern timestamp, offset advancement, exclusion-set handling.

**Two regression guards for bugs found on 2026-08-28:**

1. Query `tps` must not match a prompt containing `https://`; query `pd` must not match `update`
2. An extractor-generated transcript must never be selected as a sweep candidate

**Hook safety test:** garbage on stdin yields exit 0 and empty stdout.

## Rollout

Ordered so the cheap, reversible parts prove the idea before money is spent.

1. **Read path first, zero extraction.** Index the existing 41 topics and 4650 prompts. Verify `/toc-search` reproduces the 8/27 reconstruction. If search is not useful against the corpus that already exists, stop here having spent nothing.
2. **Wire the sweep hook.** Watch for a day on new sessions: no hook errors, offsets advancing, extractor sessions excluded.
3. **Backfill in batches of ~50, newest first.** Cost checkpoint after batch one to validate the estimate before committing to all 614.
4. **Fix git hygiene.** Gitignore `memory/` runtime state and `index.db`; keep the 41 topic files tracked. Clears the 244 dirty files.

Step 1 is the honest kill point. If the read path is not worth it, the right answer is to delete the project, known for the price of an afternoon rather than a backfill.

## Cost

215 MB of raw transcript JSON across 614 files, median 152 KB, 24 over 1 MB, largest 7.95 MB. Text extraction strips tool results and JSON overhead, leaving order-of-10M input tokens. At Haiku 4.5 rates that is roughly $15 one-off, against roughly $75 on the current Opus 4.6. Steady state is one small incremental slice per idle session.

These are first-party API rates. Extraction currently runs through Bedrock (`AWS_PROFILE: claudecode`, model id `global.anthropic.claude-opus-4-6-v1`), so partner pricing applies and the relative ordering holds rather than the absolute numbers.

## Out of scope

- **Embedding retrieval.** FTS5 with bm25 first. `sqlite-vec` is a clean later addition in the same store if keyword search proves insufficient.
- **Push injection.** Explicitly rejected. If ever revisited, it needs word-boundary matching, minimum 5-char keywords, and a 2-hit threshold, which fires on 14.9% of prompts rather than 73.5%, and it needs the eval to show it helps.
- **Working memory / `PreCompact`.** Phase 2 of the old roadmap. Valuable and independent; separate spec.
- **Full transcripts and git commits in the index.** Deferred; the two chosen sources answer the queries that motivated this.
- **Sentiment and urgency scoring.** Phase 4 of the old roadmap.

## Open questions

- The exact Bedrock model id for Haiku 4.5 needs verifying against what the `claudecode` profile exposes. The first-party id is `claude-haiku-4-5`.
- Whether `/toc-search` should default to searching both facts and prompts, or take a flag to scope to one. Resolve after step 1, against real queries.
