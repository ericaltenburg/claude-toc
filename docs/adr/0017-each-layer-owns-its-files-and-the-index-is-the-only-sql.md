# ADR 0017: Each layer owns its files on disk, and the index is the only code that speaks SQL

**Status:** accepted (2026-09-26)

## Context

`src/` was fifteen flat modules, each doing one job, with the seams between them leaking:

- **The fact-line format had two owners.** `toc.js` wrote a line and re-parsed its own lines to merge and dedupe, and `parse.js` parsed them for the index with its own pattern for the `[session:x, YYYY-MM-DD]` suffix. #23 lived in that gap: a merge moved a raw line back through the writer and attributed it a second time.
- **Four modules wrote SQL.** `search-index.js` owned the schema, `search.js` built the query plans, `extract.js` ran four queries of its own and imported a raw SQL fragment to join facts to sessions, and `status.js` ran its statistics. Changing a table meant finding all four.
- **Two lists of which sessions exist.** `toc-extract --sweep` scanned transcripts on disk, while the listing, `--all`, `<prefix>` and `--retry` read `sessions.jsonl`, so they could disagree about what there was to extract.
- **Dependencies pointed both ways.** The write path imported read-path helpers (`salientTermsQuery`, `recordedProjectsUnder`), and the derived index imported the write path's stores.
- **`parse.js` did five unrelated jobs**: the fact line, time zones, JSON lines, prompt-log records and session records.

## Decision

The code is layered, and each layer owns its files on disk. Any other layer goes through its functions.

```
src/corpus/    topics.js, format.js        topic markdown and toc.json, the source of truth
src/sessions/  transcript.js, registry.js, progress.js, known-sessions.js
                                           transcripts (read only), sessions.jsonl, state.json
src/extract/   extractor.js, prompt.js, bedrock.js, spend.js, lock.js, sweep.js
                                           the write path, the spend log, the extraction lock
src/index/     open.js, refresh.js, queries.js, terms.js
                                           index.db: the only code that opens SQLite
src/search/    search.js, log.js           the read path and the search log
src/status/    status.js                   one reading of every layer
src/cli/       the commands, thin
```

- **`corpus/format.js` is the only code that knows the fact-line format**, read and write, with one pattern for the attribution suffix. A line the writer produces parses back to the same text, session and date, and a test holds that.
- **`index/` is the only code that speaks SQL.** Search, extraction and status ask it intention-named questions (the facts ranked against a match, a session's own facts, a project's topics, the statistics) and never hold the database themselves. The one exception is `--sql`, which stays an index function under `pragma query_only`.
- **Dependencies point one way:** `cli` and `hooks` → `extract`, `search`, `status` → `index` → `corpus`, `sessions`. `corpus` and `sessions` import nothing from any other layer, which is why `write-atomically.js` sits at the root, where both can write through it. `status` reads every layer, because reporting on all of them is its job.
- **There is one list of sessions.** `sessions/known-sessions.js` is the union of the transcripts on disk (skipping the extractor's own, per ADR 0011) and `sessions.jsonl`, which remembers sessions whose transcripts have rotated away. The sweep filters that list by idle, unread and not quarantined, and every other command reads the same list.
- **The index is rebuilt only when it cannot be read**, meaning a schema version other than its own or a file that is not a database. A lock held by another process is waited out (the busy timeout) or rethrown, never answered by deleting an index someone else is writing.

## Consequences

- A change to the fact-line format touches one module, and so does a change to a table. The schema additions that follow this (new sections and supersession) are sized by that.
- Older ADRs name files by the paths they had when they were written. They are left as written, and this table maps them:

| Named in older ADRs | Now |
|---|---|
| `toc.js` | `corpus/topics.js` |
| `parse.js` | `corpus/format.js` (fact lines), `local-time.js`, `json-lines.js`, `index/refresh.js` (prompt records), `sessions/registry.js` (session records) |
| `session-index.js` | `sessions/registry.js` |
| `state.js` | `sessions/progress.js` |
| `transcript.js` | `sessions/transcript.js` |
| `extract.js`, `extract-prompt.js` | `extract/extractor.js`, `extract/prompt.js` |
| `bedrock.js`, `spend.js`, `sweep.js`, `extraction-lock.js` | `extract/bedrock.js`, `extract/spend.js`, `extract/sweep.js`, `extract/lock.js` |
| `search-index.js` | `index/open.js`, `index/refresh.js` |
| `search.js` | `search/search.js`, `search/log.js`, `index/queries.js`, `index/terms.js` |
| `status.js` | `status/status.js` |
| `format.js` | `numbers.js` |
