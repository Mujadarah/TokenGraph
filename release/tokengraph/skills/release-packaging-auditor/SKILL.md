---
name: release-packaging-auditor
description: Use when plugin manifests, packaging scripts, generated release files, installability, or host readiness change.
---

# Release Packaging Auditor

## When not to use

Do not use for source-only changes that cannot affect packaging, installation, validation, or host behavior.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; if blocked, follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a release retrieval plan is needed; capture the returned taskId. Otherwise omit `taskId` from the first direct intent call so it can auto-start the ledger and return a taskId; capture the returned taskId. Use `tokengraph_query_context` to locate manifests, scripts, validators, source/release boundaries, and install docs.
3. Call `tokengraph_analyze({ taskId, mode: "risk", changedFiles, diffSummary?, task? })`. Reuse the exact taskId. Compress oversized gate failures with `tokengraph_compress({ taskId, mode: "output", kind, text })`. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Run exact source gates: `pnpm typecheck`, full tests (`pnpm test`), `pnpm build`, core smoke, full smoke, and `pnpm validate:plugin`. Run the package command required by the repository.
5. Preserve generated-release discipline: edit source only, regenerate the release through `pnpm package:plugin -- --release`, and inspect the diff. Verify direct release startup/smoke, then install and verify an independently extracted ZIP. Confirm actual host registration, exposed surface, trusted workspace behavior, and readiness rather than relying on file presence.
6. Only when every requested source, generated release, direct release, extracted ZIP, and host verification result is present and passing, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for approval, missing evidence, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use targeted local packaging checks, and claim no savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
