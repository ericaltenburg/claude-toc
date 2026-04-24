# Requirements: claude-toc

**Defined:** 2026-04-24
**Core Value:** Conversations with Claude should build persistent, structured knowledge that improves future sessions automatically — no manual memory management required.

## v1 Requirements

### Topic Management

- [ ] **TOPC-01**: Analyzer checks existing TOC before creating new topics — merges into existing when semantically similar
- [ ] **TOPC-02**: Topics with overlapping keywords/content are detected and merged into a single topic file
- [ ] **TOPC-03**: Merged topics combine context entries, decisions, and keywords without duplication

### Fact Quality

- [ ] **FACT-01**: Extraction prompt receives existing topic facts so Claude skips already-known information
- [ ] **FACT-02**: Near-duplicate facts within a topic are detected and deduplicated
- [ ] **FACT-03**: Facts include source session reference for traceability

### Working Memory

- [ ] **WMEM-01**: PreCompact hook captures current task, immediate goals, and unresolved threads before context compaction
- [ ] **WMEM-02**: Working memory is injected into the session after compaction to preserve near-term intent
- [ ] **WMEM-03**: Working memory is ephemeral — cleared when session ends, not persisted to topic memory

### Semantic Retrieval

- [ ] **SEMR-01**: Topic detection uses embedding similarity instead of keyword matching
- [ ] **SEMR-02**: Embeddings are generated for each topic and stored alongside the TOC
- [ ] **SEMR-03**: User prompts are embedded at query time and matched against topic embeddings
- [ ] **SEMR-04**: Keyword matching remains as fallback when embedding service is unavailable

### Relevance Scoring

- [ ] **RELV-01**: Facts have importance scores based on recency and frequency of access
- [ ] **RELV-02**: Stale facts decay in importance over time
- [ ] **RELV-03**: Context injection prioritizes high-importance facts within the token budget
- [ ] **RELV-04**: Sentiment and time-delta metadata captured per interaction to weight urgency

## v2 Requirements

### Storage Migration

- **STOR-01**: Migrate from flat files to SQLite when topic count exceeds threshold
- **STOR-02**: Full-text search across all topics via FTS5

### Visualization

- **VIZL-01**: Debug command to inspect what context would be injected for a given prompt
- **VIZL-02**: Topic graph showing relationships between topics

### Memory Hygiene

- **HYGN-01**: Versioned memory history (git-tracked or append-only log)
- **HYGN-02**: Ability to manually edit/delete facts from topics

## Out of Scope

| Feature | Reason |
|---------|--------|
| Standalone CLI chat interface | Hooks approach replaced it — no separate REPL needed |
| Multi-user memory | Single-user tool, no sharing needed |
| GUI/web interface | CLI-native, inspect via cat/grep |
| Real-time streaming analysis | Batch/periodic is sufficient for this use case |
| Full Claude Code fork | Maintenance burden outweighs benefits |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TOPC-01 | Phase 1 | Pending |
| TOPC-02 | Phase 1 | Pending |
| TOPC-03 | Phase 1 | Pending |
| FACT-01 | Phase 1 | Pending |
| FACT-02 | Phase 1 | Pending |
| FACT-03 | Phase 1 | Pending |
| WMEM-01 | Phase 2 | Pending |
| WMEM-02 | Phase 2 | Pending |
| WMEM-03 | Phase 2 | Pending |
| SEMR-01 | Phase 3 | Pending |
| SEMR-02 | Phase 3 | Pending |
| SEMR-03 | Phase 3 | Pending |
| SEMR-04 | Phase 3 | Pending |
| RELV-01 | Phase 4 | Pending |
| RELV-02 | Phase 4 | Pending |
| RELV-03 | Phase 4 | Pending |
| RELV-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-24*
*Last updated: 2026-04-24 after initial definition*
