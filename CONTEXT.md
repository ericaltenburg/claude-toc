# Context

Ubiquitous language for claude-toc. Glossary only — no implementation detail, no decisions.

## Session

One Claude Code conversation. Claude Code owns it and writes a transcript file for
it under `~/.claude/projects/`. A session is a source, never something claude-toc
writes.

Identified by its session id (a uuid). Transcripts rotate away over time, so a
session id may outlive its transcript.

## Fact

One distilled statement extracted from a session, written as a single markdown
list item with the session and date it came from:

```
- Project uses Brazil build system [session:316972f2, 2026-05-12]
```

A fact is the unit of retrieval. Search ranks facts, not topics.

## Topic

One subject, stored as one markdown file. A topic holds many facts and carries a
summary and keywords. Topic is a **label and provenance on a fact**, not a thing
that gets retrieved on its own.

Topic size is not bounded: topics range from a handful of facts to several hundred.
The spread is wide enough that the largest topic is worth watching, because a topic
that accumulates without end stops being one subject.

## Section

A division within a topic file separating the two kinds of fact:

- **Context** — what is true about the subject.
- **Decisions** — what was chosen about the subject. A decision is an outcome, not
  an intention: it is settled and dated at the moment it was reached.

Preserving this distinction is the differentiator over undifferentiated
observation stores. A search result carries its fact's section.

Neither section records **world state** — whether a chosen thing was subsequently
built, deployed, or reverted. Facts record what was concluded in a session; the
systems of record (git, CloudFormation, tickets) hold what was executed. Later
sessions about the same subject supply newer facts, and their dates are how
currency is judged.

## Corpus

Every topic file, plus the table of contents describing them. Lives outside this
repo at `~/.claude/claude-toc/`. The corpus is the source of truth and is
irreplaceable: transcripts rotate away, so a lost fact cannot be re-extracted.

## Index

The queryable derivation of the corpus and the prompt log: topics, facts,
prompts, and sessions in SQLite, with full-text tables over facts and prompts.

The index is **derived and disposable**. Markdown stays the source of truth, and
deleting the index costs nothing but the time to rebuild it. Nothing writes a
fact to the index that it did not read from markdown.

**Refresh** is the one operation that brings it up to date, called by whoever is
about to need fresh data rather than on a schedule. It is incremental: a topic
file is reparsed only when its modification time or size changed, and the prompt
log is read only past the byte offset already consumed.

## Prompt

One message the user typed, as recorded by Claude Code in
`~/.claude/history.jsonl`. Prompts are raw, not distilled, and carry a timestamp
and project path. Prompts supply the **timeline**; facts supply the **insight**.

A prompt is never a fact. Search keeps them as separate result classes so raw
text cannot outrank a distilled fact.

## Search

The read path. Claude issues a query and receives ranked facts, ranked prompts,
or both. Claude may invoke search on its own judgement; `/toc-search` is the
manual entry point for the same thing.

Search is always pull. Nothing is ever pushed into a prompt.

A search is **automatic** when Claude issued it on its own judgement,
**explicit** when the user asked for it, and **smoke** when it came from the
corpus's own smoke queries.

Every search is recorded with the source that issued it, how many rows it
returned, and whether its query syntax was rejected and retried as bare terms —
a **syntax fallback**, which is a query that degraded without saying so. A
search that **returned nothing** and a syntax fallback are both read-path
quality signals, never blockage.

On the status report these read by who decided to search and what came back:
automatic is **Claude searched**, explicit is **you searched**, smoke is
**self-tests**, a search that returned nothing is **found nothing**, and a syntax
fallback is **bad syntax, retried**.

The **current project** is the repository the session is working in. It is what an
automatic search means by "this project".

A retrieved fact is **dated evidence, not current truth**. The corpus has no way
to learn that a fact went stale, because nothing writes "this changed" — a fact
about a pinned dependency version stays confident and wrong after the bump. So a
fact is always attributed to its date when used ("a session on 2026-08-27
recorded X"), never asserted as present tense, and anything load-bearing is
checked against the systems of record before it is acted on.

## Extraction

Turning a slice of one session's transcript into facts, and appending them to a
topic. Extraction is expensive, asynchronous, and best-effort. It costs money and
runs behind the live conversation.

On the status report the count of sessions extraction has processed reads
**sessions extracted**.

## Spend

What extraction cost, recorded per model call: the tokens in and out, the model, and
the session the call was extracting. Tokens are measured; dollars are an estimate from
a rate table, because rates are not something this project can observe.

A call is **unpriced** when its model has no entry in the rate table. Its tokens
are counted and its dollars are not, so unpriced calls are how far the estimate
falls short of the bill. An unpriced call is a caveat on a number, never blockage.

On the status report calls read **model calls**, the estimate reads **estimated
cost**, and unpriced calls read **calls with no rate**, which says what is missing
rather than naming the state the call is in.

Spend is a record of the write path only. Search costs nothing.

## Quarantine

A session extraction has given up on after repeated failure, recorded with its
attempt count and last error so one bad transcript cannot block the queue.
Quarantine is a state a session is put in, never a state a fact or topic has.

Surfaced through search on request, because a failure nobody can see is the
failure mode this project exists to correct.

On the status report this reads **given up on**, and the failures short of it read
**retrying after failure**.

## Sweep

Deciding which sessions are ready for extraction and starting it. A sweep reads
session state and never speaks to the user.

On the status report the time of the last sweep reads **last checked for work**,
which says what a sweep is: a sweep that found nothing still swept. A fresh
"last checked for work" over a stale "last extraction" is the report saying the
write path is alive and producing nothing.

## Waiting session

A session a sweep would choose: idle long enough to be finished with, carrying turns
extraction has not read, and not quarantined. Waiting sessions are the queue, and
their count is how the write path's backlog is observed.

## Extraction lease

The right to be the one process extracting. Held by a **holder**, which is whoever
took it: a sweep names itself by the identifier it will spawn the extraction under,
which is not yet a session's. A lease expires, so a crashed holder cannot block
extraction forever.

On the status report a held lease reads **extracting now**, because that is the
only part of it an operator can act on. The holder is named in the problem line
for a lease nothing recovered from, and nowhere else.

## Status

One reading of everything already recorded: what extraction has done, what the corpus
holds, how often search runs, and what it cost. Status reads and never repairs.

Status carries a **verdict**, which names only what is **blocked** — work that exists
and is not getting done. A recorded failure the system has already recovered from is
reported but does not reach the verdict. Absence of activity is not blockage: a quiet
week is healthy. Having never run is its own verdict, distinct from healthy.

Status runs the corpus's smoke queries every time, with search logging suppressed so the
report never inflates the smoke count it prints. Smoke queries that fail are blockage: the
corpus can no longer answer questions it is known to have answered. A corpus with no smoke
queries configured has nothing to fail and is not a problem. Smoke takes no row on the
report: it is the verdict that speaks it, where the corpus's own **self-tests** are the
searches the log recorded.

**The report and the code speak different registers, on purpose.** Every term above keeps
its mechanism name in the code — `state.quarantined`, `sweptAt`, `acquireExtraction` — and
appears on the report as the question it answers, because a lease really is a time-bounded
exclusive claim and renaming the field to match a display label would make the code worse
to serve a terminal. The mapping is recorded in each term's entry, and ADR 0015 records
why the divergence is a decision rather than an inconsistency to tidy away. The report's
wording is a rendering concern and lives with the rendering.
