import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkTurns, howTheTranscriptOpens, unreadSlice } from "../src/transcript.js";
import { EXTRACTION_PROMPT_MARKER } from "../src/extract-prompt.js";
import { tempCorpus, writeRawTranscript, writeTranscript } from "./support/corpus.js";

test("chunkTurns keeps turns whole until a single turn cannot fit", () => {
  const turns = [
    { role: "user", text: "a".repeat(50) },
    { role: "assistant", text: "b".repeat(50) },
  ];
  assert.equal(chunkTurns(turns, 1000).length, 1);
  assert.equal(chunkTurns(turns, 70).length, 2);
  assert.equal(chunkTurns([{ role: "user", text: "c".repeat(500) }], 100).length, 6);
});

test("the unread slice starts where the last one stopped", () => {
  const config = tempCorpus();
  const path = writeTranscript(config, "316972f2-1111-2222-3333-444455556666", [
    { role: "user", text: "the first question" },
    { role: "assistant", text: "the first answer" },
  ]);

  const whole = unreadSlice(path, 0);
  const nothingLeft = unreadSlice(path, whole.offset);

  assert.equal(whole.turns.length, 2);
  assert.match(whole.text, /USER: the first question/);
  assert.match(whole.text, /ASSISTANT: the first answer/);
  assert.deepEqual(nothingLeft.turns, []);
  assert.equal(nothingLeft.offset, whole.offset);
});

// A transcript that rotated away is shorter than the offset already read from it, so reading
// from that offset would read nothing forever.
test("an offset past the end of a rotated transcript starts over", () => {
  const config = tempCorpus();
  const path = writeTranscript(config, "316972f2-1111-2222-3333-444455556666", [
    { role: "user", text: "a question after the rotation" },
  ]);

  const slice = unreadSlice(path, 10_000_000);

  assert.equal(slice.turns.length, 1);
  assert.equal(slice.offset > 0, true);
});

test("a half-written last line is left for the next read", () => {
  const config = tempCorpus();
  const path = writeRawTranscript(config, "316972f2-1111-2222-3333-444455556666", [
    { type: "user", message: { content: "a whole line" } },
  ]);

  const slice = unreadSlice(path, 0);

  assert.equal(slice.turns.length, 1);
  assert.equal(slice.turns[0].text, "a whole line");
});

test("the extractor's own transcript is recognised by how it opens", () => {
  const config = tempCorpus();
  const mine = writeTranscript(config, "316972f2-1111-2222-3333-444455556666", [
    { role: "user", text: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
  ]);
  const yours = writeTranscript(config, "aaaaaaaa-1111-2222-3333-444455556666", [
    { role: "user", text: "an ordinary question" },
  ]);

  assert.equal(howTheTranscriptOpens(mine).isTheExtractionPrompt, true);
  assert.equal(howTheTranscriptOpens(yours).isTheExtractionPrompt, false);
});

test("a transcript that cannot be opened reports neither prompt nor cwd", () => {
  assert.deepEqual(howTheTranscriptOpens("/no/such/transcript.jsonl"), {
    isTheExtractionPrompt: false,
    cwd: null,
  });
});
