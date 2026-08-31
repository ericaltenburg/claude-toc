# ADR 0013: The backfill was a one-off, and its tooling did not stay

**Status:** accepted (2026-08-31)

## Context

Coverage was 17%: of the transcripts on disk, 126 had ever been processed. Sweeping
(ADR 0010) takes the newest few idle sessions per prompt submission, so a four-month
backlog would have taken months of ordinary use to drain. Search quality was bounded by
that sample, which is the point of the whole project.

The backlog was sized at 618 sessions: 741 transcripts on disk, less the 42 already
processed and still present, less 81 genuine extractor transcripts. **That count was of
files, not of sessions.** Measured on 2026-08-31: 769 `.jsonl` files under the
transcripts directory, 590 of them `agent-*.jsonl` subagent transcripts. A subagent's
transcript is not a session and never was a candidate, so the real population was 179
files, 147 idle and unread, 76 of those extractor output by the first-record content
check (ADR 0011). The queue was **71 sessions holding 126 MB unread**, not 618. Most of
the backlog the coverage gap described was already gone: transcripts rotate away, and
these had.

## Decision

**The backlog was drained once, by hand, and the tool that did it was removed
afterwards.** It ran the sweeper's existing candidate rules with the per-sweep cap
lifted, newest first, holding the extraction lease so a swept extraction could not append
to the same topic files concurrently, pausing between paid calls, and checkpointing cost
against an estimate after the first batch. It is not in the repository because it has no
second use: coverage is current, and the sweep hook is what keeps it current. Keeping a
command that runs once is how the project acquired a dead code path that survived four
months unnoticed.

**What the run measured is kept, because it cannot be re-derived cheaply:**

- **71 sessions, 126 MB unread, $11.14 at list rates**, across 76 model calls (2.92M
  input tokens, 160K output). One session failed on malformed output and was left to the
  ordinary retry path.
- **Extraction costs about $0.086 per unread megabyte of transcript**, measured over the
  first 25 sessions (37.7 MB, $3.38). The figure derived from the original sizing was
  $0.163/MB — 1.9× too high, because it priced raw transcript bytes while extraction
  sends only user and assistant text. Tool results, which are most of a long session's
  bytes, never reach the model.
- **Per-session cost is not a useful unit.** The same sizing gives $0.057 per session,
  but only by dividing by that file count; the surviving sessions averaged 1.8 MB against
  the 348 KB it assumed.
- **A cost checkpoint has to insist on evidence.** Comparing $0 spent against an estimate
  of $0 passes while proving nothing, which is what a first batch of rotated or empty
  transcripts produces.

**Sessions discovered by the backfill were recorded in the session index**, with the
project their transcript opened in. Only the logger hook wrote that index before, so none
of the backfilled sessions had a project — and a fact whose session has no project cannot
be found by a project-scoped automatic search (ADR 0006). Backfilling facts without their
projects would have left most of the corpus invisible to the search that matters most.
That is why the session index now has one module owning its record shape, reading and
writing, rather than the hook spelling it out inline.

## What the run got wrong, and the repair

The backfill dated every fact it wrote 2026-08-31, because a fact's date was the clock at
append time rather than anything about the conversation. 1,163 facts were stamped with the
run date, 999 of them off by four days or more and 33 by over 45 days, all in the direction
that makes a stale fact look current.

The cause is fixed upstream: a fact is now dated from the last record in the slice it came
from. The damage was repaired by a one-off script, also not kept, which rewrote **1,097
fact lines** in place. Dates came from the transcript's own last timestamp for 68 sessions
and from the prompt log's last prompt for the 11 whose transcripts had rotated away; 66
facts were correctly dated today already and nothing was unresolvable, because no
8-character session prefix in this corpus is ambiguous.

Two rules kept the repair honest. Only lines carrying the run's own date were touched:
facts written before it were appended slice by slice, close to their own turns, so
re-dating them from a session's span would have dragged an early slice forward to the
session's last day. And the rewrite refused to write any file where anything other than a
date had changed. Fact count before and after: 2,996. `topics.before-redate/` in the corpus
is the snapshot taken first, and can be deleted once the dates look right.

## Consequences

- Coverage is current rather than a 17% sample, and staying current is now the sweep
  hook's job alone. If it breaks again, the backlog rebuilds silently — the search log
  and `bin/toc-spend` are the instruments that would show it.
- The extraction lease is held by a **holder** rather than a session id, since a sweep
  takes it under an identifier no session has yet. Lease renewal was removed with the
  backfill: nothing left holds the lease longer than its five minutes.
- Redoing this — a new machine, a restored corpus, a long-broken hook — means rewriting
  it. The measurements above are what make that cheap: the queue is every idle unread
  transcript whose first record is not the extraction prompt, newest first, and it costs
  about $0.086 per unread megabyte.
- One session remained queued at the end, at roughly $0.17. It needs no special handling;
  the next sweep takes it.
