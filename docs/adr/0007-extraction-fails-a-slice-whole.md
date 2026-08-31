# ADR 0007: Extraction fails a slice whole, and never half-writes one

**Status:** accepted (2026-08-31)

## Context

Extraction turns one session's unread transcript slice into facts. It costs money,
it runs behind the live conversation, and the corpus it writes to has no backup
(ADR 0001) and cannot be regenerated once transcripts rotate away. Several
independent things can go wrong in one extraction: a slice too large for the
context window, a model that errors or times out, a model that answers in prose
instead of JSON, a session whose transcript is corrupt.

Each of those has an obvious cheap handling that is wrong in a way that only shows
up months later — streaming facts to markdown as they arrive, dropping a chunk the
model choked on, retrying forever, or treating "already extracted" as "nothing left
to read".

## Decision

**One slice is one all-or-nothing unit.** Every chunk's model call must return
before anything is appended to markdown, and the extraction offset advances only
after the append (ADR 0001 has the write-ordering half of this). A failure leaves
both the markdown and the offset untouched, so the same slice is retried next time.

**A slice larger than the context window is chunked on turn boundaries**, at
300,000 characters per call — roughly 75K tokens, comfortably inside Sonnet 5's
window with the prompt's own overhead accounted for. A single turn larger than the
budget is split mid-turn, because the alternative is dropping it.

**A chunk the model cannot take escalates to the larger model; malformed output does
not.** Escalation exists for chunks that defeat the extraction model, and a lost
chunk is lost knowledge. Output that came back malformed is a different failure: the
retry for that already happened on the output, by stripping fenced blocks, and a
second model is no more likely to answer in JSON. Escalating there would double the
cost of the most common failure to no purpose.

**Three failed attempts quarantine the session** rather than retrying forever, and
quarantine is surfaced through search on request. One bad transcript must not block
the queue, and a failure nobody can see is the failure mode this project exists to
correct.

**Facts go to the topic their own chunk named**, not to a majority vote across
chunks. A long session genuinely turns to another subject, and filing those facts
under the chunk-majority topic would silently misattribute them. The state file
records every topic a slice wrote, so a multi-topic slice is not under-reported as
one topic.

**A session is a candidate for extraction while any of its transcript is unread**,
which is not the same as never having been extracted: a session extracted an hour
ago has since said more. Candidacy compares transcript size against the stored
offset.

**A topic id the model returns is normalised and matched against the candidate
list** before a new topic file is opened, so `ALCS Broadcast Variants` joins
`alcs_broadcast_variants` instead of forking it. The keyword-similarity matcher in
`toc.js` is deliberately not used on the write path — candidate selection from the
index replaced it (ADR 0002), and topic merging is out of scope because facts, not
topics, are ranked (ADR 0003).

## Consequences

- Peak memory holds every chunk's facts for one slice. At the measured slice sizes
  this is kilobytes, so it is not worth streaming.
- A slice that always fails costs three attempts before quarantine, and an attempt costs
  one model call per chunk — two if the chunk is escalated. So a single-chunk slice whose
  output is always malformed costs three calls, while a ten-chunk slice the model cannot
  take at all costs up to sixty.
- The offset is authoritative state and lives in the state file with the corpus,
  never only in the derived index, which is safe to delete at any time.
