import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

import { createStateStore, ATTEMPTS_BEFORE_QUARANTINE } from "../src/state.js";
import { createSweeper, EXTRACTION_PROMPT_MARKER, SESSIONS_PER_SWEEP } from "../src/sweep.js";
import { idleFor, tempCorpus, writeRawTranscript, writeTranscript } from "./support/corpus.js";

const A_MINUTE = 60_000;
const AN_HOUR = 60 * A_MINUTE;
const LONGER_THAN_THE_IDLE_THRESHOLD = 2 * AN_HOUR;

const CONVERSATION = [
  { role: "user", text: "where do broadcast variants live for the alcs pipeline?" },
  { role: "assistant", text: "in dynamodb, keyed by show id" },
];

function sessionId(nth) {
  return `${String(nth).repeat(8)}-1111-2222-3333-444455556666`;
}

function transcript(config, id, { idleFor: idleMs = LONGER_THAN_THE_IDLE_THRESHOLD, ...options } = {}) {
  return idleFor(writeTranscript(config, id, CONVERSATION, options), idleMs);
}

function sweptSessions(config, options = {}) {
  const state = createStateStore(config);
  return createSweeper(config, state, options).candidates();
}

test("only a session idle beyond the threshold is swept", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1));
  transcript(config, sessionId(2), { idleFor: A_MINUTE });

  assert.deepEqual(
    sweptSessions(config).map((session) => session.session_id),
    [sessionId(1)]
  );
});

test("a sweep takes a small fixed number of sessions, most recent first", () => {
  const config = tempCorpus();
  for (let nth = 1; nth <= 5; nth++) {
    transcript(config, sessionId(nth), { idleFor: AN_HOUR + nth * A_MINUTE });
  }

  const swept = sweptSessions(config).map((session) => session.session_id);

  assert.equal(swept.length, SESSIONS_PER_SWEEP);
  assert.deepEqual(swept, [sessionId(1), sessionId(2), sessionId(3)]);
});

test("a session whose transcript is fully read is not swept again", () => {
  const config = tempCorpus();
  const path = transcript(config, sessionId(1));
  createStateStore(config).recordExtraction(sessionId(1), { offset: statSync(path).size });

  assert.deepEqual(sweptSessions(config), []);
});

test("a quarantined session is not swept", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1));

  const state = createStateStore(config);
  for (let attempt = 0; attempt < ATTEMPTS_BEFORE_QUARANTINE; attempt++) {
    state.recordFailure(sessionId(1), "the model timed out");
  }

  assert.deepEqual(sweptSessions(config), []);
});

test("a session the extractor was spawned under is never swept", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1));
  createStateStore(config).recordExtractorSession(sessionId(1));

  assert.deepEqual(sweptSessions(config), []);
});

test("a transcript under the extractor's own project directory is never swept", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1), { projectDir: config.extractorTranscriptsDir });

  assert.deepEqual(sweptSessions(config), []);
});

test("a transcript whose first record is the extraction prompt is never swept", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1));
  idleFor(
    writeTranscript(config, sessionId(2), [
      { role: "user", text: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
      { role: "assistant", text: '{"skip": true}' },
    ]),
    LONGER_THAN_THE_IDLE_THRESHOLD
  );

  assert.deepEqual(
    sweptSessions(config).map((session) => session.session_id),
    [sessionId(1)]
  );
});

test("a session that merely discusses the extraction prompt is a real session", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1), { idleFor: LONGER_THAN_THE_IDLE_THRESHOLD });
  idleFor(
    writeTranscript(config, sessionId(2), [
      { role: "user", text: "read src/extract.js and tell me what the prompt says" },
      { role: "assistant", text: `it opens with "${EXTRACTION_PROMPT_MARKER}."` },
    ]),
    LONGER_THAN_THE_IDLE_THRESHOLD
  );

  assert.deepEqual(
    sweptSessions(config)
      .map((session) => session.session_id)
      .sort(),
    [sessionId(1), sessionId(2)]
  );
});

test("a swept session carries the project it was working in", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1), { cwd: "/work/alcs" });

  assert.deepEqual(sweptSessions(config), [
    {
      session_id: sessionId(1),
      transcript: `${config.transcriptsDir}/${sessionId(1)}.jsonl`,
      cwd: "/work/alcs",
    },
  ]);
});

test("the extraction prompt is recognised behind the metadata records Claude Code writes first", () => {
  const config = tempCorpus();
  const preamble = [
    { type: "agent-setting", agentSetting: "claude" },
    { type: "queue-operation", prompt: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
    { type: "attachment", cwd: "/work/alcs" },
  ];
  idleFor(
    writeRawTranscript(config, sessionId(1), [
      ...preamble,
      {
        type: "user",
        cwd: "/work/alcs",
        message: { content: `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation.` },
      },
    ]),
    LONGER_THAN_THE_IDLE_THRESHOLD
  );
  idleFor(
    writeRawTranscript(config, sessionId(2), [
      ...preamble,
      { type: "user", cwd: "/work/alcs", message: { content: "what broke the alcs pipeline?" } },
    ]),
    LONGER_THAN_THE_IDLE_THRESHOLD
  );

  assert.deepEqual(sweptSessions(config), [
    {
      session_id: sessionId(2),
      transcript: `${config.transcriptsDir}/${sessionId(2)}.jsonl`,
      cwd: "/work/alcs",
    },
  ]);
});

test("a subagent's transcript is not a session and is never swept", () => {
  const config = tempCorpus();
  transcript(config, "agent-af2bf8dbf160c5fb5", {
    projectDir: `${config.transcriptsDir}/-Users-ealten-work-alcs/${sessionId(1)}/subagents`,
  });

  assert.deepEqual(sweptSessions(config), []);
});

test("a transcript in a nested project directory is found", () => {
  const config = tempCorpus();
  transcript(config, sessionId(1), {
    projectDir: `${config.transcriptsDir}/-Users-ealten-work-alcs`,
  });

  assert.equal(sweptSessions(config).length, 1);
});
