---
name: memory-curator
description: Use when durable project decisions must be recalled, audited, compared with current evidence, or proposed for review.
---

# Memory Curator

## When not to use

Do not use for transient notes, unrelated personal memory, or automatic mutation without explicit review.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; if blocked, follow recovery and do not invent a taskId.
2. Call `tokengraph_prepare_context({ root: trusted root, task })` once and capture its taskId.
3. Reuse the exact taskId and trusted root. Call `tokengraph_recall({ taskId, root: trusted root, mode: "review", query, audit: true })` for conflict, stale-state, or lifecycle review; use recall mode with the same exact captured root for a narrow current lookup.
4. Verify drift-prone claims with current evidence from `tokengraph_query_context` and targeted local checks.
5. When durable knowledge is warranted, call `tokengraph_propose_knowledge({ taskId, root: trusted root, action: "propose", ... })`. List, approve, or reject only as explicitly requested and with the same exact captured root. Approval is review state, not content application: never claim approved content was applied while `applicationStatus` is pending. Pause for approval or application and verify applied content separately.
6. Call `tokengraph_task_report({ taskId, root: trusted root, disposition: "complete" })` only after the requested recall or fully applied and verified curation outcome is complete. Use `tokengraph_task_report({ taskId, root: trusted root, disposition: "pause" })` for approval, application, missing evidence, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use the existing narrow local memory/current-state fallback, and claim no savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
