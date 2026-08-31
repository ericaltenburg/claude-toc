# ADR 0008: LIKE is never used to compare corpus strings

**Status:** accepted (2026-08-31)

## Context

Two joins in this project match a stored string against a prefix: a project path
against the directories under it, and a fact's session field against the full
session id (a fact carries only the first eight characters of its session, so the
join is `sessions.session_id starts with facts.session`).

`LIKE` is the obvious SQL tool for both, and it is wrong for both. In `LIKE`, `_`
matches any single character and `%` matches any run of them, and neither operand
here is escaped or controlled:

- Project paths contain underscores routinely, so `like '/work/my_service/%'` also
  matches `/work/myXservice/`, quietly pulling a sibling project's facts into a
  search that was supposed to be scoped.
- The session field comes from markdown that is meant to be hand-edited, so any
  character can end up in it, wildcards included.

Both failures return plausible rows rather than an error, which is exactly the class
of bug this project already paid for once: the deleted keyword matcher did unanchored
substring tests and matched 373 prompts on a three-letter keyword that was a real
word in 3 of them.

## Decision

No `LIKE` against corpus-derived strings.

- Project scoping resolves the recorded project paths and compares them in
  JavaScript, path segment aware, so a sibling sharing a prefix does not match
  (`recordedProjectsUnder` in `search.js`).
- Session prefixes are matched with `substr(s.session_id, 1, length(f.session)) =
  f.session`, which is plain equality on a computed prefix.

## Consequences

- Project scoping reads every recorded project value once per search. There are tens
  of them, so it costs nothing measurable, and it is the only way to be
  segment-aware without a wildcard.
- Any future prefix or containment match needs the same treatment: `instr`, `substr`,
  or a JavaScript comparison, never `LIKE`. If `LIKE` ever becomes necessary, the
  pattern operand has to be escaped explicitly with an `ESCAPE` clause.
