# Topic-Scoped Memory System for Claude (POC Design)

## Overview

This project explores a structured alternative to traditional context compression in LLM workflows.

Instead of relying on lossy summarization when context windows fill up, this system introduces **topic-scoped memory** with dynamic retrieval. The goal is to preserve important details while maintaining high relevance and low token usage.

---

## Problem Statement

Current LLM workflows suffer from:

* Context window limits → forced summarization
* Summarization → loss of nuance and important details
* Long conversations → degraded response quality
* Lack of persistent, structured memory

The core issue:

> Context management is lossy, unstructured, and reactive.

---

## Core Idea

Introduce a **topic-based memory system** where:

* Conversations are grouped into **topics**
* Each topic maintains its own structured memory
* A **manifest** routes incoming messages to relevant topics
* Context is dynamically assembled instead of compressed

---

## Key Concepts

### 1. Topic-Based Memory

Each topic represents a coherent domain of conversation:

Examples:

* career_transition
* project_building
* fitness_training

Each topic contains structured files:

```
topic/
  context.md        # distilled facts
  decisions.md      # decisions made
  state.json        # structured state
  raw_log.md        # optional full history
```

---

### 2. Manifest (Routing Layer)

A central manifest tracks all topics:

```json
{
  "topics": [
    {
      "id": "career_transition",
      "keywords": ["job search", "resume"],
      "embedding": [...],
      "files": [
        "context.md",
        "decisions.md"
      ],
      "last_active": "2026-04-10",
      "importance": 0.82
    }
  ]
}
```

Responsibilities:

* Topic discovery
* Topic matching (via embeddings or keywords)
* Routing input to relevant memory

---

### 3. Message Processing Pipeline

Each user message goes through:

```
User Input
   ↓
Topic Detection
   ↓
Context Retrieval
   ↓
Prompt Injection
   ↓
Model Response
   ↓
Memory Update
```

---

### 4. Topic Detection

Determine which topic(s) the message belongs to:

Methods:

* Embedding similarity (preferred)
* Keyword matching (fallback)
* Multi-topic tagging (optional)

---

### 5. Context Retrieval

Instead of loading full history:

* Select relevant facts from `context.md`
* Include recent entries from `decisions.md`
* Optionally include structured state

Constraints:

* Keep total injected context small (300–500 tokens)
* Prioritize:

  * relevance
  * recency
  * importance

---

### 6. Prompt Injection Format

```
[Relevant Context]
- User prefers backend-heavy roles
- Working on a new project for resume

[Recent Decisions]
- Build new project instead of revising old one

[User Message]
<actual input>
```

---

### 7. Memory Update

After each response, extract structured information:

#### Extract:

* Durable facts
* Decisions
* Constraints
* Open questions

#### Update:

* Append to `context.md`
* Append to `decisions.md`
* Optionally update `state.json`

Avoid:

* dumping raw conversation text
* overwriting existing data without versioning

---

### 8. Sentiment + Time Delta (Optional Enhancement)

Each message can include metadata:

```json
{
  "delta_seconds": 420,
  "sentiment": -0.6,
  "urgency_score": 0.72
}
```

Use cases:

* prioritize frustrated or urgent interactions
* weight memory importance
* detect active problem-solving sessions

---

### 9. Working Memory Layer

Introduce a short-term buffer:

```
working_memory.md
```

Contains:

* current task
* immediate goals
* unresolved threads

This prevents loss of near-term intent.

---

## Design Philosophy

This system replaces:

> “compress everything into a summary”

with:

> “store structured knowledge and retrieve only what matters”

---

## Comparison to Existing Approaches

### Traditional (e.g., claude-mem)

* Store everything
* Compress into observations
* Retrieve via semantic search

### This System

* Explicit topic boundaries
* Structured memory (facts vs decisions)
* Deterministic routing + selective retrieval

---

## Tradeoffs

### Advantages

* Reduced context loss
* Cleaner, more interpretable memory
* Better handling of long-running topics
* Explicit control over what is remembered

### Challenges

* Topic classification accuracy
* Risk of missing relevant context
* Memory consistency over time
* Requires structured extraction logic

---

## Hybrid Opportunity

Best results likely come from combining:

* Topic routing (coarse filtering)
* Embedding search (fine retrieval within topic)

---

## POC Implementation Plan

### Phase 1 (Minimal)

* Single topic
* Manual context.md
* Simple retrieval + injection

### Phase 2

* Multiple topics
* Manifest + routing
* Basic embedding similarity

### Phase 3

* Structured memory extraction
* decisions.md + state.json
* working memory layer

### Phase 4

* Sentiment + time delta weighting
* relevance scoring improvements

---

## Integration Options

### Recommended (POC)

* CLI wrapper around Claude Code
* Intercept input/output
* Inject context dynamically

### Alternative

* Claude hooks:

  * UserPromptSubmit
  * PreCompact
  * SessionStart

### Not Recommended (initially)

* Full CLI fork
* Heavy agent abstraction

---

## Success Criteria

Evaluate based on:

* Reduced repetition from the model
* Improved continuity across sessions
* Lower token usage vs baseline
* Higher relevance of injected context

---

## Summary

This system aims to:

* eliminate reliance on lossy summarization
* introduce structured, topic-aware memory
* dynamically assemble context per interaction

Core insight:

> The problem is not that models forget.
> It’s that memory is unstructured and poorly retrieved.

---

## Future Extensions

* Topic merging via clustering
* Importance scoring over time
* Versioned memory history
* Visualization tools for memory inspection
* Debug commands (e.g., `/inspect-context`)

---

## Working Name Ideas

* Context Router
* Topic Memory Engine
* Scoped Memory Layer
* Claude Context Manager (CCM)

---

