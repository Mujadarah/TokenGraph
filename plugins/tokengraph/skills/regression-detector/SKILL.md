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
2. Call `tokengraph_prepare_context({ root: trusted root, task })` once and capture its taskId.
3. Call `tokengraph_analyze({ taskId, root: trusted root, mode: "risk", changedFiles, diffSummary?, task? })` with the actual change set.
4. Reuse the exact taskId and trusted root with `tokengraph_query_context({ taskId, root: trusted root, mode: "symbol", target })` for changed exports and dependents, and `tokengraph_query_context({ taskId, root: trusted root, mode: "sql", query })` for schema, policy, auth, or migration impact. Search or overview queries use the same exact captured root and may narrow additional targets.
5. Recommend tests from direct coverage, inbound dependents, routes, SQL involvement, and risk evidence. Run and verify tests; distinguish verified results from estimated risk.
6. Call `tokengraph_task_report({ taskId, root: trusted root, disposition: "complete" })` only after requested analysis and test verification are complete. Use `tokengraph_task_report({ taskId, root: trusted root, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use narrow local diff/search/test inspection, and claim no savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. Until Phase 3 hook enforcement exists, call the report explicitly and manually include its returned status in the final report.
