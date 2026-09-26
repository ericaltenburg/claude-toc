# claude-toc

Session memory for Claude Code. claude-toc turns your finished sessions into dated facts
in plain markdown, indexes them with your raw prompt history, and lets Claude search both
when it decides it needs to. Nothing is ever pushed into your prompts.

- **Pull, not push.** Claude reaches for memory through the `toc-search` skill on its own
  judgement. The hook that feeds the corpus prints nothing and never costs you a prompt.
- **Facts, not transcripts.** Each fact is one markdown line with the session and date it came
  from, filed under Context, Decisions, Gotchas or Open.
- **Dated evidence, not current truth.** Every result says when it was recorded, and a fact a
  later session changed is marked superseded, never deleted.
- **Zero dependencies.** Node 22.5+ and its built-in `node:sqlite`. No `node_modules`, no
  vector store, no server.

## How it works

```
  you submit a prompt
          |
          v
  UserPromptSubmit hook      records the session, then sweeps (silent, always exits 0)
          |
          |  a session idle for an hour, with turns nobody has read yet
          v
  toc-extract (detached)     aws bedrock-runtime invoke-model, Claude Sonnet, your profile
          |
          v
  corpus/topics/*.md         dated facts under Context / Decisions / Gotchas / Open
          |
          |  refreshed before every query
          v
  cache/index.db             SQLite FTS5 over facts, plus ~/.claude/history.jsonl prompts
          ^
          |  toc-search, when Claude judges it useful
  Claude, via the toc-search skill
```

1. **Record and sweep.** One `UserPromptSubmit` hook notes each new session, then, at most once
   a minute, starts a detached extractor for up to three sessions that have been idle for an
   hour with unread turns, newest first.
2. **Extract.** The extractor sends only the unread slice of each transcript to Claude Sonnet on
   Amazon Bedrock, through the `aws` CLI with a named profile, and gets back facts, a topic to
   file them under, and which known facts they supersede. A slice lands whole or not at all,
   and a session that fails three times is quarantined so it cannot block the queue.
3. **Index.** Before every query, a derived SQLite index catches up with the markdown and with
   Claude Code's prompt log. Delete it and it rebuilds itself.
4. **Search.** Claude runs `toc-search` when an unfamiliar service or identifier comes up, when
   you ask what was decided, or when a question is about a day or a week. By hand, it is
   `/claude-toc:toc-search`.

Transcripts are read where Claude Code keeps them. The only thing that leaves your machine is
each unread slice, sent to Bedrock under an AWS profile you choose.

## Quick start

**You need:**

- Node 22.5 or later somewhere on the machine. The commands look on `PATH`, then the newest nvm
  install, then Homebrew, so the node first on `PATH` can be older.
- The AWS CLI, with a profile that can call `bedrock-runtime invoke-model` without a terminal
  prompt, and access to `global.anthropic.claude-sonnet-5` (with `global.anthropic.claude-opus-5`
  as the fallback). The default profile is `claudecode`, in `us-west-2`.

**Install the plugin:**

```sh
claude plugin marketplace add ericaltenburg/claude-toc    # or the path to a local clone
claude plugin install claude-toc@claude-toc
```

Installed from a local clone, the plugin loads in place, so an edit there is live on
`/reload-plugins` or the next session. Installed from GitHub, it runs from a copy under
`~/.claude/plugins/cache/`: run `claude plugin update claude-toc@claude-toc` and restart to pick
up a new version.

**Then merge this into `~/.claude/settings.json`:**

```json
{
  "permissions": { "allow": ["Bash(toc-search:*)"] },
  "env": { "CLAUDE_TOC_AWS_PROFILE": "your-bedrock-profile" }
}
```

The permission lets Claude search in any turn. The skill pre-approves only the turn that loads
it, so without this line an automatic search later on stalls at a permission prompt. The `env`
entry is needed only if your profile is not called `claudecode`.

**Mind the backlog.** Every transcript already under `~/.claude/projects/` counts as unread,
so the first sweeps work through your history, newest first, three sessions at a time.
`du -sh ~/.claude/projects` gives a rough upper bound on what that costs (see [Cost](#cost)).
Your prompt history is searchable at once, and a session's facts arrive once it has been quiet
for an hour, on your next prompt in any session.

## Usage

Mostly you do nothing: Claude searches when the skill says it is worth it. The commands are on
the Bash tool's `PATH` inside Claude Code; from a terminal, run them from a clone's `bin/`.

```sh
# A question, verbatim. Terms are stemmed, OR'd and ranked.
toc-search "how does the export job retry"

# One local day: the prompts give the timeline, the facts give the insight.
toc-search --date 2026-09-14

# A broad subject: which topics match, then drill into one.
toc-search --overview export job
toc-search --topic export_job --section Gotchas

# Every fact naming an identifier (ticket, commit, account, ARN, URL or path).
toc-search --entity PAY-1234

# Anything the flags cannot say, as one read-only select.
toc-search --sql "select date, topic, text from facts
                  where section = 'Decisions' and superseded_date is null
                  order by date desc limit 20"
```

The first of those prints something like:

```
FACTS  2 of 2
  1. [export_job | Decisions | 2026-09-14 | session 4b1e9c2a]
     Export job retries three times with exponential backoff, capped at 10 minutes
  2. [export_job | Decisions | 2026-06-02 | session 91d0f3e7 | superseded 2026-09-14]
     Export job retries five times at a fixed 30 second interval
PROMPTS  1 of 1
  1. [2026-09-14 10:32 | /Users/you/src/export-job]
     make the export retries back off instead of hammering the API

note: every line above is dated evidence, not current truth. Attribute it to its
date when you use it, and check anything load-bearing against the systems of record.
```

| Command | What it does |
| --- | --- |
| `toc-search` | The read path. `--help` lists every flag; `--smoke` checks the corpus still answers its own test queries; `--quarantined` lists sessions extraction gave up on. |
| `toc-status` | One report: a verdict naming anything blocked, then what extraction has done, what the corpus holds, how often search runs, and what it cost. |
| `toc-extract` | Lists sessions and whether each is extracted. `--all` extracts every unread one, `<id>` extracts one by session id prefix, `--retry <id>` releases a quarantined one and tries again in smaller chunks. `--dedup` prints a plan for merging near-duplicate topics, and `--dedup --apply` carries it out. |
| `toc-spend` | Model calls, tokens and estimated dollars, by day, by model and by session. |

## What a topic looks like

A topic is one markdown file, `corpus/topics/export_job.md`:

```markdown
# export job

## Context

- Export job runs nightly and writes CSVs to the reports bucket [session:91d0f3e7, 2026-06-02]

## Decisions

- Export job retries five times at a fixed 30 second interval [session:91d0f3e7, 2026-06-02] [superseded:4b1e9c2a, 2026-09-14]
- Export job retries three times with exponential backoff, capped at 10 minutes [session:4b1e9c2a, 2026-09-14]

## Gotchas

- The export times out on month-end runs because the query scans the whole table; filtering on the partition key fixed it [session:4b1e9c2a, 2026-09-14]

## Open

- Whether to move the export off the nightly schedule [session:4b1e9c2a, 2026-09-14]
```

**Context** is what is true about the subject, **Decisions** is what was settled, **Gotchas** is
a trap with its cause or fix, and **Open** is what was not settled yet. When a later session
changes a value, reverses a decision or answers an open item, the old line keeps its text and
gains a `[superseded:...]` marker. Search still returns it, after the current facts. A wrong
mark costs one hand edit; a deleted fact could not be recovered. The markdown is the source of
truth: read it, grep it or fix it by hand, and the index picks the change up on the next query.

## Where data lives

Everything sits under one root, `~/.claude/claude-toc/`, grouped by how replaceable it is:

```
~/.claude/claude-toc/
  corpus/   topics/*.md, toc.json                                the source of truth: back this up
  ledger/   state.json, sessions.jsonl, spend.jsonl, search.log   history: not facts, not rebuildable
  config/   model-rates.json, smoke-queries.json                  optional, written only by you
  cache/    index.db, extractor/, extraction.lock                 disposable: safe to delete while idle
```

**Back up `corpus/`.** Claude Code rotates transcripts away, so a lost fact cannot be
re-extracted. The root is deliberately not the plugin's data directory, because Claude Code
deletes that on uninstall. To move it, set `CLAUDE_TOC_CORPUS_DIR`.

## Configuration

Set these under `env` in `~/.claude/settings.json`, so the hook and the commands both see them.

| Variable | Default | Sets |
| --- | --- | --- |
| `CLAUDE_TOC_AWS_PROFILE` | `claudecode` | the AWS profile extraction calls Bedrock with |
| `CLAUDE_TOC_AWS_REGION` | `$AWS_REGION`, else `us-west-2` | the Bedrock region |
| `CLAUDE_TOC_CORPUS_DIR` | `~/.claude/claude-toc` | the root above |
| `CLAUDE_TOC_NODE` | found on `PATH`, nvm or Homebrew | a pinned node; one older than 22.5 is an error, not skipped |
| `CLAUDE_TOC_TRANSCRIPTS_DIR` | `~/.claude/projects` | where transcripts are read from |
| `CLAUDE_TOC_PROMPT_LOG` | `~/.claude/history.jsonl` | the prompt history that is indexed |

Two optional files go in `config/`. `model-rates.json` overrides the list prices, in dollars per
million tokens, as `{"<model id>": {"input": 3, "output": 15}}`. `smoke-queries.json` holds
queries the corpus must keep answering, such as
`[{"query": "export job retries", "expectTopic": "export_job"}]`. It lives beside your corpus,
not in the repo, because its queries name your topics.

## Cost

Search is free. Extraction is billed to your AWS profile, and every call is logged with its
tokens, so `toc-spend` and `toc-status` show what it cost. Dollars are an estimate from list
prices; tokens are exact.

On the author's corpus, extraction cost about **$0.086 per unread megabyte of transcript**
([ADR 0013](docs/adr/0013-the-backfill-was-a-one-off.md)). The first month came to about **$28
over 217 model calls**. About $12 of that was one day working through the backlog, and ordinary
use since has run well under a dollar a day.

## Design

The reasoning is written down as ADRs in [`docs/adr/`](docs/adr/), and
[`CONTEXT.md`](CONTEXT.md) is the glossary. The load-bearing ones:

| ADR | Decision |
| --- | --- |
| [0003](docs/adr/0003-rank-facts-not-topics.md) | Search ranks facts, not topics, because a topic can hold hundreds of facts |
| [0004](docs/adr/0004-node-22-baseline-for-builtin-sqlite.md) | Node 22.5 is the baseline, so SQLite is a built-in and there is nothing to install |
| [0009](docs/adr/0009-every-result-path-carries-the-attribution-note.md) | Every result path ends with the attribution note |
| [0010](docs/adr/0010-sweep-on-prompt-submission.md) | Extraction is swept on prompt submission, because end-of-session hooks missed most sessions |
| [0012](docs/adr/0012-extraction-calls-bedrock-on-a-named-profile.md) | Extraction calls Bedrock directly on a named profile, so who pays is observable |
| [0017](docs/adr/0017-each-layer-owns-its-files-and-the-index-is-the-only-sql.md) | Each layer owns its files on disk, and only the index speaks SQL |
| [0018](docs/adr/0018-the-root-is-grouped-by-how-replaceable-each-file-is.md) | The root is grouped by how replaceable each file is |
| [0019](docs/adr/0019-gotchas-open-and-superseded-facts-are-marked-never-deleted.md) | Gotchas and Open are sections, and a superseded fact is marked, never deleted |
| [0020](docs/adr/0020-entities-are-found-by-pattern-at-index-time.md) | Identifiers are found by pattern at index time, so a rebuild is free and repeatable |

## Development

```sh
git clone https://github.com/ericaltenburg/claude-toc
cd claude-toc
npm test      # Node 22.5+, no install step
```

The tests run against a temporary corpus with the model call stubbed out, so they need no AWS
access. CI runs them on Node 22 and 24. To try a change against your own sessions, point
`CLAUDE_TOC_CORPUS_DIR` at a scratch root first. Never commit a corpus: this repo is public,
and yours holds whatever your sessions did.

## License

Not yet chosen.
