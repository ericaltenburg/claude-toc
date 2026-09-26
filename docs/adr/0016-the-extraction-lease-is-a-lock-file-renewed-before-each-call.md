# ADR 0016: The extraction lease is a lock file, renewed before every model call, and every extraction holds it

**Status:** accepted (2026-09-25)

## Context

The extraction lease lived in `state.json` as `extraction: { holder, startedAt }`. The sweep
hook took it, nothing renewed it, and it expired five minutes after it was taken (ADR 0010's
default). ADR 0013 removed renewal with the backfill, reasoning that nothing left held the
lease longer than five minutes.

**That was wrong.** The spend log shows three extractor runs that outlasted five minutes,
the longest 22m45s. One model call is allowed five minutes on its own, a slice can take
several calls, a chunk the first model cannot take is tried again on the second, and a sweep
takes up to three sessions. On 2026-09-08 around 20:15 UTC session 0e3662c4 was extracted
while 21f6985e was still mid-extraction: the lease expired under a live extractor, the next
prompt's sweep took a fresh one, and a second extractor ran beside the first. That is the
thing the lease exists to prevent. A topic append reads the file and writes it back whole, and
so does every write to `state.json`, so when two writers interleave, the one that writes
second drops what the other added.

**Only the sweep ever took it.** `toc-extract <id>`, `--all`, `--retry`, `--dedup` and a
manual `--sweep` extracted or merged holding nothing (#25, which saw the same overlap on
2026-08-31).

Taking the lease was also a read and rewrite of the whole of `state.json`, the file a running
extractor records its offsets and failures in.

## Decision

**The lease is a file, `extraction.lock` in the corpus, created with `O_EXCL`.** Creating it
is taking it, so two takers cannot both succeed. It records the holder, when it was taken, and
the pid. It sits beside `state.json` rather than in it: `state.json` records what extraction
has done, and the lock is who is doing it now.

**Its holder renews it before every model call** by touching its modification time. A call is
`execFileSync` and blocks the event loop for as long as it runs, so no timer could renew during
one; between calls, synchronously, is the only moment there is. The renewal wraps the model
call in the command, so the extractor itself knows nothing of locks. Renewal and release both
do nothing unless the file names the caller as its holder.

**A lock is stale once ten minutes pass without renewal: twice the model call's timeout,** and
derived from it in the code. A live holder renews at least once per call and a call is killed
at five minutes, so a holder is silent for at most one call and the work between two. A stale
lock is removed and taken; a fresh one refuses.

**Every command that extracts or merges holds it**, taken in one place in `toc-extract`:
`--sweep`, `--all`, a session prefix, `--retry` and `--dedup`. An extractor the sweep spawned
uses the sweep's holder, passed as `TOC_LOCK_SESSION`. Anything else takes it under a fresh
identifier, or says an extraction is already running and exits 1 without touching the corpus.
The bare listing takes nothing. Whoever holds the lock releases it however the command ends.

## Consequences

- This supersedes ADR 0013's consequence that renewal was removed with the backfill, and ADR
  0010's five-minute lease. Something does hold the lease longer than five minutes: every
  extraction with more than one model call in it.
- A crashed holder now blocks extraction for up to ten minutes rather than five. The status
  report reads expiry as the last renewal plus that threshold, and ADR 0014's rule is
  unchanged: an expired lock with an extraction since is reported, never blockage.
- A manual run while a sweep is extracting refuses instead of overlapping it. Run it again
  shortly.
- Two takers that both find one stale lock can both remove it and both proceed. That needs a
  dead holder and two takers in the same moment, and is an accepted ceiling for a tool with
  one operator; it is marked in the code, and stealing by rename would close it.
- A `state.json` written before this still carries `extraction`. It loads, the field is
  ignored, and the next save drops it.
