---
name: regression-detector
description: Use when a diff or proposed change needs evidence-based impact analysis and regression-test selection.
---

# Regression Detector

## When not to use

Do not use when no change set can be identified or as a substitute for running the relevant tests.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; if blocked, follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a retrieval plan is needed. Otherwise omit `taskId` from `tokengraph_analyze({ mode: "risk", changedFiles, diffSummary?, task? })` so it can auto-start the ledger and return a taskId; capture the returned taskId.
3. Reuse that exact taskId with the actual change set. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Call `tokengraph_query_context({ taskId, mode: "symbol", target })` for changed exports and dependents, and `tokengraph_query_context({ taskId, mode: "sql", query })` for schema, policy, auth, or migration impact. Search or overview queries may narrow additional targets.
5. Recommend tests from direct coverage, inbound dependents, routes, SQL involvement, and risk evidence. Run and verify tests; distinguish verified results from estimated risk.
6. Only after requested analysis and test verification are complete, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state "TokenGraph was not used," use narrow local diff/search/test inspection, and claim no savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
