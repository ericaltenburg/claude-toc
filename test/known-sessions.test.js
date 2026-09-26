import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { knownSessions } from "../src/sessions/known-sessions.js";
import { EXTRACTION_PROMPT_MARKER } from "../src/sessions/transcript.js";
import { appendSessions, idleFor, tempCorpus, transcriptPath, writeTranscript } from "./support/corpus.js";

const A_MINUTE = 60_000;

const CONVERSATION = [
  { role: "user", text: "where do broadcast variants live for the alcs pipeline?" },
  { role: "assistant", text: "in dynamodb, keyed by show id" },
];

function sessionId(nth) {
  return `${String(nth).repeat(8)}-1111-2222-3333-444455556666`;
}

const known = (config) => [...knownSessions(config)];

test("a session is known from its transcript, from the logger, or from both, and only once", () => {
  const config = tempCorpus();
  const onDiskOnly = writeTranscript(config, sessionId(1), CONVERSATION, { cwd: "/work/disk" });
  const both = writeTranscript(config, sessionId(2), CONVERSATION, { cwd: "/work/alcs/src" });
  const rotatedAway = transcriptPath(config, sessionId(3));
  appendSessions(config, [
    { session_id: sessionId(2), transcript: both, cwd: "/work/alcs", started: "2026-08-27" },
    { session_id: sessionId(3), transcript: rotatedAway, cwd: "/work/gone", started: "2026-05-12" },
    { session_id: sessionId(2), transcript: both, cwd: "/work/alcs", started: "2026-08-27" },
  ]);

  const byId = Object.fromEntries(known(config).map((session) => [session.session_id, session]));

  assert.equal(Object.keys(byId).length, 3);
  assert.deepEqual(byId[sessionId(1)], {
    session_id: sessionId(1),
    transcript: onDiskOnly,
    cwd: "/work/disk",
    started: null,
  });
  assert.deepEqual(
    byId[sessionId(2)],
    { session_id: sessionId(2), transcript: both, cwd: "/work/alcs", started: "2026-08-27" },
    "what the logger recorded wins over what the transcript opens with"
  );
  assert.deepEqual(
    byId[sessionId(3)],
    { session_id: sessionId(3), transcript: rotatedAway, cwd: "/work/gone", started: "2026-05-12" },
    "a rotated transcript leaves the session known by what the logger kept"
  );
});

test("the newest transcript comes first, and a session with none comes after every one that has one", () => {
  const config = tempCorpus();
  appendSessions(config, [{ session_id: sessionId(9), transcript: null, cwd: "/work/gone" }]);
  idleFor(writeTranscript(config, sessionId(1), CONVERSATION), 30 * A_MINUTE);
  idleFor(writeTranscript(config, sessionId(2), CONVERSATION), 10 * A_MINUTE);
  idleFor(writeTranscript(config, sessionId(3), CONVERSATION), 20 * A_MINUTE);

  assert.deepEqual(
    known(config).map((session) => session.session_id),
    [sessionId(2), sessionId(3), sessionId(1), sessionId(9)]
  );
});

test("the extractor's own sessions are not known sessions, however they are recognised", () => {
  const config = tempCorpus();
  writeTranscript(config, sessionId(1), CONVERSATION);
  writeTranscript(config, sessionId(2), CONVERSATION);
  writeTranscript(config, sessionId(3), CONVERSATION, { projectDir: config.extractorTranscriptsDir });
  writeTranscript(config, sessionId(4), [
    { role: "user", text: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
  ]);
  writeFileSync(
    config.statePath,
    JSON.stringify({ extractorSessions: { [sessionId(2)]: "2026-08-31T19:00:00.000Z" } })
  );

  assert.deepEqual(
    known(config).map((session) => session.session_id),
    [sessionId(1)]
  );
});

// Opening a transcript costs a read, so a caller's own cheap test runs first. It sees the
// extractor's historical transcript, which only opening it can recognise, along with the size
// and write time it tests on.
test("a caller's own test narrows the list before any transcript is opened", () => {
  const config = tempCorpus();
  writeTranscript(config, sessionId(1), CONVERSATION);
  writeTranscript(config, sessionId(2), [
    { role: "user", text: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
  ]);
  const tested = [];

  const narrowed = [
    ...knownSessions(config, {
      where: (session) => {
        tested.push(session.session_id);
        return Number.isFinite(session.size) && Number.isFinite(session.modified);
      },
    }),
  ];

  assert.deepEqual(tested.sort(), [sessionId(1), sessionId(2)]);
  assert.deepEqual(
    narrowed.map((session) => session.session_id),
    [sessionId(1)]
  );
});
