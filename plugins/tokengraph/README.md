# TokenGraph

TokenGraph is a local-first coding-agent plugin that reduces wasted context by routing tasks through a compact project map before raw file reads.

This folder is the maintainer development source plugin. Normal users should install TokenGraph from the repository marketplace, which points to `release/tokengraph/`, not this source folder. The source folder is only directly installable after maintainers run `pnpm build` and create current `dist/` output.

## What v0.18.0 includes

- Codex and Claude Code plugin manifests and release marketplace entries.
- Focused coding-agent skills for graph retrieval, root-cause debugging, architecture consistency, context compression, regression detection, token budgets, memory curation, and release packaging audits.
- Local stdio MCP server in Node/TypeScript.
- Project indexing for TypeScript, JavaScript, React, Next.js, PostgreSQL, and Supabase-style SQL migrations.
- Local import resolution for relative paths and common `@/` or `~/` aliases.
- Better React and Next.js graph metadata, including `pages/**` routes, component symbols, and symbol line hints.
- Root `.gitignore` support during project scanning.
- Project fingerprints stored with each index.
- Index freshness status for missing, fresh, and stale persisted indexes.
- Incremental indexing for compatible persisted indexes.
- `fullReindex` support when a complete rebuild is required.
- Local config stored at `.tokengraph/config.json`.
- Schema-versioned JSON persistence for config, memories, rules, wiki manifests, token events, and benchmark run storage.
- Safe migration of compatible legacy config, memory, and rule files, with corrupt JSON quarantined instead of silently overwritten.
- `JsonTokenGraphStore` abstraction, with SQLite intentionally left optional until proven necessary.
- Benchmark harness through `pnpm benchmark -- --json`, plus benchmark methodology, current results, and fixture docs.
- Trust docs for privacy, security, permissions, local storage, limitations, and release install behavior.
- Host-neutral docs for Codex, Claude Code, generic MCP stdio clients, Cursor, and Windsurf/Cascade.
- Config tools: `tokengraph_get_config`, `tokengraph_set_profile`, and `tokengraph_update_config`.
- Core routing tools: `tokengraph_compress_output`, `tokengraph_explain_symbol`, `tokengraph_plan_context`, `tokengraph_project_map`, `tokengraph_remember_decision`, `tokengraph_search_graph`, `tokengraph_show_token_savings`, and `tokengraph_summarize_sql`.
- Token-saving profiles: `conservative`, `balanced`, and `aggressive`.
- Profile-aware context planning with estimated token budgets and raw-read warning thresholds.
- Local project wiki generation under `.tokengraph/wiki/` with deterministic Markdown pages.
- Wiki pages for `overview`, `structure`, `routes`, `database`, and `decisions`, with empty optional pages omitted.
- Wiki status based on whether the manifest fingerprint matches the persisted index fingerprint.
- Wiki tools: `tokengraph_generate_wiki` and `tokengraph_show_wiki_page`.
- `wikiGenerationEnabled` auto-refresh after successful indexing; explicit wiki generation works regardless of the flag.
- Reset controls that clear `index.json` and derived wiki pages by default or all `.tokengraph/` state when explicitly requested.
- Context planner that returns likely files, tests, SQL objects, ranked memories, first reads with safe line hints, files to avoid, and estimated token savings.
- Relevance scoring that avoids selecting unrelated route files with no task overlap.
- Symbol explanation with inbound and outbound references from the resolved import graph.
- PostgreSQL parser coverage for constraints, enums, extensions, grants, and materialized views.
- Supabase RLS policy detail, including command, roles, `using`, and `with check` clauses.
- Ordered SQL object history across migration files.
- Planner, project map, search, and SQL summary support for v0.5 SQL object kinds.
- Local memory storage in `.tokengraph/memory.json`.
- Read-only memory review through `tokengraph_review_memories`.
- Memory lifecycle metadata for active, deprecated, deleted, confirmed, linked, source-backed, and evidenced memories.
- Memory tools: `tokengraph_update_memory`, `tokengraph_delete_memory`, `tokengraph_deprecate_memory`, `tokengraph_confirm_memory`, `tokengraph_find_memory_conflicts`, `tokengraph_link_memory`, and `tokengraph_recall_memory`.
- Local architecture rules in `.tokengraph/rules.json`.
- Rule tools: `tokengraph_list_rules`, `tokengraph_add_rule`, `tokengraph_update_rule`, and `tokengraph_delete_rule`.
- Architecture checks through `tokengraph_check_architecture` for imports, dependency direction, missing tests, SQL security warnings, and marketplace target sanity.
- Root cause failure tracing through `tokengraph_trace_failure`, with compressed output, exact failing test names, stack paths, related imports, SQL, memories, hypotheses, first reads, commands, confidence, and token estimates.
- Regression risk assessment through `tokengraph_assess_change_risk`, with affected files, routes, tests, SQL, architecture rules, memories, targeted test commands, manual review warnings, and token estimates.
- Quality-first context compression through `tokengraph_compress_context`, preserving exact errors, test names, stack paths and line numbers, security warnings, migration identifiers, affected file paths, public API names, and user constraints.
- Mermaid and JSON project map export through `tokengraph_export_project_map`, including resource-link metadata and Markdown fallbacks.
- Log/test/build/diff and mixed-context compression.
- JSON-RPC stdio smoke coverage for the built MCP entry point.
- Self-contained bundled MCP entry point so installed plugin caches do not need `node_modules`.
- CLI smoke command for local validation outside a host.
- Example fixture projects for scanner and planner regression tests.
- Local plugin validation for manifest, MCP config, built output, and skill metadata.
- Release packaging with `pnpm package:plugin`, producing ignored installable artifacts, and `pnpm package:plugin -- --release`, updating the committed one-click install plugin under `release/tokengraph/`.

## Local development

```powershell
pnpm install
pnpm build
pnpm test
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin
pnpm package:plugin -- --release
```

The MCP server entry point is `dist/index.js`, built from `src/index.ts`. `pnpm build` first type-checks and emits the module tree, then bundles the MCP entry point so an installed plugin cache can launch without running `pnpm install` in the cache.

When a host launches the server from the installed plugin directory, TokenGraph requires a trusted project root. Claude Code supplies `CLAUDE_PROJECT_DIR`; Codex clients that do not provide MCP Roots must forward `TOKENGRAPH_WORKSPACE_ROOT` in their MCP configuration. A tool `root` is accepted only when it resolves inside that trusted workspace, and filesystem or home-directory roots are refused.

`pnpm smoke -- --root <project>` starts the built MCP server over stdio, validates the required TokenGraph tools, and calls the project status, map, planner, token-savings, memory review, export, and wiki tools against the selected project root. Run `pnpm build` first.

`pnpm package:plugin` creates an ignored release artifact under the repository `artifacts/` directory. The artifact includes only installable plugin files: `.codex-plugin/`, `.claude-plugin/`, `.mcp.json`, `.mcp.claude.json`, the bundled `dist/index.js`, `skills/`, `README.md`, `package.json`, and the repository license.

`pnpm package:plugin -- --release` updates `release/tokengraph/`, the committed one-click install target used by the root marketplace.

## Local project wiki

The wiki is derived only from the persisted `ProjectIndex` plus memory records. Page bodies do not embed raw source or memory bodies. They include indexed paths, file kinds, route strings, exported symbol names, SQL object names/details already captured in the SQL graph, and memory titles/types/tags.

Generated files:

- `.tokengraph/wiki/manifest.json`
- `.tokengraph/wiki/overview.md`
- `.tokengraph/wiki/structure.md`
- `.tokengraph/wiki/routes.md` when routes exist
- `.tokengraph/wiki/database.md` when SQL objects exist
- `.tokengraph/wiki/decisions.md` when memories exist

The manifest records the index fingerprint used to build the wiki. `tokengraph_show_wiki_page` returns `wikiStatus`; it is `fresh` only when the manifest fingerprint matches the persisted index fingerprint, `stale` when they differ or the index is missing, and `missing` when no valid wiki exists.

## Host install notes

This repository contains a local marketplace file at:

```text
.agents/plugins/marketplace.json
```

For normal Codex install, add the repository marketplace root if needed:

```powershell
codex plugin marketplace add C:\path\to\TokenGraph
```

Then install `tokengraph` from that marketplace and start a new Codex thread so the skill and MCP tools are loaded. The root marketplace points to `release/tokengraph/`, which includes only the bundled runtime.

For Claude Code, add this repository as a marketplace and install `tokengraph` from `.claude-plugin/marketplace.json`. Claude launches the bundled server through `${CLAUDE_PLUGIN_ROOT}` and forwards `${CLAUDE_PROJECT_DIR}` as the trusted workspace root.

After changing source plugin code, run `pnpm build`, run the smoke command, update the release folder with `pnpm package:plugin -- --release`, and restart Codex or open a fresh thread.

For release artifact testing, run `pnpm build` and then `pnpm package:plugin`. Add the generated `artifacts/` directory as a marketplace root if you want to test the packaged plugin folder instead of the source checkout.

## Troubleshooting

### Missing MCP tools

1. Confirm `tokengraph` is installed and enabled in your coding-agent host.
2. Confirm the root marketplace points to `./release/tokengraph`.
3. Confirm `release/tokengraph/dist/index.js` exists and `release/tokengraph/dist/server.js` is absent.
4. If testing source changes, run `pnpm build` from `plugins/tokengraph`, then `pnpm smoke -- --root . --json`, then `pnpm package:plugin -- --release`.
5. Restart Codex or open a fresh thread so plugin-provided MCP servers are reloaded.

### Stale indexes

Call `tokengraph_index_status` before trusting cached context. If it reports `stale`, call `tokengraph_index_project`; compatible indexes update incrementally. Pass `fullReindex: true` only when you need a complete rebuild. For wiki pages, call `tokengraph_show_wiki_page` and check `wikiStatus`; regenerate with `tokengraph_generate_wiki` when the wiki is missing or stale. If the index looks corrupt, call `tokengraph_reset_project` with `mode: "index"`; this preserves memories and config by default while clearing derived wiki pages.

### Plugin build failures

Run `pnpm typecheck` to get compiler errors, then `pnpm build`. `pnpm validate:plugin` expects the built `dist/index.js` bundle and current plugin metadata to exist.

### Release package failures

Run `pnpm build` before `pnpm package:plugin`. The package command fails if `dist/index.js` is missing, because the generated plugin folder is meant to be installable without a TypeScript build step.

### Marketplace visibility

The repo marketplace file is `.agents/plugins/marketplace.json`. Its normal user `source.path` must point to `./release/tokengraph` relative to the repository root, not relative to `.agents/plugins`. Maintainers can test source builds separately, but normal docs should not direct users to install from `./plugins/tokengraph`.

## Privacy

TokenGraph v0.18.0 is local-only. It stores project state under `.tokengraph/` in the indexed workspace and does not require an OpenAI API key, cloud sync, embeddings service, or paid external API. Token counts and savings are estimates, not exact measurements.

## License

TokenGraph is proprietary source-available software. See the repository root `LICENSE`.
