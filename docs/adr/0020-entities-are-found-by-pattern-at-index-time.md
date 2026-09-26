# ADR 0020: Entities are found by pattern at index time

**Status:** accepted (2026-09-26)

## Context

About one fact in nine names a hard identifier: a ticket (LIVE-53452, MCM-155302452), a code
review (CR-294186991), an AWS account or ARN, a commit, a URL or a file path. The most-cited
ones turn up in 12 to 18 facts each, across several topics, and "every fact about LIVE-53452"
is a question people ask.

Full text cannot answer it. FTS5's tokenizer splits `LIVE-53452` into `live` and `53452`, so
`toc-search LIVE-53452` returned 454 of the corpus's 4,814 facts, with the 12 that name the
ticket ranked somewhere among every fact that says "live".

## Decision

Refresh runs each fact's text through a fixed set of patterns (`index/entities.js`) as it
inserts the fact, and stores what they find in `entities(fact_id, kind, value)`. The rows
cascade away with their fact. `toc-search --entity VALUE` narrows facts to those carrying the
value, and combines with query terms and every other filter.

**Patterns, not the model.** The index is derived and disposable (ADR 0017): deleting it costs
only the time to rebuild it, and a rebuild must give the same index. A model pass would cost
money on every rebuild, could answer differently each time, and would have to write its
answers into the markdown, changing the format, or into a store the index could not rebuild.
An identifier is lexical anyway. Its shape is the whole definition of it, and a pattern is
free, deterministic and testable.

**The kinds**, and the form a value is stored in:

| Kind | Shape | Stored as |
| --- | --- | --- |
| `ticket` | upper-case letters ending in a letter, a dash, 3 or more digits | as written |
| `cr` | `CR-` and 6 or more digits, in any case | upper case |
| `account` | exactly 12 digits | as written |
| `arn` | `arn:aws…:service:region:account:resource`, the account 12 digits or empty | as written |
| `sha` | 7, or 9 to 40, lower-case hex characters, with a letter and a digit | as written |
| `url` | `http(s)://…`, or a host on a common TLD followed by a path | without scheme or trailing `/` |
| `path` | `/a/b`, `~/a/b`, `a/b.ext`, or `src/a/b`-style under a source directory | without trailing `/` |

A value is compared without regard to case (`collate nocase`), and the lookup drops a URL's
scheme and trailing slash the same way, so `https://w.amazon.com/x/` finds a fact that wrote
`w.amazon.com/x`. Matching is on the whole value, never a prefix.

**The false-positive guards**, each from a look-alike found in the live corpus:

- A ticket needs 3 or more digits, which rules out UTF-8, Sev-2 and us-east-1. It must be
  upper case, which rules out `pre-2024`, `vpc-01234567` and branch names. Its prefix must end
  in a letter, which rules out EC2-style names. And the prefix must not be one of SHA, ISO,
  RFC, AES, RSA, HTTP, ADR or CR (so SHA-256, ISO-8601, HTTP-400 and ADR-0017 are not
  tickets), because CR is its own kind.
- A SHA must have a letter and a digit, which rules out `deadbeef` and plain numbers. It must
  not touch a dash or a word character, which rules out UUID parts, host names, resource ids
  and `0x7fffffff`. And it is never exactly 8 characters. In this corpus, 8 hex characters were
  a session id's prefix, a job id, a Taskei id or a request id in 9 of 11 sampled cases, and a
  commit in 2.
- An account is exactly 12 digits between word boundaries, so a 13-digit timestamp or
  deployment id is not one.
- A path must start a word, so `)/close` and `}/types` are not paths. A single segment under
  a source directory is not a path either (`tests/alarms`, `config/state`), and an extension
  needs 2 or more characters (`e.g./i.e.`). A path is also refused when:
  - any segment is an instance type (`i3.xlarge/r5.large`);
  - a directory is named like a file (`spend.js/spend.test.js`);
  - it contains `...`;
  - it stops at a template placeholder (`/api/user/{id}/followers`).
- URLs and ARNs are taken out before paths are looked for. Tickets, CRs, accounts and SHAs are
  looked for in the whole line, because a URL names the ticket it points at, and an ARN names
  its account.

**Measured precision** against a read-only copy of the live index (2026-09-26, 4,814 facts, 864
of them with an entity):

| Kind | Facts | Distinct | Checked | Precision |
| --- | --- | --- | --- | --- |
| ticket | 182 | 87 | every distinct value | 100% |
| cr | 174 | 102 | every distinct value | 100% |
| account | 92 | 37 | every distinct value | 100% |
| arn | 6 | 7 | every distinct value | 100% |
| url | 44 | 48 | every distinct value | 100% |
| sha | 152 | 130 | 60 sampled, and every one outside a commit-like context | 100% |
| path | 304 | 245 | two random samples of 100 | 99% (`~/Library/Application Support` is cut at its space) |

Before the guards, a ticket-shaped pattern took `HTTP-400` and `ADR-0002`, 8-character hex
was 18% commits, and paths ran at 85%.

## Consequences

- Only a rebuild re-reads facts already indexed, so changing any pattern needs a
  `SCHEMA_VERSION` bump. The bump to 2 is what builds the table for an existing index.
- Recall is traded for precision, and these are known misses:
  - lower-case ticket ids in branch names (`live-54151-alarms`);
  - 8-character commit SHAs;
  - upper-case hex;
  - paths with spaces in them;
  - ids of another shape, such as `V1234567890` or `CVE-2024-1234`.

  A SHA is a single FTS5 token, so full text still finds the ones left out.
- `--entity` searches facts only. Prompts are not run through the patterns, so an entity
  search returns no prompt class, rather than every prompt the other filters allow.
- `--json` fact rows carry an `entities` array. It is the same patterns run again on the
  row's text, which costs less than a second query and cannot disagree with the table while
  the version bump above is kept.
