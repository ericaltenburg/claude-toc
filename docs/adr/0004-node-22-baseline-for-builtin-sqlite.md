# ADR 0004: Node 22 baseline, so SQLite stays a built-in

**Status:** accepted (2026-08-29)

## Context

The index is SQLite with FTS5. The project has no dependencies and wants to keep
it that way: it is a personal tool that must still start in a year without a
lockfile resolving, a native module rebuilding against a new Node ABI, or a
`node_modules` directory existing at all.

Three ways to reach SQLite from Node:

1. `node:sqlite`, built into the runtime. No dependency, no native build. Landed
   in 22.5.0 and usable without a flag from 22.13. Still marked experimental, so
   it prints a warning to stderr on first use.
2. `better-sqlite3`. Mature, but a native module: a compiler at install time and a
   rebuild on every Node major.
3. Shelling out to the `sqlite3` CLI. No dependency either, but every query
   becomes text in and text out through a subprocess, and parameter binding has
   to be reinvented.

The repository previously tested on Node 20 and 22.

## Decision

Use `node:sqlite`, and raise the supported runtime to Node **>= 22.5**. Node 20 is
dropped from the test matrix.

## Consequences

- Tests and the shipped `bin/` wrappers must run the interpreter deliberately rather than
  whatever `node` resolves to: a machine with an older `node` first on `PATH` fails at
  `import "node:sqlite"`, which is why the wrappers honour `CLAUDE_TOC_NODE` and the test
  helpers set it to the interpreter running the suite.

- The zero-dependency property survives; the index needs no install step.
- Node 20 no longer runs this project. It reaches end of life in April 2026, which
  is behind us, so this costs nothing real.
- `node:sqlite` is experimental, so its API may change under us and it emits an
  `ExperimentalWarning` to stderr on first use. The test script passes
  `--disable-warning=ExperimentalWarning`. Every future process that opens the
  index must pass it too, and this matters beyond tidiness: the sweep hook's
  contract is to write nothing to stderr, so the hooks and anything they spawn
  will need the flag when they start touching the index. Nothing in the hooks
  opens it yet.
- FTS5 with `porter unicode61` is confirmed present in the bundled SQLite
  (3.51.2 as of writing), which is what the word-boundary and stemming behaviour
  depends on.
- If the experimental API does break, the escape hatch is `better-sqlite3` with
  the same schema and SQL; only the connection code is affected. The index is
  derived and disposable, so nothing has to be migrated.
