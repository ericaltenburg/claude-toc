// Reading a Claude Code transcript. The transcript is a foreign format — Claude Code writes
// it and this project only ever reads it — so every fact about its shape belongs here, the
// way parse.js owns the corpus's own format.
//
// Two readers, because they read for different things: the extractor takes the unread tail
// and turns it into turns, and the sweeper peeks at the opening to recognise the extractor's
// own sessions.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { EXTRACTION_PROMPT_MARKER } from "./extract-prompt.js";
import { parseJsonLine } from "./parse.js";
import { START_OF_TRANSCRIPT } from "./state.js";

const NEWLINE = 0x0a;
const READ_CHUNK_BYTES = 64 * 1024;
const BYTES_SCANNED_FOR_THE_FIRST_MESSAGE = 1024 * 1024;

// --- The unread tail ---

const NOTHING_UNREAD = { turns: [], text: "", lastTurnAt: null };

export function unreadSlice(transcriptPath, offset) {
  const fd = openSync(transcriptPath, "r");
  try {
    const { size } = fstatSync(fd);
    const from = transcriptWasRotated(size, offset) ? START_OF_TRANSCRIPT : offset;
    const nothingUnread = { ...NOTHING_UNREAD, offset: from };
    if (from >= size) return nothingUnread;

    const buffer = Buffer.allocUnsafe(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    if (read <= 0) return nothingUnread;

    const endOfLastCompleteLine = buffer.lastIndexOf(NEWLINE, read - 1);
    if (endOfLastCompleteLine === -1) return nothingUnread;

    const { turns, lastTurnAt } = turnsFrom(buffer.toString("utf-8", 0, endOfLastCompleteLine));
    return {
      turns,
      lastTurnAt,
      text: turnsToText(turns),
      offset: from + endOfLastCompleteLine + 1,
    };
  } finally {
    closeSync(fd);
  }
}

function transcriptWasRotated(size, offset) {
  return offset > size;
}

function turnsFrom(jsonLines) {
  const turns = [];
  let lastTurnAt = null;

  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue;

    const entry = parseJsonLine(line);
    if (!entry) continue;

    if (typeof entry?.timestamp === "string") lastTurnAt = entry.timestamp;

    const role = entry?.role || entry?.type;
    const content = entry?.message?.content;

    if (role === "human" || role === "user") {
      if (typeof content === "string" && content.trim()) {
        turns.push({ role: "user", text: content.trim() });
        continue;
      }
      pushTextBlocks(turns, "user", content);
    } else if (role === "assistant") {
      pushTextBlocks(turns, "assistant", content);
    }
  }

  return { turns, lastTurnAt };
}

// One turn per text block, so a reply made of several blocks is several turns to chunk
// between. Stricter than `textOf` below, which is deliberate: a turn worth extracting has to
// be a real text block, whereas recognising the extraction prompt should not be fussy.
function pushTextBlocks(turns, role, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "text" && block.text?.trim()) {
      turns.push({ role, text: block.text.trim() });
    }
  }
}

function renderTurn(turn) {
  return `${turn.role === "user" ? "USER" : "ASSISTANT"}: ${turn.text}`;
}

function turnsToText(turns) {
  return turns.map(renderTurn).join("\n\n");
}

// --- Chunking for a model call ---

export function chunkTurns(turns, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join("\n\n"));
    current = [];
    size = 0;
  };

  for (const turn of turns) {
    const piece = renderTurn(turn);
    if (size && size + piece.length > maxChars) flush();

    if (piece.length > maxChars) {
      flush();
      chunks.push(...splitOversizedTurn(piece, maxChars));
      continue;
    }

    current.push(piece);
    size += piece.length + "\n\n".length;
  }
  flush();

  return chunks;
}

function splitOversizedTurn(piece, maxChars) {
  const pieces = [];
  for (let at = 0; at < piece.length; at += maxChars) {
    pieces.push(piece.slice(at, at + maxChars));
  }
  return pieces;
}

// --- How a transcript opens ---

export function howTheTranscriptOpens(transcriptPath) {
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
        const record = parseJsonLine(line);
        if (record) yield record;
      }
    }
  } finally {
    closeSync(fd);
  }
}

// Every text block a record carries, joined. Looser than `pushTextBlocks` on purpose: this
// only has to spot the extraction prompt's opening words, so a block that does not declare
// itself as text still counts if it carries text.
function textOf(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}
