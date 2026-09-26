// Every session claude-toc knows about, as one list. A session is known from either of two
// places, and each knows something the other cannot:
//
// - its transcript on disk, which Claude Code writes, and which is how a session the logger
//   hook never saw is found at all;
// - its line in the session index, which the logger hook writes on the first prompt, and which
//   keeps the session's working directory and start after its transcript has rotated away.
//
// Listing, --all, a session prefix, --retry and the sweep all read this one list, so a session
// one of them can see is a session all of them can see. They used to read one source each, the
// sweep the transcripts and everything else the index, and the two disagreed (ADR 0017).
//
// The extractor's own sessions are never on it (ADR 0011). A recorded extractor id and a
// transcript under the extractor's own directory cost nothing to drop. A historical transcript
// that opens with the extraction prompt costs a read to recognise, so that check comes last and
// lazily, after a caller's own cheap test has narrowed the list to what it wants.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createStateStore } from "./progress.js";
import { recordedSessions } from "./registry.js";
import { howTheTranscriptOpens } from "./transcript.js";

const TRANSCRIPT_SUFFIX = ".jsonl";

// A session is a transcript whose file name is a session id. Claude Code also writes subagent
// transcripts under a session's own directory, named agent-*, and those are not sessions
// (ADR 0010).
const A_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTHING_TO_OPEN = { isTheExtractionPrompt: false, cwd: null };
const everySession = () => true;

// Each session in the shape extraction takes it, which is the shape the logger records it in:
// `session_id`, `transcript`, `cwd` and `started`. The working directory and start come from the
// session index when it has them, and the directory from the transcript's opening when not.
export function* knownSessions(
  config,
  { recorded = createStateStore(config).snapshot(), where = everySession } = {}
) {
  for (const known of knownSessionsBeforeOpening(config, recorded).filter(where)) {
    const opening = hasATranscript(known)
      ? howTheTranscriptOpens(known.transcript)
      : NOTHING_TO_OPEN;
    if (opening.isTheExtractionPrompt) continue;
    yield {
      session_id: known.session_id,
      transcript: known.transcript,
      cwd: known.cwd ?? opening.cwd,
      started: known.started,
    };
  }
}

// The same list before any transcript is opened, newest first by the transcript's last write,
// each session carrying that write time and the transcript's size as `modified` and `size`, or
// null for both when it has no transcript on disk. This is what a caller filters on for free:
// the sweep hook decides on it alone, since nothing expensive may run in front of a prompt
// (ADR 0010).
export function knownSessionsBeforeOpening(config, recorded) {
  const byId = new Map();

  for (const transcript of transcriptsOnDisk(config)) {
    byId.set(transcript.sessionId, {
      session_id: transcript.sessionId,
      transcript: transcript.path,
      cwd: null,
      started: null,
      modified: transcript.modified,
      size: transcript.size,
    });
  }

  for (const record of recordedSessions(config)) {
    const known = byId.get(record.sessionId);
    if (known) {
      known.cwd ??= record.project;
      known.started ??= record.startedAt;
      continue;
    }
    const stats = record.transcriptPath ? statOrNull(record.transcriptPath) : null;
    byId.set(record.sessionId, {
      session_id: record.sessionId,
      transcript: record.transcriptPath,
      cwd: record.project,
      started: record.startedAt,
      modified: stats?.mtimeMs ?? null,
      size: stats?.size ?? null,
    });
  }

  return [...byId.values()]
    .filter((known) => !isTheExtractorsOwnSession(known, recorded, config))
    .sort(newestFirst);
}

function isTheExtractorsOwnSession({ session_id: sessionId, transcript }, recorded, config) {
  return (
    recorded.isExtractorSession(sessionId) ||
    Boolean(transcript?.startsWith(config.extractorTranscriptsDir))
  );
}

// A session with no transcript on disk sorts after every one that has one, in the order the
// logger recorded it.
function newestFirst(a, b) {
  return (b.modified ?? 0) - (a.modified ?? 0);
}

function hasATranscript(known) {
  return known.modified !== null;
}

function transcriptsOnDisk(config) {
  if (!existsSync(config.transcriptsDir)) return [];

  const transcripts = [];
  for (const entry of readdirSync(config.transcriptsDir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(TRANSCRIPT_SUFFIX)) continue;
    const sessionId = entry.name.slice(0, -TRANSCRIPT_SUFFIX.length);
    if (!A_SESSION_ID.test(sessionId)) continue;

    const path = join(entry.parentPath, entry.name);
    const stats = statOrNull(path);
    if (!stats) continue;
    transcripts.push({
      sessionId,
      path,
      modified: stats.mtimeMs,
      size: stats.size,
    });
  }
  return transcripts;
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
