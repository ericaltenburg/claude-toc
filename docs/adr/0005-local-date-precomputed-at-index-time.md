# ADR 0005: Local date is precomputed at index time

**Status:** accepted (2026-08-29)

## Context

"What did we do yesterday" is one of the two questions this project exists to
answer, and answering it means bucketing prompts and facts by day.

SQLite has no notion of a local timezone. Its date functions work in UTC or on an
explicit offset, and there is no way to ask it for "the day this timestamp fell on,
where the user was". Computing "yesterday" in SQL therefore silently uses UTC.

That is not a rounding error. In `America/New_York`, everything from 20:00 onwards
is already the next day in UTC, so a UTC bucket misfiles every evening session
into tomorrow. Evening sessions are common here, and the failure is invisible: the
query succeeds and returns the wrong day's work.

## Decision

Compute the local date once, in JavaScript, at index time, and store it as a
literal `YYYY-MM-DD` string on the row (`prompts.local_date`, alongside
`local_time`). Date filtering is then plain string comparison, with no timezone
arithmetic anywhere in the SQL.

`Intl.DateTimeFormat` with an explicit `timeZone` does the conversion, which is
also what makes it testable: tests pass a fixed zone rather than depending on the
machine's.

## Consequences

- Every date query in the read path is a string comparison, so the SQL stays
  trivial and Claude can write it without a date library.
- The stored date is only as right as the zone at index time. A prompt indexed
  while travelling is bucketed in the zone that was current then, and re-indexing
  later in another zone changes it. This is accepted: the index is derived and
  disposable, and the alternative (storing an offset and converting per query) puts
  timezone arithmetic back into every query.
- Tests must cover a daylight-saving boundary and a late-evening timestamp that
  falls on the next UTC day, because those are the two cases where a naive
  implementation looks correct in the developer's own timezone.
- Facts carry a date but no time, because a fact's date comes from the markdown
  line rather than from a timestamp. So a fact cannot be bucketed more finely than
  a day, which is why prompts, not facts, supply the timeline.
