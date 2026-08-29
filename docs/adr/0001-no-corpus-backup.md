# No corpus backup

The corpus is the only irreplaceable artifact this project produces: transcripts
rotate off disk, so a lost fact cannot be re-extracted, and by now most processed
sessions no longer have a transcript to go back to. We nevertheless decided to run
with no backup at all — no private repo, no scripted copy — because this is a
personal project and the loss risk is acceptable to its only user.

## Consequences

Two things follow that would otherwise look like over-caution:

- **Extraction appends to topic markdown only after the model call succeeds.** With
  no history to restore from, this ordering is the only thing standing between a
  crashed extraction and a corrupted corpus. Do not "optimise" it into a streaming
  write.
- **There is no way to undo a bad extraction.** If a prompt change starts producing
  junk facts, the only remedy is hand-editing markdown. This is a real argument for
  validating prompt changes on a small batch before a bulk run.

If the corpus ever stops being disposable-in-practice, revisit this first. Making
this repo private and tracking the corpus in it is the cheapest reversal.
