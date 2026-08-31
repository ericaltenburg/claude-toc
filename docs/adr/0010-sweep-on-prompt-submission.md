# ADR 0010: Extraction is swept on prompt submission, and the hook says nothing

**Status:** accepted (2026-08-31)

## Context

Extraction has to start somehow. The previous triggers fired when a session ended,
and coverage was 17%: 126 of 741 transcripts were ever processed, because a session
that is closed by quitting the terminal, by a crash, or by never being closed at all
never reaches an end-of-session hook. The trigger depended on a discipline the tool
cannot enforce.

The other constraint is that this hook runs in front of every prompt the user types.
It is the one piece of claude-toc that can make real work slower or noisier, and the
project's history is of a memory system whose failures were invisible: a malformed
injection payload was silently rejected for four months.

## Decision

**Prompt submission is the trigger.** Every prompt sweeps: glob the transcripts,
stat their modification times, and pick sessions that have been idle beyond the
threshold. Nothing about it depends on how a session ends, and a session that is
still being typed in is excluded by its own modification time rather than by any
bookkeeping.

**The hook's contract is absolute.** The whole body is wrapped in try/catch, it exits
zero on any failure, and it writes nothing to stdout or stderr. Emitting nothing is
also what makes injection structurally impossible: there is no payload that can fail
validation and no relevance to guess at. The real work is spawned detached, so the
prompt is never waiting on a model call.

**Defaults, all configurable:** idle after 60 minutes, one sweep per 60 seconds, at
most 3 sessions per sweep, a single extraction lock with a 5-minute lease. The cap is
what makes a backlog drain gradually instead of saturating the machine, and the lease
is what lets a crashed extractor's lock be broken rather than wedging the queue
forever.

**The most recently idle sessions are swept first**, so today's work is searchable
today and the tail drains behind it.

**One state read per sweep.** Selection asks the state file for a snapshot and then
tests every transcript against it. Re-reading the state file per transcript cost
400 ms across the transcripts already on disk, which is latency the user would feel
on every prompt; the snapshot costs 30 ms.

**A session is a transcript whose file name is a session id.** Claude Code also writes
subagent transcripts under a session's own directory, named `agent-*`. Those are not
sessions: they have no session id, and their facts would be attributed to an
identifier that resolves to nothing.

## Consequences

- Sweeping is proportional to prompts typed, not to sessions finished. A day with no
  prompts extracts nothing, which is the correct behaviour for a tool that costs money.
- At most 3 sessions per sweep and one sweep per minute bounds the spend rate without
  a scheduler.
- The hook cannot report anything, by construction. Liveness is observed through the
  advancing offsets in the state file and through search, never through the hook.
