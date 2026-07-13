---
name: memory-curator
description: Use when durable project decisions must be recalled, audited, compared with current evidence, or proposed for review.
---

# Memory Curator

## When not to use

Do not use for a tiny current lookup with bounded raw context, transient notes, unrelated personal memory, or automatic mutation without explicit review. Use it when recall can avoid broader reads or preserve durable constraints.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; if blocked, follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a retrieval plan is needed. Otherwise omit `taskId` from the first `tokengraph_recall({ mode: "review", query, audit: true })` call so it can auto-start the ledger and return a taskId; capture the returned taskId.
3. Reuse that exact taskId for narrow recall or review. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Verify drift-prone claims with current evidence from `tokengraph_query_context` and targeted local checks.
5. When durable knowledge is warranted, call `tokengraph_propose_knowledge({ taskId, action: "propose", ... })` with privacy-safe source ids/fingerprints, affected targets, conflict notes, and expiry when known. A path source is canonically rehashed on approval. A stable logical id remains an expiring `attested-unverifiable` snapshot, and a bare fingerprint remains `legacy-unverifiable`; neither becomes current or high-confidence. ID-only or legacy-only proposals cannot be approved without a canonical path source. List, approve, or reject only as explicitly requested. Apply the reviewed payload exactly once only when `applicationStatus` is `applied`; stale or expired proposals cannot apply. Rejection applies nothing.
6. Only after the requested recall or fully applied and verified curation outcome is complete, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for approval, application, missing evidence, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state "TokenGraph was not used," use the existing narrow memory/current-state fallback, and claim no savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
