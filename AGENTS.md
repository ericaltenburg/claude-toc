<!-- GSD:project-start source:PROJECT.md -->
## Project

**claude-toc**

A topic-scoped memory system for Claude Code that replaces lossy context summarization with structured, topic-aware memory. It passively captures conversations via hooks, extracts durable facts and decisions into topic files, and dynamically injects relevant context back into sessions — all without user intervention.

**Core Value:** Conversations with Claude should build persistent, structured knowledge that improves future sessions automatically — no manual memory management required.

### Constraints

- **Hook timeout**: Hooks must complete in <5 seconds — no heavy computation in the hot path
- **Token budget**: Injected context must stay under ~500 tokens to avoid bloating prompts
- **Zero friction**: User must never need to run commands or change workflow — everything is automatic
- **No dependencies**: Hooks use Node.js stdlib only (CommonJS, no npm packages)
- **Bedrock auth**: Analysis calls require ada credentials via claudecode profile
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
