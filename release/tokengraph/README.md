# TokenGraph Release Plugin

This folder is the installable TokenGraph 0.22.0 plugin for Codex and Claude Code users.

It includes the self-contained Node.js 22 MCP runtime at `dist/index.js`, bundled parser workers at `dist/typescript-worker.cjs` and `dist/polyglot-worker.js`, the bounded command runner at `dist/cli.js`, the cross-host lifecycle adapter at `dist/hooks.js`, hook and host manifests, MCP configs, skills, package metadata, and license. It requires no dependency installation, TypeScript build, API key, cloud index, or embeddings service.

## Install

Recommended GitHub install for Codex:

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
```

For an extracted release ZIP, add the bundle directory that contains this `tokengraph/` folder, not this plugin folder itself:

```powershell
codex plugin marketplace add C:\path\to\tokengraph-0.22.0
codex plugin add tokengraph@tokengraph
```

Claude Code GitHub install:

```text
/plugin marketplace add Mujadarah/TokenGraph
/plugin install tokengraph@tokengraph
/reload-plugins
```

Claude launches through `${CLAUDE_PLUGIN_ROOT}` and forwards `${CLAUDE_PROJECT_DIR}`. Codex must provide MCP Roots or inherit `TOKENGRAPH_WORKSPACE_ROOT`. Call `tokengraph_setup` before project tools; it diagnoses setup without granting filesystem trust.

## Runtime

The MCP server starts with:

```text
node ./dist/index.js

# bounded saved-run capture
node ./dist/cli.js run -- <command> [args...]
```

The server is local-first. It indexes the selected workspace locally and stores project state under `.tokengraph/` in that workspace.

TokenGraph stores project state under `.tokengraph/` inside the trusted workspace. Token savings are estimates.

The default surface exposes eight compact tools; the opt-in full surface exposes 42. JSON-only successes return one serialized JSON text item, with project-map resource links as the documented exception. Wiki and memory changes use source-linked review-before-apply proposals.

Use `tokengraph_prepare_context` when planning is needed. Direct query, compress, recall, and analyze calls may omit `taskId`; they start a ledger and return the new id. Reuse that id, then end verified work with compact `tokengraph_task_report({ taskId })`. Explicit pause is for unfinished work, and verbose reporting is diagnostic only.

Routing publishes the frozen expectedBenefit enum none | low | medium | high: bypass paths use none, Stage 0 activation uses the recommended medium, Stage 1 indexed activation uses high, and low remains reserved.

The checked-in deterministic fixture benchmark preserves 100% of critical constraints and recall with zero critical false negatives. Its 27 activated tasks have a +174.5-token execution-inclusive median, +40.5-token p25, and 81.5% non-negative rate; three bounded Stage-0 bypasses are not booked as savings. Four edit/debug tasks charge four exact source slices totaling 711 estimated tokens. Every category remains low-confidence, and these fixture estimates are not provider billing counts or autonomous-agent quality proof. JSON remains the default response format because the tabular experiment did not improve both token usage and quality.

Real-host evidence is reported separately from fixture economics. Reviewed schema-v3 campaigns now cover TokenGraph and mattpocock/ts-reset: ten counterbalanced ON/OFF pairs and twenty accepted traces across two repositories and two categories. Promotion and enforcement remain disabled because every frozen gate did not pass. Only eligible reviewed schema-v3 evidence may promote routing. The third repository remains outstanding, so multi-repository B6 validation is incomplete. See the TokenGraph [manifest](https://github.com/Mujadarah/TokenGraph/blob/main/docs/benchmarks/host-evaluations/2026-07-22-tokengraph-codex-manifest.json) and [report](https://github.com/Mujadarah/TokenGraph/blob/main/docs/benchmarks/host-evaluations/2026-07-22-tokengraph-codex-report.md), plus the ts-reset [report](https://github.com/Mujadarah/TokenGraph/blob/main/docs/benchmarks/host-evaluations/2026-07-22-ts-reset-codex-report.md).

The PostToolUse/Stop hook stores only a schema-versioned session hash, task id, trusted root, turn id, and timestamp in the host-provided plugin data directory. It never stores prompts, transcripts, or tool payloads. Normal Stop can request one pause-or-complete report or the exact canonical footer; interrupts and API failures are not completion events. Review and trust the hook definition before enabling it, or disable host hooks and call `tokengraph_task_report` explicitly.

## Maintainers

Do not edit generated files in this release folder by hand. Make source changes in `plugins/tokengraph/`, then run:

```powershell
cd plugins/tokengraph
pnpm build
pnpm package:plugin -- --release
pnpm validate:plugin
```

Version: 0.22.0
