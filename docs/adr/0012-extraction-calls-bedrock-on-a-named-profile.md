# ADR 0012: Extraction calls Bedrock directly, on a named profile, and logs what it spent

**Status:** accepted (2026-08-31)

## Context

Extraction used to shell out to `claude -p` with `AWS_PROFILE` and
`CLAUDE_CODE_USE_BEDROCK` set in the child's environment, on the assumption that this
billed a personal Bedrock account. That assumption could not be verified and the
evidence pointed the other way: 18.1M Opus input tokens went through extraction in
August, while that account's Bedrock bill for the whole month was $0.67. The internal
Claude Code build resolves AWS credentials through its own `awsCredentialExport`
setting, which overrides the environment, so the two variables were decoration.

The deeper problem is that "which account pays for this" was not observable at all.
The project already had one four-month invisible failure; a spend path nobody can
confirm is the same class of defect.

## Decision

**Extraction invokes Bedrock directly** — `aws bedrock-runtime invoke-model` with an
explicit `--profile` and `--region` from config — instead of driving a Claude Code
session. Billing is then a property of the call rather than an inference about a tool's
auth precedence, and it shows up in that account's Cost Explorer and CloudWatch, per
model.

**Every call is recorded in a spend log** next to the corpus: timestamp, local date,
session, model, input and output tokens, stop reason. One line per call, appended after
the call returns, so a failed call records nothing. `bin/toc-spend` reports it by day,
by model, and by session.

**Estimated cost is separate from measured tokens.** Tokens come from Bedrock's own
usage block and are exact. Dollars are tokens multiplied by a rate table of list prices
that ships in code and can be overridden by `model-rates.json` in the corpus. Rates
change and are not something this project can observe, so the report says which it is.

**A model call no longer creates a Claude Code session.** That removes the first three
of the four layers that kept the extractor from ingesting itself (ADR 0011) for
everything extracted from now on: there is no session id to register, no working
directory to exclude, and no hook to guard against, because extraction is an HTTP call
and not a conversation. The historical content check stays, and the registry of already
recorded session ids is still honoured, because the transcripts those layers protected
against are still on disk.

## Consequences

- Extraction depends on the `aws` CLI and on credentials for the configured profile
  being obtainable without a terminal. A credential failure surfaces as a failed
  extraction, retried and then quarantined like any other (ADR 0007).
- Prompt caching is gone rather than merely disabled. Each chunk is a fresh request, so
  input tokens are paid in full — which is what the measurements above already assumed.
- `max_tokens` is now ours to set: 8192, which comfortably exceeds the largest fact set
  a chunk has produced (4.4K output tokens measured).
- The spend log is append-only and never read by extraction, so it cannot affect what
  gets extracted. Deleting it loses history but breaks nothing.
