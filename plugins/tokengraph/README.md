# TokenGraph

TokenGraph is a local-first Codex plugin that reduces wasted context by routing tasks through a compact project map before raw file reads.

## What v0.10 includes

- Codex plugin manifest and repo-local marketplace entry.
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
- Config tools: `tokengraph_get_config`, `tokengraph_set_profile`, and `tokengraph_update_config`.
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
- Mermaid and JSON project map export through `tokengraph_export_project_map`.
- Log/test/build/diff compression.
- JSON-RPC stdio smoke coverage for the built MCP entry point.
- CLI smoke command for local validation outside Codex.
- Example fixture projects for scanner and planner regression tests.
- Local plugin validation for manifest, MCP config, built output, and skill metadata.
- Release packaging with `pnpm package:plugin`, producing an installable plugin folder and release-local marketplace file without committing `dist/`.

## Local development

```powershell
pnpm install
pnpm build
pnpm test
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin
```

The MCP server entry point is `dist/index.js`, built from `src/index.ts`.

`pnpm smoke -- --root <project>` starts the built MCP server over stdio, validates the required TokenGraph tools, and calls the project status, map, planner, token-savings, memory review, export, and wiki tools against the selected project root. Run `pnpm build` first.

`pnpm package:plugin` creates an ignored release artifact under the repository `artifacts/` directory. The artifact includes only installable plugin files: `.codex-plugin/`, `.mcp.json`, `dist/`, `skills/`, `README.md`, `package.json`, and the repository license. It also writes a release-local `.agents/plugins/marketplace.json` that points at the packaged plugin folder.

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

## Codex install notes

This repository contains a local marketplace file at:

```text
.agents/plugins/marketplace.json
```

After building the plugin, add this marketplace root to Codex if needed:

```powershell
codex plugin marketplace add C:\Users\rabia\Desktop\TokenGraph
```

Then install `tokengraph` from that marketplace and start a new Codex thread so the skill and MCP tools are loaded. After changing plugin code, run `pnpm build`, run the smoke command, and restart Codex or open a fresh thread.

For release artifact testing, run `pnpm build` and then `pnpm package:plugin`. Add the generated `artifacts/` directory as a marketplace root if you want to test the packaged plugin folder instead of the source checkout.

## Troubleshooting

### Missing MCP tools

1. Confirm `tokengraph` is installed and enabled in Codex.
2. Run `pnpm build` from `plugins/tokengraph`.
3. Run `pnpm smoke -- --root . --json`.
4. Restart Codex or open a fresh thread so plugin-provided MCP servers are reloaded.

### Stale indexes

Call `tokengraph_index_status` before trusting cached context. If it reports `stale`, call `tokengraph_index_project`; compatible indexes update incrementally. Pass `fullReindex: true` only when you need a complete rebuild. For wiki pages, call `tokengraph_show_wiki_page` and check `wikiStatus`; regenerate with `tokengraph_generate_wiki` when the wiki is missing or stale. If the index looks corrupt, call `tokengraph_reset_project` with `mode: "index"`; this preserves memories and config by default while clearing derived wiki pages.

### Plugin build failures

Run `pnpm typecheck` to get compiler errors, then `pnpm build`. `pnpm validate:plugin` expects the built `dist/index.js` and `dist/server.js` files to exist and match the current plugin metadata.

### Release package failures

Run `pnpm build` before `pnpm package:plugin`. The package command fails if `dist/index.js` or `dist/server.js` is missing, because the generated plugin folder is meant to be installable without a TypeScript build step.

### Marketplace visibility

The repo marketplace file is `.agents/plugins/marketplace.json`. Its `source.path` must point to `./plugins/tokengraph` relative to the repository root, not relative to `.agents/plugins`.

## Privacy

TokenGraph v0.10 is local-only. It stores project state under `.tokengraph/` in the indexed workspace and does not require an OpenAI API key or paid external API. Token counts and savings are estimates, not exact measurements.

## License

TokenGraph is proprietary source-available software. See the repository root `LICENSE`.
