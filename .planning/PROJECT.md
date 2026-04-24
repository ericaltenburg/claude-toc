# claude-toc

## What This Is

A topic-scoped memory system for Claude Code that replaces lossy context summarization with structured, topic-aware memory. It passively captures conversations via hooks, extracts durable facts and decisions into topic files, and dynamically injects relevant context back into sessions — all without user intervention.

## Core Value

Conversations with Claude should build persistent, structured knowledge that improves future sessions automatically — no manual memory management required.

## Requirements

### Validated

- ✓ Passive session capture via UserPromptSubmit hook — v0.1
- ✓ Session indexing with transcript path tracking — v0.1
- ✓ Topic-based memory storage (TOC → topic markdown files) — v0.1
- ✓ Keyword-based topic routing — v0.1
- ✓ Automated extraction of facts/decisions via Claude — v0.1
- ✓ Context injection at session start (TOC) — v0.1
- ✓ Per-turn context injection on keyword match — v0.1
- ✓ Periodic mid-session analysis (every N turns) — v0.1
- ✓ Background analysis on session end — v0.1

### Active

- [ ] Topic deduplication — analyzer checks existing topics before creating new ones
- [ ] Fact deduplication — feed existing facts into extraction prompt to avoid redundancy
- [ ] Topic merging — combine topics that cover the same domain
- [ ] Working memory layer — PreCompact hook to preserve active context before compaction
- [ ] Embedding-based topic detection — replace keyword matching with semantic similarity
- [ ] Importance scoring — weight facts by recency, frequency, and relevance
- [ ] Importance decay — reduce weight of stale facts over time
- [ ] Sentiment + time delta metadata — prioritize urgent/frustrated interactions
- [ ] Relevance scoring improvements — fine-grained retrieval within topics

### Out of Scope

- Full CLI fork of Claude Code — too much maintenance burden
- Heavy agent abstraction layer — adds complexity without clear value at this scale
- Multi-user memory — this is a single-user tool
- Real-time streaming analysis — batch/periodic is sufficient
- GUI/web interface — CLI-native, inspect via cat/grep

## Context

- Built as a Claude Code hook system (UserPromptSubmit, SessionStart, SessionEnd)
- Hooks are registered in ~/.claude/settings.json, fire globally across all projects
- Memory lives in ~/Desktop/claude-toc/memory/ — centralized, session-agnostic
- Transcripts are Claude's own JSONL files at ~/.claude/projects/<encoded-cwd>/<session>.jsonl
- Analysis uses Claude via Bedrock (cc function: AWS_PROFILE=claudecode, global.anthropic.claude-opus-4-6-v1)
- Current keyword matching is simple string inclusion against TOC keywords
- Existing tools like claude-mem use SQLite + embeddings — we use flat files for now, migrate when scale demands it

## Constraints

- **Hook timeout**: Hooks must complete in <5 seconds — no heavy computation in the hot path
- **Token budget**: Injected context must stay under ~500 tokens to avoid bloating prompts
- **Zero friction**: User must never need to run commands or change workflow — everything is automatic
- **No dependencies**: Hooks use Node.js stdlib only (CommonJS, no npm packages)
- **Bedrock auth**: Analysis calls require ada credentials via claudecode profile

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hooks over standalone CLI | Must be invisible to user workflow | ✓ Good |
| Flat files over SQLite | Human-readable, git-friendly, no native deps at current scale | — Pending |
| TOC + per-topic markdown files | Clean separation of routing index from knowledge storage | ✓ Good |
| Keyword matching over embeddings | Simpler to start, embeddings planned for Phase 2 | — Pending |
| Claude for extraction (not rules) | LLM extraction handles nuance better than regex/heuristics | ✓ Good |
| Periodic + session-end analysis | Covers long-running sessions that never close | ✓ Good |
| Centralized memory across projects | Same knowledge available regardless of working directory | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-24 after initialization*
