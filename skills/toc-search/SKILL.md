---
name: toc-search
description: Search four months of accumulated session memory — distilled facts and raw prompt history — for what was decided, seen, or worked on. Use when an internal service, repository, or identifier comes up that is not already in context; when the user asks what was decided, whether something was seen before, or what happened on a given day or week; or when starting work on a named service or repo. Also the manual entry point, /claude-toc:toc-search.
allowed-tools: Bash(toc-search:*)
---

# toc-search

The read path into the corpus. Facts come back ranked and dated; prompts come
back as a separate class; a broad question gets an overview instead.

This file is the read path. There is no tool with a fixed parameter schema
because you write the SQL for anything the flags do not cover, which is what
removes the need for a date parser or a natural-language layer. Editing this file
changes what triggers a search and how results are presented, with no code
change.

## Run it

```sh
toc-search --source automatic [options] <query terms>
```

Every search carries `--source automatic` unless the user asked for it in the
current turn: they typed `/claude-toc:toc-search` (its command block is in the
conversation), or they directly asked you to search memory. Only then drop the
flag, so the search is logged `explicit`. Every other search is on your own
judgement.

Refresh runs before every query, so results are never stale and you never need to
rebuild anything.

| Option | Effect |
| --- | --- |
| (default) | top 20 facts and top 10 prompts |
| `--facts` / `--prompts` | one class only |
| `--overview` | matching topic names with hit counts, no fact text |
| `--date`, `--since`, `--until` | local dates, `YYYY-MM-DD` |
| `--project PATH` | scope to one project directory and what is under it |
| `--all-projects` | undo the scoping an automatic search applies |
| `--topic ID`, `--section NAME`, `--session ID` | narrow to one; the sections are `Context`, `Decisions`, `Gotchas`, `Open` |
| `--entity LIVE-53452` | only facts naming that ticket, CR, account, ARN, SHA, URL or path, in any case, and no prompts. Reach for it with any hyphenated id: query terms split one in two |
| `--limit N`, `--prompt-limit N` | override the default sizes (`--limit` also caps an overview) |
| `--source automatic` | your own judgement: logged as such, scoped to the current project |
| `--sql "select ..."` | anything the above cannot express |
| `--quarantined` | sessions extraction gave up on |
| `--smoke` | liveness check against the corpus's own smoke queries |

Query terms are matched with word boundaries and stemming, so `consolidate`
finds "consolidates" and a three-letter term does not match the inside of a URL.
Terms are OR'd and ranked, so a whole question can be passed verbatim. Upper-case
`AND`/`OR`/`NOT`/`NEAR` and a trailing `*` are passed through to FTS5 untouched.

## When to search

Narrow and enumerated on purpose. Widen this list from the search log, not from
speculation:

- An internal service, repository, package, alarm, or identifier appears that is
  not already in context.
- The user asks what was decided, whether something was seen before, or why
  something was chosen.
- Work begins on a named service or repository.
- The question is explicitly temporal: yesterday, last week, "when did we".

An automatic search scopes itself to the current project, so unrelated work
cannot bleed into the conversation, and records the scope in the log. A search
the user asks for is unscoped, because cross-project questions are exactly the
ones a person types by hand.

The current project is the repository you are working in, so a subdirectory finds
the same material the root does. `--project PATH` points somewhere else;
`--all-projects` widens an automatic search deliberately, and the log says you did.

## Choosing a shape

- **A specific question** gets facts. Do not make the user pay a round trip to
  see the answer.
- **A broad or exploratory question** ("what do we know about the poller?") gets
  `--overview` first, then a `--topic` drill-down.
- **A temporal question** gets both classes with a date filter. Compute the date
  yourself and pass it: prompts supply the timeline, facts supply the insight.
  Dates are bucketed in local time, so `--date` means the day the user means.
- **Nothing found** is an answer. Say so rather than searching six more ways.

## Presenting results

The attribution contract, which is the whole reason results are trustworthy:

- A retrieved fact is **dated evidence, not current truth**. Say "a session on
  2026-05-12 recorded X", never "X is true". A fact is marked superseded only
  when a later session changed it where extraction could see both, so an
  unmarked fact about a pinned version can still be wrong after the bump.
- Anything load-bearing is checked against the systems of record (the code, the
  config, git, tickets) before it is acted on.
- Keep a fact's section: **Context** is what was true, **Decisions** is what was
  chosen, **Gotchas** is a trap with its cause or fix, **Open** is what was still
  unsettled. Do not flatten them into one list.
- A fact labelled `superseded YYYY-MM-DD` is history, dated at both ends: "a
  session on 2026-05-12 recorded X, and a session on 2026-09-20 superseded it".
  Superseded facts come back after the current ones; the current one is the
  answer and the superseded one is how it got there.
- Keep facts and prompts separate. A prompt is raw text the user typed, not a
  distilled fact, and must never be presented as one.
- Facts record what a session concluded, not world state. Whether the chosen
  thing was built, deployed, or reverted is not in here.

## Writing SQL

`--sql` takes any single `select` or `with` statement; writes are refused.
`--source` follows the same rule here, but nothing scopes a hand-written query
for you: filter on `project` yourself when the question is about this project only.
An automatic `--sql` query is logged as unscoped, so the log never claims a bound
it did not apply. The schema:

- `facts(id, topic, section, text, session, date, line, superseded_session,
  superseded_date)` — `date` is `YYYY-MM-DD` and may be null; `superseded_date`
  is null for a current fact.
- `prompts(id, ts, local_date, local_time, session, project, text, is_command)`.
- `topics(id, summary, keywords, mtime_ms, size)`.
- `sessions(session_id, transcript_path, project, started_at, extracted_at, topic,
  extraction_offset)`.
- `facts_fts` and `prompts_fts` — external-content FTS5 over `text`, joined on
  `rowid = facts.id` / `prompts.id`, ranked with `bm25(...)`.

A fact's `session` is a truncated id, so join it with
`sessions.session_id like facts.session || '%'`.

Recipes:

```sh
# One day's timeline, in order rather than ranked.
toc-search --sql "select local_time, project, text from prompts
                  where local_date = '2026-08-27' order by ts"

# Which subjects a week touched.
toc-search --sql "select topic, count(*) hits, min(date) first, max(date) last
                  from facts where date between '2026-08-24' and '2026-08-28'
                  group by topic order by hits desc"

# Which tickets and CRs a week touched, from entities(fact_id, kind, value).
toc-search --sql "select e.kind, e.value, count(*) facts from entities e
                  join facts f on f.id = e.fact_id
                  where e.kind in ('ticket', 'cr') and f.date between '2026-08-24' and '2026-08-28'
                  group by e.kind, e.value order by facts desc"

# Decisions no later session superseded, newest first.
toc-search --sql "select date, topic, text from facts
                  where section = 'Decisions' and superseded_date is null
                    and date >= '2026-07-01'
                  order by date desc limit 30"
```

## Logging

Every search appends one line to `ledger/search.log` under the claude-toc root
(`~/.claude/claude-toc` by default): timestamp, query, row count, mode, the
project it was scoped to, and its source: `explicit`, `automatic`, or `smoke`. Source is what separates a trigger that fired from a
question a person typed, so an unrecognised `--source` is refused. This is the
instrumentation whose absence let a dead code path survive four months unnoticed,
and it is the evidence for widening the trigger list. Do not add a way to search
that skips it.

When the user searches by hand for something a trigger above should have caught,
say so: that is the signal the list is too narrow.

## Installing

This skill, the `toc-*` commands and the prompt hook are one plugin, `claude-toc`,
loaded in place from its repository, so an edit there is live on `/reload-plugins`.
Merge this into `~/.claude/settings.json`, with `path` set to the repository:

```json
{
  "extraKnownMarketplaces": {
    "claude-toc": {
      "source": { "source": "directory", "path": "/path/to/claude-toc" }
    }
  },
  "enabledPlugins": { "claude-toc@claude-toc": true },
  "permissions": { "allow": ["Bash(toc-search:*)"] }
}
```

The first two register the repository as a marketplace and enable the plugin from
it. The permission pre-authorises the read path in every turn: this skill's
`allowed-tools` covers only the turn that invokes it, and an automatic search in a
later turn would stall on a permission prompt. Run the command bare, as
`toc-search`, so the rule matches.

The commands and the hook find a node with `node:sqlite` (22.5 or later) on their
own: PATH, then the newest nvm install, then Homebrew. To pin one, set
`CLAUDE_TOC_NODE` under `env`; one that is too old is an error, not skipped.

`--smoke` is the check that all of the above still works. Its queries name real
topics, so they live beside the corpus at `config/smoke-queries.json` under the
claude-toc root, not in the public repository.
