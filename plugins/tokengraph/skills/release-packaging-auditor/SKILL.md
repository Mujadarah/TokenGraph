---
name: release-packaging-auditor
description: Use when plugin manifests, packaging scripts, generated release files, installability, or host readiness change.
---

# Release Packaging Auditor

## When not to use

Do not use for source-only changes that cannot affect packaging, installation, validation, or host behavior.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})`; if blocked, follow recovery and do not invent a taskId.
2. Call `tokengraph_prepare_context({ root?, task })` once and capture its taskId and trusted root. Use `tokengraph_query_context` to locate manifests, scripts, validators, source/release boundaries, and install docs.
3. Call `tokengraph_analyze({ taskId, root?, mode: "risk", changedFiles, diffSummary?, task? })`. Reuse the exact taskId and trusted root. Compress oversized gate failures with `tokengraph_compress({ taskId, root?, mode: "output", kind, text })`.
4. Run exact source gates: `pnpm typecheck`, full tests (`pnpm test`), `pnpm build`, core smoke, full smoke, and `pnpm validate:plugin`. Run the package command required by the repository.
5. Preserve generated-release discipline: edit source only, regenerate the release through `pnpm package:plugin -- --release`, and inspect the diff. Verify direct release startup/smoke, then install and verify an independently extracted ZIP. Confirm actual host registration, exposed surface, trusted workspace behavior, and readiness rather than relying on file presence.
6. Call `tokengraph_task_report({ taskId, root?, disposition: "complete" })` only when every requested source, generated release, direct release, extracted ZIP, and host verification result is present and passing. Use `tokengraph_task_report({ taskId, root?, disposition: "pause" })` for approval, missing evidence, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use targeted local packaging checks, and claim no savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. Until Phase 3 hook enforcement exists, call the report explicitly and manually include its returned status in the final report.
