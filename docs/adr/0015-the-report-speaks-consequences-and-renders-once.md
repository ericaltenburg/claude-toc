# ADR 0015: The status report speaks consequences, not mechanisms, and renders exactly once

**Status:** accepted (2026-09-01)

## Context

`toc-status` shipped its first block with the labels the code uses. `lease`, `hook
heartbeat`, `processed` and `quarantined` are the names of mechanisms in `src/state.js`,
and they are legible only to someone holding the implementation in their head. That is
the author on the day they wrote it and nobody else, including the author six weeks
later. The remaining blocks would have added `smoke`, `syntax fallbacks` and `unpriced`
to the same pile.

The reader this report is designed for is the operator, later: the same single operator
every user story was written for, minus the fresh memory of how extraction works. Not a
stranger, so the report does not teach; it just declines to require the source.

Separately, the report was space-aligned columns under bare titles, and it had two
renderings — plain text and a `--markdown` flag built for pasting reports into documents.
Four blocks of space-aligned text gives the eye nothing to follow across a row, and the
markdown path meant rendering every block twice and testing both forever.

## Decision

**Every label names the question its row answers.** `hook heartbeat` becomes `last
checked for work`, `lease` becomes `extracting now`, `quarantined` becomes `given up on`,
`automatic` becomes `Claude searched`. Where a word cannot be plainly said, the row goes:
the lease's holder is a random identifier and its expiry is not actionable, so the row
folds into whether an extraction is running, and the holder survives only in the problem
line for a crash nothing recovered from — the one place it is the thing to go and look
for. The verb matters in the sweep row: **checked** is not **did**, so a fresh "last
checked for work" over a stale "last extraction" says the sweep is running and producing
nothing, which is the reading that row exists to protect.

**The code keeps its mechanism names.** `state.quarantined`, `sweptAt` and
`acquireExtraction` are unchanged, and `CONTEXT.md` records the report wording each term
appears as. A lease really is a time-bounded exclusive claim; renaming the field to match
a display label would make the code worse to serve a terminal. The divergence is written
down so that neither register is later "fixed" to match the other.

**There is exactly one rendering: box-drawn tables.** One table per block, full grid,
title in the top border, windowed blocks carrying a header row of `7d`, `30d` and
`all-time`, and all four blocks sharing one width computed from the widest value present.
`--markdown` and `renderStatusAsMarkdown` are deleted, and `--markdown` is now rejected
as an unrecognised argument.

These are one decision, not two. Both follow from the report being a surface built for
one human reading it in a terminal. A vocabulary chosen for that reader and a single
rendering aimed at that reader are the same commitment; a second output format would
immediately start asking for labels that suit a document instead.

## Consequences

- **The report no longer fits one screen.** The full grid across four blocks is roughly
  63 lines where rules under the headers only would have been about 40. This trades
  against ADR 0014's closing line, that the report must be dense enough to read as a
  whole. The grid won because a row the eye can follow across is worth more, at a glance,
  than fitting the viewport, and because the verdict already carries the common day: on a
  healthy day the operator stops reading after the first line, and the tables are for the
  day they do not.
- **The widest value sets the width of all four blocks.** A topic slug longer than
  today's 37 characters widens the whole report. Computed width beat truncation because a
  value worth printing is worth reading in full, and beat wrapping because rows of
  differing heights defeat the grid.
- **`--markdown` was deleted rather than kept for free**, because it was not free: three
  further blocks would each have been rendered and tested twice, forever, to serve a use
  the operator disclaimed. This is the argument that refused `--json`. A machine surface
  gets added when something machine-shaped wants one, and it would be entitled to a
  different vocabulary as well as a different shape.
- Adding a row now means being able to say plainly what question it answers. A reading
  whose only available name is the mechanism's is a reading that has not earned a row.
- Renaming a label breaks the tests that assert it, which is correct: the label is what
  the operator sees, so it is the thing worth coupling a test to.
