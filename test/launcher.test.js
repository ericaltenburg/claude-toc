import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAUNCHER } from "./support/corpus.js";

const PRINT_THE_VERSION = ["-e", "console.log(process.version)"];

// Answers --version with its version, and anything else by echoing that version and its
// arguments, so a test can see which candidate ran and what it was handed.
function fakeNode(dir, version) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "node");
  writeFileSync(
    path,
    `#!/bin/sh\n[ "$1" = --version ] && { echo ${version}; exit 0; }\necho "${version} $*"\n`,
    { mode: 0o755 }
  );
  return path;
}

// A machine with a node of the given version on PATH and nvm installs under HOME, and
// nothing inherited, since the shell running the suite may set CLAUDE_TOC_NODE or NVM_DIR.
function machine({ pathNode, nvm = [] }) {
  const root = mkdtempSync(join(tmpdir(), "claude-toc-launcher-"));
  const bin = join(root, "bin");
  fakeNode(bin, pathNode);
  for (const version of nvm) fakeNode(join(root, ".nvm", "versions", "node", version, "bin"), version);
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: root };
}

function launch(args, env) {
  return spawnSync(LAUNCHER, args, { env, encoding: "utf-8", timeout: 20_000 });
}

test("CLAUDE_TOC_NODE wins over a newer node on PATH", () => {
  const env = { ...machine({ pathNode: "v99.0.0" }), CLAUDE_TOC_NODE: process.execPath };

  const result = launch(PRINT_THE_VERSION, env);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${process.version}\n`);
});

test("a CLAUDE_TOC_NODE too old for node:sqlite fails rather than being passed over", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-toc-launcher-"));
  const env = {
    ...machine({ pathNode: "v24.1.0" }),
    CLAUDE_TOC_NODE: fakeNode(join(root, "old"), "v22.4.0"),
  };

  const result = launch(PRINT_THE_VERSION, env);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /needs Node >= 22\.5 for node:sqlite \(see docs\/adr\/0004\)/);
  assert.match(result.stderr, /CLAUDE_TOC_NODE is .*old\/node, which is v22\.4\.0/);
});

test("--optional exits zero without a node, so the prompt hook cannot fail a prompt", () => {
  const env = { ...machine({ pathNode: "v24.1.0" }), CLAUDE_TOC_NODE: "/no/such/node" };

  const result = launch(["--optional", ...PRINT_THE_VERSION], env);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CLAUDE_TOC_NODE is \/no\/such\/node, which is not a node/);
});

test("node on PATH runs when it is new enough, with the experimental warning off", () => {
  const result = launch(PRINT_THE_VERSION, machine({ pathNode: "v22.5.0" }));

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "v22.5.0 --disable-warning=ExperimentalWarning -e console.log(process.version)\n"
  );
});

test("a node on PATH that is too old gives way to the newest nvm install", () => {
  const env = machine({
    pathNode: "v20.20.1",
    nvm: ["v9.11.2", "v20.1.0", "v22.4.0", "v22.10.0"],
  });

  const result = launch(PRINT_THE_VERSION, env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^v22\.10\.0 /);
});
