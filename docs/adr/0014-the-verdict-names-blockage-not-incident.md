# ADR 0014: The status verdict names blockage, not incident, and never fails your shell

**Status:** accepted (2026-08-31)

## Context

Every failure this project has had was an invisible one. A malformed injection payload
was silently rejected for four months. End-of-session triggers left extraction at 17%
coverage and nothing said so (ADR 0010). The hook that sweeps cannot report anything at
all, by construction: it exits zero and writes nothing, so liveness has only ever been
observable by going and looking at the state file. `bin/toc-spend` was the one place to
go and look, and it answers exactly one question.

So the write path needed a place to be read from. The question was what such a report is
allowed to *conclude*, because the recorded state offers several tempting alarms that
mean nothing:

- The index is derived and disposable, refreshed by whoever needs fresh data. A stale
  index is the normal resting state, not a fault.
- `state.sweptAt` is a debounce claim stamped on prompt submission whether or not any
  session was extracted. It is a heartbeat, not evidence of work.
- An extraction lease held past its expiry is stolen by the next sweep. A crashed
  holder never actually blocks the queue.
- Extraction is proportional to prompts typed. A quiet weekend extracts nothing, which
  ADR 0010 established as correct behaviour for a tool that costs money.

A report that reddened on any of these would be wrong within a week, and a health report
you have learned to ignore is worse than no health report, because it also consumes the
attention the real fault needed.

## Decision

**The verdict names only blockage: work that exists and is not getting done.** The two
conditions that qualify are a queue of waiting sessions with no extraction behind it,
and smoke queries that fail. Both are of the form "there is something to do, and it
isn't happening". Everything else on the report is a number.

This is why staleness alone is never a fault. No extraction in 24 hours with an empty
queue is a quiet week. An expired lease with extractions since is a crash the system
recovered from. Both are printed; neither reaches the verdict. Only the conjunctions
count: stale *and* waiting, expired *and* nothing since.

**Status always exits zero.** It prints `healthy`, `N problem(s)`, or `never run`, and
returns 0 in all three cases. A report that fails your shell becomes a report you stop
running interactively, or worse, one whose exit code gets wired into something and then
has to keep its promises to a machine forever.

These are one decision, not two. A verdict about present blockage is a claim about right
now, aimed at a person deciding whether to go debugging. It has nothing to tell CI,
because CI cannot act on "four sessions are waiting" — and the moment an exit code
exists, the verdict starts being designed for the machine reading it instead of for you.

## Consequences

- Adding a fault means arguing that something is *blocked*, which is a higher bar than
  "looks wrong". Candidates rejected under this bar: a stale index, a frozen heartbeat,
  failures short of quarantine, unpriced model calls, corpus debris from one-off
  migrations, and a low share of automatic searches. All are reported as numbers.
- Status cannot be a gate. Anything wanting a machine-readable health check has to grow
  its own surface rather than reading an exit code, and would be entitled to a different
  verdict than the one a human wants.
- The report must be dense enough to read as a whole, since the verdict deliberately
  declines to summarise most of what it shows.
