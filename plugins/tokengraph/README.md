# TokenGraph Source Plugin

This directory contains the TypeScript implementation, tests, validation, and packaging source for TokenGraph v0.19.0. Normal users install from the GitHub marketplace or release ZIP documented in the repository root README; they do not install this directory directly.

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

`pnpm build` produces a self-contained Node.js 22 MCP entry at `dist/index.js`. `pnpm package:plugin` creates a standalone Codex/Claude marketplace directory and deterministic ZIP under the repository `artifacts/` directory. `pnpm package:plugin -- --release` regenerates the committed `release/tokengraph/` plugin.

## Workspace trust

TokenGraph project tools accept paths only inside a host-provided trusted workspace. Trust is resolved in this order:

1. `CLAUDE_PROJECT_DIR` from Claude Code.
2. `TOKENGRAPH_WORKSPACE_ROOT`, normally set before starting Codex.
3. A file root returned through MCP Roots.
4. The process working directory only when the server is not running from an installed plugin directory.

`tokengraph_setup_status` is rootless and read-only. It reports whether setup is ready, the trust source, and exact recovery steps. It never accepts or grants a workspace. Filesystem roots, home directories, unreadable roots, and requested paths outside the trusted workspace remain blocked.

## MCP tools

Setup and indexing:

- `tokengraph_setup_status`
- `tokengraph_index_project`
- `tokengraph_index_status`
- `tokengraph_reset_project`
- `tokengraph_get_config`
- `tokengraph_set_profile`
- `tokengraph_update_config`

Retrieval, wiki, and SQL:

- `tokengraph_project_map`
- `tokengraph_generate_wiki`
- `tokengraph_show_wiki_page`
- `tokengraph_plan_context`
- `tokengraph_search_graph`
- `tokengraph_explain_symbol`
- `tokengraph_summarize_sql`

Compression and savings:

- `tokengraph_compress_output`
- `tokengraph_compress_context`
- `tokengraph_show_token_savings`

Memory lifecycle:

- `tokengraph_remember_decision`
- `tokengraph_review_memories`
- `tokengraph_update_memory`
- `tokengraph_delete_memory`
- `tokengraph_deprecate_memory`
- `tokengraph_confirm_memory`
- `tokengraph_find_memory_conflicts`
- `tokengraph_link_memory`
- `tokengraph_recall_memory`

Architecture and review:

- `tokengraph_list_rules`
- `tokengraph_add_rule`
- `tokengraph_update_rule`
- `tokengraph_delete_rule`
- `tokengraph_check_architecture`
- `tokengraph_trace_failure`
- `tokengraph_assess_change_risk`
- `tokengraph_export_project_map`

## Packaging contract

The installable plugin contains host manifests, MCP configuration, the bundled `dist/index.js`, skills, README, package metadata, and license. It excludes source, tests, scripts, development dependencies, local state, `dist/server.js`, and `dist/core/`.

Do not edit `release/tokengraph/` by hand. Change source or the package generator, then regenerate it.

## Privacy and license

TokenGraph is local-first and does not require an OpenAI API key, cloud sync, embeddings service, telemetry, or paid external API. Token savings are estimates. See the repository `LICENSE`.
