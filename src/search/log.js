// The search log: one line per search, with the source that issued it, how many rows came
// back and whether its syntax fell back to bare terms. Search writes it and the status report
// reads it, so its shape lives in neither.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseJsonLine } from "../json-lines.js";

// Best effort, because a search that answered is not failed by a log it could not write.
export function logSearchBestEffort(
  config,
  now,
  { query, mode, rows, source, project, allProjects, fellBackFrom }
) {
  try {
    mkdirSync(dirname(config.searchLogPath), { recursive: true });
    appendFileSync(
      config.searchLogPath,
      `${JSON.stringify({
        ts: now().toISOString(),
        query: String(query ?? ""),
        rows,
        mode,
        source,
        ...(project ? { project } : {}),
        ...(allProjects ? { allProjects: true } : {}),
        ...(fellBackFrom ? { fellBackFrom } : {}),
      })}\n`
    );
  } catch {}
}

export function searchLogEntries(config) {
  if (!existsSync(config.searchLogPath)) return [];
  return readFileSync(config.searchLogPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map(parseJsonLine)
    .filter(Boolean);
}
