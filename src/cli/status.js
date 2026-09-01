import { createConfig } from "../config.js";
import { createStatusReport } from "../status.js";
import { tablesFor } from "./table.js";

// One rendering, per ADR 0015. Sentences are prose and readings are boxed: the verdict and
// the footer notes are printed bare, and every reading sits in a cell of a bordered table.

export function renderStatus(report) {
  const tables = tablesFor(report.blocks);
  const lines = [verdictLine(report.verdict), ...report.verdict.problems.map((p) => `  ! ${p}`)];

  report.blocks.forEach((block, index) => {
    lines.push("", ...tables[index]);
    if (block.footer?.length) lines.push("", ...block.footer);
  });

  return `${lines.join("\n")}\n`;
}

// The line the operator stops reading after on the common day, and the one line that names
// the report.
function verdictLine(verdict) {
  return `CLAUDE-TOC STATUS: ${verdict.label}`;
}

// --- CLI ---

const USAGE = "usage: toc-status";

export function main(argv) {
  if (argv.length) {
    process.stderr.write(`toc-status: unexpected argument ${argv[0]}\n${USAGE}\n`);
    return 2;
  }

  process.stdout.write(renderStatus(createStatusReport(createConfig()).read()));
  return 0;
}
