import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The corpus has no backup (ADR 0001), and the extractor is a detached process that can be
// killed at any moment. So a corpus file is written beside itself and renamed over the
// original, and whoever reads it next finds the old content or the new, never a truncated
// file. The temp name carries the pid so that two writers never truncate each other's.
//
// Topic files, toc.json and state.json are all written this way, so it belongs to no one
// layer: the corpus and the sessions layer each write through it. Those files sit in
// different directories under the root (ADR 0018), so it creates the file's own.
//
// This survives a killed process, not a power cut: nothing is fsynced. Sync the temp file
// before the rename if the corpus ever has to survive the machine losing power mid-write.
export function writeFileAtomically(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, content);
  renameSync(temp, path);
}
