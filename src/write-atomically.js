import { renameSync, writeFileSync } from "node:fs";

// The corpus has no backup (ADR 0001), and the extractor is a detached process that can be
// killed at any moment. So a corpus file is written beside itself and renamed over the
// original, and whoever reads it next finds the old content or the new, never a truncated
// file. The temp name carries the pid so that two writers never truncate each other's.
//
// This survives a killed process, not a power cut: nothing is fsynced. Sync the temp file
// before the rename if the corpus ever has to survive the machine losing power mid-write.
export function writeFileAtomically(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}
