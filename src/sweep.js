import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const EXTRACTION_PROMPT_MARKER = "You are a memory extraction system";
export const SESSION_IS_IDLE_AFTER_MS = 60 * 60_000;
export const SESSIONS_PER_SWEEP = 3;

const TRANSCRIPT_SUFFIX = ".jsonl";
const READ_CHUNK_BYTES = 64 * 1024;
const BYTES_SCANNED_FOR_THE_FIRST_MESSAGE = 1024 * 1024;

const A_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSweeper(
  config,
  state,
  {
    idleAfterMs = SESSION_IS_IDLE_AFTER_MS,
    sessionsPerSweep = SESSIONS_PER_SWEEP,
    now = () => Date.now(),
  } = {}
) {
  function candidates() {
    const recorded = state.snapshot();
    const idle = transcriptsOnDisk()
      .filter((transcript) => isReadyToExtract(transcript, recorded))
      .sort((a, b) => b.modified - a.modified);

    const chosen = [];
    for (const transcript of idle) {
      if (chosen.length === sessionsPerSweep) break;
      const opening = firstMessageIn(transcript.path);
      if (opening.isTheExtractionPrompt) continue;
      chosen.push({
        session_id: transcript.sessionId,
        transcript: transcript.path,
        cwd: opening.cwd,
      });
    }
    return chosen;
  }

  function isReadyToExtract({ sessionId, path, modified, size }, recorded) {
    if (isTheExtractorsOwnSession(sessionId, path, recorded)) return false;
    if (recorded.isQuarantined(sessionId)) return false;
    if (everythingIsRead(size, recorded.extractionOffset(sessionId))) return false;
    return now() - modified >= idleAfterMs;
  }

  function isTheExtractorsOwnSession(sessionId, path, recorded) {
    return recorded.isExtractorSession(sessionId) || path.startsWith(config.extractorTranscriptsDir);
  }

  function transcriptsOnDisk() {
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

  return { candidates };
}

function everythingIsRead(size, offset) {
  return size === offset;
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function firstMessageIn(transcriptPath) {
  let cwd = null;

  for (const record of openingRecordsOf(transcriptPath)) {
    cwd ??= typeof record?.cwd === "string" ? record.cwd : null;

    const text = textOf(record);
    if (!text) continue;
    return { isTheExtractionPrompt: text.includes(EXTRACTION_PROMPT_MARKER), cwd };
  }

  return { isTheExtractionPrompt: false, cwd };
}

function* openingRecordsOf(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }

  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf-8");
    let scanned = 0;
    let pending = "";

    while (scanned < BYTES_SCANNED_FOR_THE_FIRST_MESSAGE) {
      const read = readSync(fd, buffer, 0, buffer.length, scanned);
      if (read <= 0) return;
      scanned += read;

      const lines = (pending + decoder.write(buffer.subarray(0, read))).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const record = parsedOrNull(line);
        if (record) yield record;
      }
    }
  } finally {
    closeSync(fd);
  }
}

function parsedOrNull(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textOf(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}
