# ADR 0011: The extractor never ingests its own sessions

**Status:** accepted (2026-08-31)

## Context

Extraction runs by asking Claude to distill a transcript. That request is itself a
Claude session, so it produces a transcript of its own — one that contains the
extraction prompt and the facts extracted from someone else's conversation. 93
transcripts on disk contain the extraction prompt. None had been ingested only
because the old code never globbed for candidates; the moment sweeping was added
(ADR 0010), that recursion activated.

Worse, the extraction subprocess inherited whatever project directory the hook fired
in, so those transcripts were scattered across 25 unrelated project directories.

## Decision

Four layers, first authoritative.

**1. We own the session identifier.** Every model call is made with a session id we
generate and record in the state file before spawning, and the sweeper skips any
recorded identifier. This is exact: no heuristic, no content inspection.

**2. A fixed working directory.** The extractor and its model calls run in one
directory under the corpus, so their transcripts land in one predictable place, which
the sweeper excludes by path. This also stops the littering.

**3. An environment guard.** The sweep hook fires inside the extractor's own sessions
too. A hook that sees the extraction marker in its environment returns immediately,
before it touches the state file.

**4. A content check, for the transcripts that predate layer 1.** Four months of
extractor transcripts have no recorded identifier and sit outside the fixed directory,
so they can only be recognised by what they contain.

**The content check tests the first message of a transcript, not the whole file.** A
session that merely *discusses* the extraction code contains the marker too — a
session that reads `src/extract.js` contains it by definition, and this project's own
development sessions are the clearest example. Measured on the transcripts on disk: a
first-message check classifies 76 as extractor output and keeps 17, and every one of
the 17 is real work about claude-toc. A whole-file check would have discarded all 17.

**"First message" means the first conversational record, not the first line.** Claude
Code opens a transcript with metadata records — agent settings, mode, permission mode,
queued operations, attachments — and the extractor's own prompt appears in a queued
operation record before any message. The check walks records until the first one
carrying message content, taking the project directory from the first record that
names one along the way.

## Consequences

- A historical extractor transcript whose first message is somehow not the extraction
  prompt would be ingested. The cost is one polluted topic, and layers 1 and 2 mean
  the exposure only ever shrinks.
- The recorded identifiers grow by one per model call. The state file keeps the most
  recent thousand; older ones are covered by layers 2 and 4.
- Extraction is pinned to one working directory, so a manually invoked extractor
  writes its transcripts there too, not into the repository it was invoked from.
