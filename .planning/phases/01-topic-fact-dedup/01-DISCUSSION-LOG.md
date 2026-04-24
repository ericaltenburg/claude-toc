# Phase 1: Topic & Fact Deduplication - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 01-topic-fact-dedup
**Areas discussed:** Topic similarity matching, Fact dedup strategy, Topic merging, Session traceability

---

## Topic Similarity Matching

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-extraction (prompt-side) | Inject existing topic IDs + summaries into extraction prompt so Claude picks existing topics | |
| Post-extraction (code-side) | Compare returned topic ID against existing topics using keyword overlap or string similarity | |
| Combined (both) | Prompt-side first, code-side safety net with similarity scoring | ✓ |

**User's choice:** Combined approach with similarity threshold
**Notes:** Threshold set at 0.6. Jaccard on keywords + ID word overlap. On merge, existing topic ID wins but new keywords get merged in. No npm packages — hand-rolled similarity.

---

## Fact Dedup Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Prompt-side primary | Feed existing facts into extraction prompt so Claude skips known info | ✓ |
| Sophisticated code-side | TF-IDF or word frequency weighting for code-side dedup | |
| Embeddings | Semantic similarity via embeddings | |

**User's choice:** Prompt-side as primary mechanism, simple code-side safety net
**Notes:** User considered whether to innovate here. Conclusion: lean on Claude's judgment during extraction (that's where the intelligence is), keep code-side simple (existing substring check + basic normalized overlap), and let Phase 3 embeddings close remaining gaps. Don't build a sophisticated algorithm that gets replaced in two phases.

---

## Topic Merging

| Option | Description | Selected |
|--------|-------------|----------|
| On-demand only | Opportunistic merge during normal analysis | |
| Standalone only | Separate `--dedup` command for cleanup | |
| Both | Standalone for initial cleanup + opportunistic going forward | ✓ |

**User's choice:** Both triggers, with non-destructive tombstone pattern
**Notes:** Key requirement from user: "if information is lost this is useless." Merge contract: transfer all facts first, dedup after. Losing topic renamed to `.merged.md` as tombstone. Winner = more entries, tie-break older. Keyword union, longer summary kept.

---

## Session Traceability

| Option | Description | Selected |
|--------|-------------|----------|
| Inline tag (Option A) | `- fact [session:ID, DATE]` with semantic prefix | ✓ |
| Separate metadata block | Sources table at bottom of topic file | |
| Compact inline | `- fact [ID DATE]` without prefix | |

**User's choice:** Inline with `session:` prefix
**Notes:** User reframed the question — optimize for LLM parseability, not human readability. The `session:` prefix acts as a semantic label so Claude understands it's a source reference. 8-char session ID prefix sufficient to locate transcript.

---

## Agent's Discretion

- Exact similarity weighting formula (Jaccard + word overlap)
- Normalized comparison details for code-side safety net
- Summary combination strategy during merges
- Order of operations in `--dedup` standalone pass

## Deferred Ideas

None — discussion stayed within phase scope
