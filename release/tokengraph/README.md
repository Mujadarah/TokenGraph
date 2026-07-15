# TokenGraph Release Plugin

This folder is the installable TokenGraph 0.20.0 plugin for Codex and Claude Code users.

It includes the self-contained Node.js 22 MCP runtime at `dist/index.js`, the cross-host lifecycle adapter at `dist/hooks.js`, hook and host manifests, MCP configs, skills, package metadata, and license. It requires no dependency installation, TypeScript build, API key, cloud index, or embeddings service.

## Install

Recommended GitHub install for Codex:

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
```

For an extracted release ZIP, add the bundle directory that contains this `tokengraph/` folder, not this plugin folder itself:

```powershell
codex plugin marketplace add C:\path\to\tokengraph-0.20.0
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
```

The server is local-first. It indexes the selected workspace locally and stores project state under `.tokengraph/` in that workspace.

TokenGraph stores project state under `.tokengraph/` inside the trusted workspace. Token savings are estimates.

The default surface exposes eight compact tools; the opt-in full surface exposes 42. JSON-only successes return one serialized JSON text item, with project-map resource links as the documented exception. Wiki and memory changes use source-linked review-before-apply proposals.

Use `tokengraph_prepare_context` when planning is needed. Direct query, compress, recall, and analyze calls may omit `taskId`; they start a ledger and return the new id. Reuse that id, then end verified work with compact `tokengraph_task_report({ taskId })`. Explicit pause is for unfinished work, and verbose reporting is diagnostic only.

The checked-in routing-lifecycle benchmark passes its strict gate with median net estimated savings of 20.0 tokens, p25 -290.0, 100% constraint preservation and recall, and zero critical false negatives. Fifteen of 30 tasks are non-positive. The execution-inclusive median is -86.0 tokens with 18 of 30 tasks non-positive. Every category remains low-confidence, and these fixture estimates are not provider billing counts.

The PostToolUse/Stop hook stores only a schema-versioned session hash, task id, trusted root, turn id, and timestamp in the host-provided plugin data directory. It never stores prompts, transcripts, or tool payloads. Normal Stop can request one pause-or-complete report or the exact canonical footer; interrupts and API failures are not completion events. Review and trust the hook definition before enabling it, or disable host hooks and call `tokengraph_task_report` explicitly.

## Maintainers

Do not edit generated files in this release folder by hand. Make source changes in `plugins/tokengraph/`, then run:

```powershell
cd plugins/tokengraph
pnpm build
pnpm package:plugin -- --release
pnpm validate:plugin
```

Version: 0.20.0
