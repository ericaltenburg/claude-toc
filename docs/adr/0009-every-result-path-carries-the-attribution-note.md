# ADR 0009: Every result path carries the attribution note

**Status:** accepted (2026-08-31)

## Context

A retrieved fact is dated evidence, not current truth. Nothing in this system will
ever write "that changed", so a fact about a pinned dependency version stays
confident and wrong after the bump. The mitigation is a presentation contract —
attribute a fact to its date, and check anything load-bearing against the systems of
record — and that contract is stated for the reader in `skills/toc-search/SKILL.md`
and in `CONTEXT.md`.

A contract stated only in the skill is a contract the output can contradict. The
read path has several exits: rendered facts and prompts, an overview, `--sql` rows,
and `--json` for each of them. The reader of `--json` is the same reader as the
reader of the text: Claude, mid-conversation, with the skill already some distance
back in context.

## Decision

Every path that returns facts appends the attribution note — the text renderer as a
trailing paragraph, `--json` as an `attribution` field on the payload
(`jsonTextWithAttribution`). Adding a new output mode means carrying it too.

The note is derived from one string, so the text and JSON wordings cannot drift.

## Consequences

- `--json` output is not the minimal machine shape it could be. That is the point:
  the alternative is handing over facts with nothing attached, which is exactly how a
  stale fact gets asserted in the present tense.
- Empty results carry no note, because there is nothing to attribute.
- Quarantine listings carry no note either: a quarantined session is a fact about
  this system's own state, not dated evidence from the corpus.
