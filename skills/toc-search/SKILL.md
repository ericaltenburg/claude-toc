---
name: toc-search
description: Search four months of accumulated session memory — distilled facts and raw prompt history — for what was decided, seen, or worked on. Use when an internal service, repository, or identifier comes up that is not already in context; when the user asks what was decided, whether something was seen before, or what happened on a given day or week; or when starting work on a named service or repo. Also the manual entry point, /toc-search.
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
$CLAUDE_TOC_HOME/bin/toc-search [options] <query terms>
```

Refresh runs before every query, so results are never stale and you never need to
rebuild anything.

| Option | Effect |
| --- | --- |
| (default) | top 20 facts and top 10 prompts |
| `--facts` / `--prompts` | one class only |
| `--overview` | matching topic names with hit counts, no fact text |
| `--date`, `--since`, `--until` | local dates, `YYYY-MM-DD` |
| `--project PATH` | scope to one project directory |
| `--topic ID`, `--section Decisions`, `--session ID` | narrow to one |
| `--limit N`, `--prompt-limit N` | override the default result sizes |
| `--source automatic` | mark the search as your own judgement in the log |
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

Searches you run on your own judgement are scoped to the current project
(`--project "$PWD"`) and marked `--source automatic`. A search the user asks for
is not scoped: cross-project questions are exactly the ones a person types by
hand.

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
  2026-05-12 recorded X", never "X is true". Nothing in this system will ever
  write "that changed", so a fact about a pinned version stays confident and
  wrong after the bump.
- Anything load-bearing is checked against the systems of record (the code, the
  config, git, tickets) before it is acted on.
- Keep a fact's section: **Context** is what was true, **Decisions** is what was
  chosen. Do not flatten them into one list.
- Keep facts and prompts separate. A prompt is raw text the user typed, not a
  distilled fact, and must never be presented as one.
- Facts record what a session concluded, not world state. Whether the chosen
  thing was built, deployed, or reverted is not in here.

## Writing SQL

`--sql` takes any single `select` or `with` statement; writes are refused. The
schema:

- `facts(id, topic, section, text, session, date, line)` — `date` is `YYYY-MM-DD`
  and may be null.
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

# Decisions only, newest first.
toc-search --sql "select date, topic, text from facts
                  where section = 'Decisions' and date >= '2026-07-01'
                  order by date desc limit 30"
```

## Logging

Every search appends one line to `search.log` in the corpus: timestamp, query,
row count, mode, and its source: `explicit`, `automatic`, or `smoke`. This is the
instrumentation whose absence let a dead code path survive four months unnoticed,
and it is the evidence for widening the trigger list. Do not add a way to search
that skips it.

When the user searches by hand for something a trigger above should have caught,
say so: that is the signal the list is too narrow.

## Installing

The skill is this file; the command is in the repository it came from.

1. `export CLAUDE_TOC_HOME=/path/to/claude-toc` — or set it in
   `~/.claude/settings.json` under `env`, which is what makes the pre-authorised
   permission below match.
2. Pre-authorise the read path, or automatic search stalls on a permission prompt
   and the point of automatic invocation is lost:

   ```json
   { "permissions": { "allow": ["Bash($CLAUDE_TOC_HOME/bin/toc-search:*)"] } }
   ```

   Always invoke it exactly as `$CLAUDE_TOC_HOME/bin/toc-search`, unquoted, so
   the pre-authorised prefix matches.
3. Symlink this directory into `~/.claude/skills/toc-search` so editing it in the
   repository is editing the installed read path.
4. If the `node` on PATH is older than 22.5 it has no `node:sqlite`; set
   `CLAUDE_TOC_NODE` to a newer one.

`--smoke` is the check that all of the above still works. Its queries name real
topics, so they live with the corpus at `smoke-queries.json`, not in the public
repository.
