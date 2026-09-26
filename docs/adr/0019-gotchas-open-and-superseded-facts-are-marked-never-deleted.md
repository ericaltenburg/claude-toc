# ADR 0019: Gotchas and Open are sections of their own, and a superseded fact is marked, never deleted

**Status:** accepted (2026-09-26)

## Context

A topic had two sections, Context and Decisions. A hand-classified sample of 408 facts, and
regular expressions over all 4,802, found three kinds of fact the schema had no place for:

- **Gotchas and root causes**, meaning something that failed, or would fail, in a non-obvious
  way. They were 22% of all facts and 31% of Context.
- **Intentions and open items.** About 11.5% of Decisions were plans or pending questions. The
  earlier prompt rules already said a plan is not a decision, but gave plans nowhere else to go.
- **Values that changed.** A later value was appended beside the earlier ones, and nothing
  marked the earlier ones as stale. One batch-size Decision held 14 different values across
  about 50 facts, and every one of them read as a current decision. The dedup rule in
  `corpus/topics.js` rightly keeps a fact whose number changed, so nothing was lost, but nothing
  said which value was current either.

Other memory systems handle a changed value the same way. Graphiti, mem0 and ADRs all keep the
old fact and mark it superseded instead of deleting it. Graphiti's dedupe prompt returns index
numbers into a candidate list and says "NEVER mark facts as duplicates if they have key
differences, particularly around numeric values, dates".

Separately, when a slice is too large for one model call it is split into chunks (ADR 0007), and
every chunk got the same prompt. So chunk 2 never saw what chunk 1 had just extracted, and was
free to write it again, reworded.

## Decision

**A topic has four sections.** `## Context`, `## Decisions`, `## Gotchas` and `## Open`, and a
new topic file gets all four headings. The fact line format is unchanged. The extraction JSON
gains `"gotchas"` and `"open"` arrays, and a reply without them has none. The prompt rules are
strict:

- a gotcha is a real trap, stated with its cause or its fix, not any fact that mentions an error;
- Open is where plans, intentions, pending items and unanswered questions go, and nowhere else;
- Decisions stay settled outcomes only.

**A new fact supersedes a known fact by number, and code writes the mark.** The known-facts list
in the prompt is numbered (`[0] (topic/Section) text`). Any fact in the reply may be an object,
`{"text": ..., "supersedes": [i, ...]}`, in place of a bare string, and a bare string stays
valid. The prompt says a changed value, a reversed decision or an answered open item supersedes
the known fact it replaces. It also carries the rule "a different number, version, date or
qualifier means supersedes, never a duplicate". An Open item closes this way: the fact or
decision that settled it supersedes it.

The model only names numbers. The extractor turns each chunk's numbers back into the facts
that chunk's prompt listed, and drops any number that names none, whether it is out of range,
negative or not a whole number. The fact itself is still appended. Once every fact in the
slice is written, the extractor marks each superseded fact's line in its own topic file:

```
- Batch size is 264,000 [session:316972f2, 2026-05-12] [superseded:ef56ab78, 2026-09-20]
```

The marker is a second group after the attribution. It names the superseding session and the
date of its conversation. Everything before it stays byte for byte what it was, so the old
fact's text, session and date are unchanged. `corpus/format.js` reads and writes the marker
like the rest of the line, and its round-trip test marks every line it writes.

The line is found by its section and exact text, never by its line number, because facts
appended since the prompt was built have moved it, and a hand edit or merge may have changed
the file. A line that is no longer there, or is already marked, is skipped. **A fact marks
the facts it supersedes only if it landed.** One its section already held is a restatement,
and marking the fact it restates would leave no current line saying that value. For the same
reason a fact never marks itself, which it would when a later chunk restates an earlier chunk's
fact and the two merge into one.

**Nothing is ever deleted or reworded.** The corpus is irreplaceable and has no backup (ADR
0001), and the model's judgement that one fact supersedes another is exactly what could be
wrong. A wrong mark costs one hand edit, deleting the marker, and the next refresh picks that up.
A wrong deletion cannot be undone. The old fact is also evidence in its own right: it records
what a session once concluded and when, which is what a question like "what did we use
before?" asks for.

**The rest of the system reads the marker:**

- The index parses it into `superseded_session` and `superseded_date`. `SCHEMA_VERSION` is 2,
  so an existing index rebuilds itself from markdown on its next open (ADR 0017).
- Search still returns superseded facts, but orders them after every current fact the same
  search found, ranked or not. The text renderer labels one `| superseded YYYY-MM-DD`, `--json`
  carries both columns, and ADR 0009's attribution note still ends every result path.
  `--section` matches any section by name, so it covers Gotchas and Open.
- Superseded facts are not offered to the model as known, because a value that changed back
  is news again. They still count toward choosing candidate topics, since they still say what
  a topic is about.
- Dedup ignores superseded lines for the same reason, and a merge carries a marked line to the
  winner as written.

**Each chunk sees what the earlier chunks of its run returned.** Those facts lead the chunk's
known facts, newest first, under the topic their chunk will be written to. They count against
the same-session cap (ADR 0002's `SAME_SESSION_FACTS_IN_A_PROMPT`) with the session's facts
already in the index, so the prompt stays bounded. They are numbered like any other known fact,
so a later chunk can supersede what an earlier one returned. That is why marks are applied only
after every topic is written.

## Consequences

- **No marker does not mean current.** A fact is marked only when a later extraction had
  both the old fact in its bounded known-facts list and a conversation that changed it.
  The attribution contract (ADR 0009) stands unchanged. What changes is that the corpus can
  now say "this changed" when it knows, where before nothing could, as ADR 0009's context put it.
- **Existing facts are not back-filled.** The 14 batch-size values stay unmarked until a later
  session supersedes them. Back-filling would be a one-off paid pass over the corpus, which ADR
  0013 argues against keeping tooling for.
- The marks are written after the appends, in the same process, and after every model call has
  returned (ADR 0007). If the process dies between the appends and the marks, the offset has not
  advanced, so the slice is retried. But its facts now dedup as already written, so their marks
  are lost. The corpus is then no worse than before this ADR.
- A superseded Decision still sits in `## Decisions`. The section says what kind of fact it
  was, and the marker says it no longer stands.
- `--sql` users see two more columns on `facts`, and a query that wants current facts only
  filters on `superseded_date is null`.

**Update (2026-09-26):** the existing corpus was back-filled once after all, by one-off scripts
that were not kept, as with ADR 0013's repair. Claude Opus 5.5 at `xhigh` effort read every
topic whole and proposed 436 supersessions. A second, blind pass kept only pairs where
everything the old fact said had changed, confirming 187. That rule left reversed decisions
current whenever their rationale still held, so a third pass re-judged the 249 it rejected by
the fact's main point. It confirmed 192, of which three were dropped on review because an
independent claim in them still held. 376 facts across 26 topics are now marked. Point-in-time
readings and standalone truths such as platform constraints and root causes stay current. The
same pass rewrote all 74 topic summaries to describe their subject rather than their last
session. Each apply was checked against a snapshot: every original line intact apart from its
marker, fact counts unchanged, and `toc.json` changed in summaries only. It took 127 model calls,
about 759K tokens in and 384K out. Gotchas and Open were not back-filled: old facts keep their
sections, and new extractions fill the new ones.
