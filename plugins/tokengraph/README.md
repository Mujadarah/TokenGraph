# TokenGraph Source Plugin

This directory contains the TypeScript implementation, tests, validation, and packaging source for TokenGraph v0.20.0. Normal users install from the GitHub marketplace or release ZIP documented in the repository root README; they do not install this directory directly.

## Development

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin -- --json
pnpm package:plugin -- --release --json
```

`pnpm build` produces self-contained Node.js 22 entries at `dist/index.js` for MCP, `dist/cli.js` for bounded saved-run capture, and `dist/hooks.js` for lifecycle hooks. Run `node ./dist/cli.js run -- <command> [args...]` to capture a redacted, bounded command result. `pnpm package:plugin` creates a standalone Codex/Claude marketplace directory and deterministic ZIP under the repository `artifacts/` directory. `pnpm package:plugin -- --release` regenerates the committed `release/tokengraph/` plugin.

## Workspace trust

TokenGraph project tools accept paths only inside a host-provided trusted workspace. Trust is resolved in this order:

1. `CLAUDE_PROJECT_DIR` from Claude Code.
2. `TOKENGRAPH_WORKSPACE_ROOT`, normally set before starting Codex.
3. A file root returned through MCP Roots.
4. The process working directory only when the server is not running from an installed plugin directory.

`tokengraph_setup` is rootless and read-only. It reports whether setup is ready, the trust source, the selected tool surface, and exact recovery steps. It never accepts or grants a workspace. Filesystem roots, home directories, unreadable roots, and requested paths outside the trusted workspace remain blocked.

## MCP tools

The default `TOKENGRAPH_TOOL_SURFACE=core` surface exposes exactly eight intent-level, task-scoped tools:

- `tokengraph_setup`
- `tokengraph_prepare_context`
- `tokengraph_query_context`
- `tokengraph_compress`
- `tokengraph_recall`
- `tokengraph_analyze`
- `tokengraph_propose_knowledge`
- `tokengraph_task_report`

Set `TOKENGRAPH_TOOL_SURFACE=full` before starting the MCP host to add the 34 deprecated compatibility tools below. Their names, schemas, and behavior remain available during migration; prefer the core tools for new tasks.

JSON-only successful tool calls return one serialized JSON `TextContent` item. `tokengraph_export_project_map` is the resource-link exception and also returns matching structured content. Compact mode is the default; explicit `responseMode: "verbose"` is for diagnostics.

Use `tokengraph_prepare_context` only when planning is needed. The direct query, compress, recall, and analyze tools accept an omitted `taskId`, atomically start a task ledger, and return the new id. Reuse that id for later calls. After ready setup, `root` may be omitted when host workspace resolution is stable. `tokengraph_task_report({ taskId })` defaults to complete and returns the compact `status`, `taskId`, canonical `footer`, and `reportingStatus`; request verbose mode only for report diagnostics or explicitly pause unfinished work.

### Reviewed local knowledge

`tokengraph_propose_knowledge` records privacy-safe local proposals with normalized source ids and fingerprints, intended wiki/memory/skill targets, rationale, conflict notes, and expiry. Proposing and listing never mutate derived knowledge. Path sources are marked pending until explicit approval canonically resolves the workspace-relative file and rehashes LF-normalized content while holding the persistence lock. Stable logical ids remain expiring `attested-unverifiable` snapshots; bare legacy fingerprints are `legacy-unverifiable`. Neither form is silently upgraded to current or high-confidence, and ID-only/legacy-only proposals cannot be approved without a canonical path source. Applied results distinguish `revalidated-current` from `revalidated-with-attested-snapshots`. Approval applies only the reviewed payload once under `.tokengraph/knowledge/`; stale or expired approval fails clearly, and rejection applies nothing.

To keep `tools/list` discovery compact, the knowledge tool publishes one flat schema. Runtime validation enforces action-specific fields: `propose` requires `type`, `title`, `rationale`, `proposedContent`, `sourceFingerprints`, and `affectedIdentifiers`; `approve` and `reject` require `id`. Invalid combinations fail before mutation. This separates compact discovery from strict runtime validation rather than weakening the action contract.

Generated wiki Markdown uses deterministic Obsidian-compatible YAML frontmatter and relative wiki links. It includes backlinks, reviewed conflict markers, and fresh/stale source status. Refresh rewrites only changed page files. All review, application, and wiki state stays workspace-confined and local; no cloud service or embeddings are used. The committed v0.20 release is generated from these source contracts; do not edit it by hand.

Legacy setup and indexing:

- `tokengraph_setup_status`
- `tokengraph_index_project`
- `tokengraph_index_status`
- `tokengraph_reset_project`
- `tokengraph_get_config`
- `tokengraph_set_profile`
- `tokengraph_update_config`

Legacy retrieval, wiki, and SQL:

- `tokengraph_project_map`
- `tokengraph_generate_wiki`
- `tokengraph_show_wiki_page`
- `tokengraph_plan_context`
- `tokengraph_search_graph`
- `tokengraph_explain_symbol`
- `tokengraph_summarize_sql`

Legacy compression and savings:

- `tokengraph_compress_output`
- `tokengraph_compress_context`
- `tokengraph_show_token_savings`

Legacy memory lifecycle:

- `tokengraph_remember_decision`
- `tokengraph_review_memories`
- `tokengraph_update_memory`
- `tokengraph_delete_memory`
- `tokengraph_deprecate_memory`
- `tokengraph_confirm_memory`
- `tokengraph_find_memory_conflicts`
- `tokengraph_link_memory`
- `tokengraph_recall_memory`

Legacy architecture and review:

- `tokengraph_list_rules`
- `tokengraph_add_rule`
- `tokengraph_update_rule`
- `tokengraph_delete_rule`
- `tokengraph_check_architecture`
- `tokengraph_trace_failure`
- `tokengraph_assess_change_risk`
- `tokengraph_export_project_map`

## Packaging contract

The installable plugin contains host manifests, MCP configuration, `hooks/hooks.json`, the bundled `dist/index.js`, `dist/cli.js`, and `dist/hooks.js` entries, skills, README, package metadata, and license. It excludes source, tests, scripts, development dependencies, local state, `dist/server.js`, and `dist/core/`.

## Lifecycle hooks

The default `hooks/hooks.json` is auto-discovered by Codex and Claude Code. PostToolUse associates task-aware core tools with a host session, while Stop asks for exactly one pause-or-complete `tokengraph_task_report` call or the exact stored canonical footer. A repeated Stop continuation never blocks again. Paused tasks, unrelated tools, interrupts, and API failures do not produce completion claims.

Pause is terminal for that task id. Stop remains allowed for a paused task, but later task-aware calls are rejected. Start a new task through `tokengraph_prepare_context` or a direct intent call that omits `taskId`.

The adapter reads documented hook fields and strictly parses only the single JSON `TextContent` result needed to capture a returned task id. It resolves the trusted root from an explicit absolute tool root, an existing pointer, or the host-provided working/project root. It stores a minimal 30-day session pointer in the host-provided plugin data directory: schema/version, a SHA-256 session hash, task id, trusted root, turn id, and timestamp. It does not store prompts, transcripts, tool inputs, tool responses, or raw response text. Missing or corrupt state fails open with an honest warning and never fabricates savings.

Codex users must review and trust plugin hooks before they run. Hooks can be disabled globally with `[features] hooks = false`; Claude Code users can inspect them with `/hooks` and disable all hooks with `"disableAllHooks": true`. When hooks are off or unavailable, call `tokengraph_task_report` explicitly.

Do not edit `release/tokengraph/` by hand. Change source or the package generator, then regenerate it.

## Privacy and license

TokenGraph is local-first and does not require an OpenAI API key, cloud sync, embeddings service, telemetry, or paid external API. Token savings are estimates. See the repository `LICENSE`.
