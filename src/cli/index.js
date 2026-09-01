// The entry point behind every toc-* command. It checks the Node requirement from ADR 0004
// before importing anything else, because node:sqlite is a static import three modules deep:
// on an older Node the process dies at load with an ERR_UNKNOWN_BUILTIN_MODULE stack trace,
// which says nothing an operator can act on.
//
// This file runs on load rather than exporting anything, so nothing imports it: the four
// bin/toc-* shims name it and pass the command they want.

const OLDEST_NODE_WITH_BUILTIN_SQLITE = { major: 22, minor: 5 };

// Static specifiers behind an explicit map, so a command name off the argv can never be read
// as a path to import.
const COMMANDS = {
  search: () => import("./search.js"),
  extract: () => import("./extract.js"),
  spend: () => import("./spend.js"),
  status: () => import("./status.js"),
};

function nodeIsTooOld() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const needed = OLDEST_NODE_WITH_BUILTIN_SQLITE;
  return major < needed.major || (major === needed.major && minor < needed.minor);
}

function theNodeItNeeds() {
  const { major, minor } = OLDEST_NODE_WITH_BUILTIN_SQLITE;
  return (
    `claude-toc needs Node >= ${major}.${minor} for node:sqlite (see docs/adr/0004); ` +
    `this is ${process.versions.node}.\n` +
    `Run 'nvm use' in the repo, or point CLAUDE_TOC_NODE at a newer node.\n`
  );
}

const [command, ...argv] = process.argv.slice(2);

if (nodeIsTooOld()) {
  process.stderr.write(theNodeItNeeds());
  process.exitCode = 1;
} else if (!Object.hasOwn(COMMANDS, command)) {
  process.stderr.write(
    `claude-toc: no such command ${JSON.stringify(command)}\n` +
      `commands: ${Object.keys(COMMANDS).join(", ")}\n`
  );
  process.exitCode = 2;
} else {
  const { main } = await COMMANDS[command]();
  process.exitCode = main(argv);
}
