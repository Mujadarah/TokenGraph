---
name: release-packaging-auditor
description: Use when plugin manifests, packaging scripts, generated release files, installability, or host readiness change.
---

# Release Packaging Auditor

## When not to use

Do not use for source-only changes that cannot affect packaging, installation, validation, or host behavior.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_prepare_context` or `tokengraph_query_context` to locate manifests and boundaries, then `tokengraph_analyze` with `mode: "risk"` and `tokengraph_compress` for oversized gate output.

## Evidence required

Run exact gates: `pnpm typecheck`, full tests, build, core smoke, full smoke, validation, and packaging. Inspect generated release, direct release startup, extracted ZIP, and host readiness.

## Failure boundaries

Edit source only; never hand-edit generated release files. Stop when source and release differ, an extracted ZIP is not independently verified, a host check is unavailable, or a path leaves the trusted workspace.

## Completion criteria

Return source-gate, generated-release, direct-release, extracted-ZIP, and host evidence separately. File presence alone is not installability or readiness.
