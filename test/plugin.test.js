import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { corpusEnv, sessionPayload, tempCorpus, REPO_ROOT } from "./support/corpus.js";

const readJson = (...path) => JSON.parse(readFileSync(join(REPO_ROOT, ...path), "utf-8"));

// The plugin loads in place from the repository, so its root is the repository's.
const inPlace = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", REPO_ROOT);

function thePromptHook() {
  const { hooks } = readJson("hooks", "hooks.json");
  assert.deepEqual(Object.keys(hooks), ["UserPromptSubmit"]);
  const registered = hooks.UserPromptSubmit.flatMap((group) => group.hooks);
  assert.equal(registered.length, 1, "one hook process per prompt");
  const [hook] = registered;
  return { ...hook, command: inPlace(hook.command), args: hook.args.map(inPlace) };
}

function runThePromptHook(config, env = {}) {
  const { command, args } = thePromptHook();
  return spawnSync(command, args, {
    input: sessionPayload(config),
    encoding: "utf-8",
    timeout: 20_000,
    env: corpusEnv(config, { CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...env }),
  });
}

test("the manifest names the plugin at the version package.json carries", () => {
  const manifest = readJson(".claude-plugin", "plugin.json");

  assert.equal(manifest.name, "claude-toc");
  assert.equal(manifest.version, readJson("package.json").version);
});

test("the marketplace serves the repository root as the plugin, so it loads in place", () => {
  const marketplace = readJson(".claude-plugin", "marketplace.json");

  assert.deepEqual(marketplace.plugins, [{ name: "claude-toc", source: "./" }]);
});

test("the prompt hook runs in exec form through the launcher, on files that exist", () => {
  const hook = thePromptHook();

  assert.equal(hook.type, "command");
  assert.equal(hook.timeout, 10);
  assert.equal(hook.command, join(REPO_ROOT, "scripts", "node"));
  accessSync(hook.command, constants.X_OK);
  for (const path of hook.args.filter((arg) => !arg.startsWith("--"))) {
    assert.ok(existsSync(path), `${path} exists`);
  }
});

test("the prompt hook as registered records the session and prints nothing", () => {
  const config = tempCorpus();

  const result = runThePromptHook(config);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(readFileSync(config.sessionIndexPath, "utf-8"), /aaaaaaaa-1111/);
});

test("the prompt hook as registered exits zero when no node is new enough", () => {
  const config = tempCorpus();

  const result = runThePromptHook(config, { CLAUDE_TOC_NODE: "/no/such/node" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(config.sessionIndexPath), false);
});
