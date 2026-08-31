# ADR 0006: An automatic search scopes itself to the current project

**Status:** accepted (2026-08-29)

## Context

Search is worth having only if Claude reaches for it unprompted, and an unprompted
search has a failure mode a typed one does not: it can pull four months of
unrelated work into a conversation nobody asked to widen. The corpus spans every
project on the machine, so a query about "the poller" matches three of them.

The first version of the read path expressed the rule in prose: the skill told
Claude to pass `--project "$PWD"` whenever it also passed `--source automatic`.
Two facts about that arrangement decided this ADR. It is unenforceable: an
omitted flag silently produces the cross-project bleed the rule exists to prevent,
and the output looks perfectly plausible. And it is unfalsifiable from the log,
because a scoped automatic search and an unscoped one are indistinguishable once
the flag is missing.

## Decision

`--source automatic` scopes the search to the current project by itself, in code.
`--project PATH` overrides it and `--all-projects` opts out, and the opt-out is
recorded in the log so a widened automatic search is visible as a deliberate act.

The current project is `CLAUDE_PROJECT_DIR` if set, otherwise the repository
containing the working directory, found by walking up to `.git`. It is matched
against every project path recorded in the index that resolves to it or to
something under it, with symlinks resolved on both sides.

Both of those exist because a session's working directory is frequently not the
project's own path: it is a subdirectory, or the same directory reached through a
link. Exact string equality against the working directory returns zero rows there,
and zero rows reads as "nothing was ever recorded about this". A silent, plausible
wrong answer is the failure this ADR is about, so the fix cannot introduce another
one. Matching downward only is what keeps it safe: the directory above a project
is somebody's home directory, and pulling its sessions in would be the bleed.

`--source` is now a closed set (`automatic`, `explicit`; `smoke` internally) and an
unrecognised value is refused rather than written to the log. A typo that logs as
its own third source would quietly corrupt the one signal that separates a trigger
that fired from a question a person typed.

## Consequences

- One flag carries both meanings: how it was invoked, and therefore how it is
  scoped. Claude cannot honour the log and forget the scope, or the reverse.
- The default is unscoped, because an explicit search must span projects:
  cross-project questions are the ones a person types by hand.
- `--project PATH` covers what is under that path too, since the same matching
  serves both. A project is a directory, and a directory contains its
  subdirectories.
- The `--sql` escape hatch is still unscoped by construction, since the caller
  writes the `where` clause. `--source` labels it correctly, an automatic one is
  logged as unscoped rather than presumed scoped, and the skill says so rather than
  pretending otherwise.
- Widening the trigger list from the log (#16) can now separate scoped automatic
  searches from widened ones, because both are in the record.
