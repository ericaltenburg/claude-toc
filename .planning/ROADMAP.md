# Roadmap: claude-toc

**Created:** 2026-04-24
**Milestone:** v1.0
**Phases:** 4
**Granularity:** Coarse

## Phase 1: Topic & Fact Deduplication

**Goal:** Eliminate duplicate topics and redundant facts so memory stays clean as sessions accumulate.

**Requirements:** TOPC-01, TOPC-02, TOPC-03, FACT-01, FACT-02, FACT-03

**Success Criteria:**
1. Analyzing the same conversation twice does not create a second topic
2. Existing facts are passed to the extraction prompt and Claude skips known information
3. Near-duplicate facts within a topic file are detected and removed
4. Each extracted fact includes a session reference for traceability

**Scope:**
- Update analyzer to load TOC and find semantically similar topics before creating new ones
- Update extraction prompt to include existing facts from matched topic
- Add dedup pass on topic files (substring + normalized comparison)
- Add session_id reference to fact entries
- Remove dead code: src/cli.js, src/manifest.js, src/memory.js, src/retrieve.js (replaced by hooks + toc.js)

## Phase 2: Working Memory

**Goal:** Preserve near-term intent across context compaction so Claude doesn't lose track of what you're doing mid-session.

**Requirements:** WMEM-01, WMEM-02, WMEM-03

**Depends on:** Phase 1 (clean topic memory needed for working memory to be useful)

**Success Criteria:**
1. PreCompact hook fires before context compaction and captures current task + goals
2. Working memory is injected into the session after compaction
3. Working memory is cleared when session ends — not persisted to topic files

**Scope:**
- Create PreCompact hook that extracts current task, goals, unresolved threads
- Store as ephemeral working_memory.json per session
- Inject working memory via PostCompact or next UserPromptSubmit
- SessionEnd hook cleans up working memory files

## Phase 3: Embedding-Based Retrieval

**Goal:** Replace keyword matching with semantic similarity so topics are found even when the user doesn't use exact keywords.

**Requirements:** SEMR-01, SEMR-02, SEMR-03, SEMR-04

**Depends on:** Phase 1 (deduplicated topics needed for clean embeddings)

**Success Criteria:**
1. Each topic has an embedding vector stored alongside the TOC
2. User prompts are embedded and matched against topic embeddings
3. Semantic match finds relevant topics that keyword matching would miss
4. System falls back to keyword matching when embedding service is unavailable

**Scope:**
- Choose embedding provider (Bedrock Titan Embeddings or local)
- Generate embeddings for each topic on creation/update
- Embed user prompts in UserPromptSubmit hook
- Cosine similarity matching with configurable threshold
- Keyword fallback when embeddings fail

## Phase 4: Relevance Scoring & Decay

**Goal:** Prioritize fresh, frequently-accessed facts over stale ones so context injection stays relevant as memory grows.

**Requirements:** RELV-01, RELV-02, RELV-03, RELV-04

**Depends on:** Phase 1 (fact traceability needed for scoring), Phase 3 (embeddings improve retrieval quality)

**Success Criteria:**
1. Facts have importance scores based on recency and access frequency
2. Stale facts decay in importance over time
3. Context injection selects highest-importance facts within token budget
4. Sentiment/urgency metadata is captured and influences scoring

**Scope:**
- Add importance score metadata to facts (initial score + decay formula)
- Track access frequency (increment when fact is injected)
- Update context retrieval to sort by importance score
- Add sentiment analysis to UserPromptSubmit hook
- Time-delta tracking between interactions

---

## Phase Summary

| # | Phase | Requirements | Success Criteria |
|---|-------|-------------|------------------|
| 1 | Topic & Fact Deduplication | TOPC-01, TOPC-02, TOPC-03, FACT-01, FACT-02, FACT-03 | 4 | ✓ Complete (2026-04-24) |
| 2 | Working Memory | WMEM-01, WMEM-02, WMEM-03 | 3 |
| 3 | Embedding-Based Retrieval | SEMR-01, SEMR-02, SEMR-03, SEMR-04 | 4 |
| 4 | Relevance Scoring & Decay | RELV-01, RELV-02, RELV-03, RELV-04 | 4 |

---
*Roadmap created: 2026-04-24*
*Last updated: 2026-04-24 after initialization*
