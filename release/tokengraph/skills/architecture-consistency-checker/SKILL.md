---
name: architecture-consistency-checker
description: Use when import direction, SQL, security, release, or module-boundary changes need consistency checks.
---

# Architecture Consistency Checker

## When not to use

Do not use for changes with no plausible architecture boundary impact or to treat an undocumented convention as binding.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; if blocked, follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a retrieval plan is needed. Otherwise omit `taskId` from the first `tokengraph_analyze({ mode: "architecture", files? })` call so it can auto-start the ledger and return a taskId; capture the returned taskId.
3. Reuse that exact taskId for stored rules and boundary violations. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Call `tokengraph_analyze({ taskId, mode: "risk", changedFiles, diffSummary?, task? })` for import, SQL, security, or release boundary changes. Query symbols or SQL with `tokengraph_query_context` when targeted evidence is needed.
5. Confirm warnings against current source, SQL, tests, and documented rules. Missing rules are proposals, not enforced facts; label inferred intent and never silently enforce it.
6. Only after the requested check and verification are complete, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use narrow local import, SQL, security, and release checks, and claim no savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
