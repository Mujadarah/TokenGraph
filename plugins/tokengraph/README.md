# TokenGraph

TokenGraph is a local-first Codex plugin that reduces wasted context by routing tasks through a compact project map before raw file reads.

## What v0.6 includes

- Codex plugin manifest and repo-local marketplace entry.
- Local stdio MCP server in Node/TypeScript.
- Project indexing for TypeScript, JavaScript, React, Next.js, PostgreSQL, and Supabase-style SQL migrations.
- Local import resolution for relative paths and common `@/` or `~/` aliases.
- Better React and Next.js graph metadata, including `pages/**` routes, component symbols, and symbol line hints.
- Root `.gitignore` support during project scanning.
- Project fingerprints stored with each index.
- Index freshness status for missing, fresh, and stale persisted indexes.
- Reset controls that clear only `index.json` by default or all `.tokengraph/` state when explicitly requested.
- Context planner that returns likely files, tests, SQL objects, ranked memories, first reads with safe line hints, files to avoid, and estimated token savings.
- Relevance scoring that avoids selecting unrelated route files with no task overlap.
- Symbol explanation with inbound and outbound references from the resolved import graph.
- PostgreSQL parser coverage for constraints, enums, extensions, grants, and materialized views.
- Supabase RLS policy detail, including command, roles, `using`, and `with check` clauses.
- Ordered SQL object history across migration files.
- Planner, project map, search, and SQL summary support for v0.5 SQL object kinds.
- Local memory storage in `.tokengraph/memory.json`.
- Log/test/build/diff compression.
- JSON-RPC stdio smoke coverage for the built MCP entry point.
- CLI smoke command for local validation outside Codex.
- Example fixture projects for scanner and planner regression tests.
- Local plugin validation for manifest, MCP config, built output, and skill metadata.

## Local development

```powershell
pnpm install
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
```

The MCP server entry point is `dist/index.js`, built from `src/index.ts`.

`pnpm smoke -- --root <project>` starts the built MCP server over stdio, validates the required TokenGraph tools, and calls the project status, map, planner, and token-savings tools against the selected project root. Run `pnpm build` first.

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

## Troubleshooting

### Missing MCP tools

1. Confirm `tokengraph` is installed and enabled in Codex.
2. Run `pnpm build` from `plugins/tokengraph`.
3. Run `pnpm smoke -- --root . --json`.
4. Restart Codex or open a fresh thread so plugin-provided MCP servers are reloaded.

### Stale indexes

Call `tokengraph_index_status` before trusting cached context. If it reports `stale`, call `tokengraph_index_project`. If the index looks corrupt, call `tokengraph_reset_project` with `mode: "index"`; this preserves memories by default.

### Plugin build failures

Run `pnpm typecheck` to get compiler errors, then `pnpm build`. `pnpm validate:plugin` expects the built `dist/index.js` and `dist/server.js` files to exist and match the current plugin metadata.

### Marketplace visibility

The repo marketplace file is `.agents/plugins/marketplace.json`. Its `source.path` must point to `./plugins/tokengraph` relative to the repository root, not relative to `.agents/plugins`.

## Privacy

TokenGraph v0.6 is local-only. It stores project state under `.tokengraph/` in the indexed workspace and does not require an OpenAI API key or paid external API.

## License

TokenGraph is proprietary source-available software. See the repository root `LICENSE`.
