---
name: architecture-consistency-checker
description: Use when import direction, SQL, security, release, or module-boundary changes need consistency checks.
---

# Architecture Consistency Checker

## When not to use

Do not use for changes with no plausible architecture boundary impact or to treat an undocumented convention as binding.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})`; if blocked, follow recovery and do not invent a taskId.
2. Call `tokengraph_prepare_context({ root?, task })` once and capture its taskId and trusted root.
3. Call `tokengraph_analyze({ taskId, root?, mode: "architecture", files? })` for applicable stored rules and boundary violations.
4. Also call `tokengraph_analyze({ taskId, root?, mode: "risk", changedFiles, diffSummary?, task? })` for import, SQL, security, or release boundary changes. Reuse the exact taskId and trusted root; query symbols or SQL with `tokengraph_query_context` when targeted evidence is needed.
5. Confirm warnings against current source, SQL, tests, and documented rules. Missing rules are proposals, not enforced facts; label inferred intent and never silently enforce it.
6. Call `tokengraph_task_report({ taskId, root?, disposition: "complete" })` only after the requested check and verification are complete. Use `tokengraph_task_report({ taskId, root?, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use narrow local import, SQL, security, and release checks, and claim no savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. Until Phase 3 hook enforcement exists, call the report explicitly and manually include its returned status in the final report.
