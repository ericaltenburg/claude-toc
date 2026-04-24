# Phase 1: Topic & Fact Deduplication - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Prevent duplicate topics and redundant facts from accumulating in memory. Clean up existing duplicates. Add session traceability to facts. Remove dead code from pre-hook era.

</domain>

<decisions>
## Implementation Decisions

### Topic similarity matching
- **D-01:** Combined approach — prompt-side (feed existing topic IDs + summaries into extraction prompt so Claude picks existing topics) plus code-side safety net (similarity score after extraction)
- **D-02:** Similarity score uses Jaccard similarity on keyword sets + word overlap on topic IDs, keywords weighted heavier
- **D-03:** Threshold 0.6 — at or above merges into existing topic, below creates new topic
- **D-04:** On merge: existing topic ID wins, new keywords get merged into existing topic's keyword list
- **D-05:** No npm packages — similarity functions hand-rolled (Node.js stdlib only constraint)

### Fact dedup strategy
- **D-06:** Prompt-side is the primary dedup mechanism — feed existing facts from matched topic into extraction prompt so Claude skips already-known information
- **D-07:** Code-side stays simple: keep existing 60-char substring check + add basic normalized word overlap as safety net
- **D-08:** No sophisticated code-side algorithm — Phase 3 embeddings will handle remaining edge cases

### Topic merging
- **D-09:** Two triggers: standalone `node src/analyze.js --dedup` for initial cleanup + opportunistic during normal analysis when safety net detects duplicates
- **D-10:** Winner selection: topic with more entries wins, tie-break by older topic
- **D-11:** Merge all facts first, dedup after — never drop facts during transfer. Information loss is unacceptable.
- **D-12:** Keyword union, keep longer/more detailed summary
- **D-13:** Losing topic file renamed to `{topic_id}.merged.md` as tombstone — non-destructive. Data recoverable via `ls memory/topics/*.merged.md`
- **D-14:** TOC entry removed for losing topic, winner's entry count and keywords updated

### Session traceability
- **D-15:** Inline format optimized for LLM parsing: `- fact text [session:SHORT_ID, DATE]`
- **D-16:** `session:` prefix provides semantic label so Claude understands it's a source reference
- **D-17:** 8-char session ID prefix (sufficient to locate transcript)

### Agent's Discretion
- Exact Jaccard + word overlap weighting formula
- Normalized comparison implementation details for the code-side safety net
- How to handle summary combination when merging topics with different-angle summaries
- Order of operations during the `--dedup` standalone pass

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core files to modify
- `src/analyze.js` — Main analyzer, needs TOC-aware extraction prompt, post-extraction similarity check, merge logic, `--dedup` flag
- `src/toc.js` — TOC operations, needs similarity scoring functions, merge support, updated `appendToTopic` for session refs

### Current data format
- `memory/toc.json` — Live TOC with existing duplicate example (`broadcast_variants_update` + `alcs_broadcast_variants`)
- `memory/topics/*.md` — Topic files showing current fact format (date only, no session ref)

### Dead code to remove
- `src/cli.js` — Replaced by hooks + toc.js
- `src/manifest.js` — Replaced by toc.js
- `src/memory.js` — Replaced by toc.js
- `src/retrieve.js` — Replaced by toc.js

### Hooks (read-only context)
- `hooks/toc-auto-analyze.cjs` — SessionEnd hook that triggers analysis, passes session_id
- `hooks/toc-logger.cjs` — UserPromptSubmit hook for session capture
- `hooks/toc-inject.cjs` — Context injection hook

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `toc.js:upsertTopic()` — Already handles keyword merging via Set union, can be extended for similarity-based routing
- `toc.js:appendToTopic()` — Has 60-char substring dedup, needs session ref format update
- `toc.js:resolveTopic()` / `resolveAllTopics()` — Keyword matching logic, similarity scoring builds on this pattern

### Established Patterns
- ESM modules (`import`/`export`) in `src/`, CommonJS (`require`) in `hooks/`
- Claude invoked via `execSync("claude -p")` with Bedrock env vars
- Flat file storage: JSON for indexes, markdown for content
- JSONL for session logs

### Integration Points
- `analyze.js:extract()` — Extraction prompt needs existing TOC + facts injected
- `analyze.js:analyzeSession()` — Post-extraction needs similarity check before `upsertTopic`
- `analyze.js:main()` — Needs `--dedup` flag handling
- `toc.js:appendToTopic()` — Fact line format changes from `[DATE]` to `[session:ID, DATE]`

</code_context>

<specifics>
## Specific Ideas

- The existing `broadcast_variants_update` / `alcs_broadcast_variants` pair in toc.json is the perfect test case for the dedup pass
- Tombstone pattern (`.merged.md`) chosen specifically because information loss is the worst failure mode — always recoverable

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-topic-fact-dedup*
*Context gathered: 2026-04-24*
