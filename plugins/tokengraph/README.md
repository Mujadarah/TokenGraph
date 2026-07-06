# TokenGraph

TokenGraph is a local-first Codex plugin that reduces wasted context by routing tasks through a compact project map before raw file reads.

## What v0.5 includes

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
- Local plugin validation for manifest, MCP config, built output, and skill metadata.

## Local development

```powershell
pnpm install
pnpm test
pnpm build
pnpm validate:plugin
```

The MCP server entry point is `dist/index.js`, built from `src/index.ts`.

## Codex install notes

This repository contains a local marketplace file at:

```text
.agents/plugins/marketplace.json
```

After building the plugin, add this marketplace root to Codex if needed:

```powershell
codex plugin marketplace add C:\Users\rabia\Desktop\TokenGraph
```

Then install `tokengraph` from that marketplace and start a new Codex thread so the skill and MCP tools are loaded.

## Privacy

TokenGraph v0.5 is local-only. It stores project state under `.tokengraph/` in the indexed workspace and does not require an OpenAI API key or paid external API.

## License

TokenGraph is proprietary source-available software. See the repository root `LICENSE`.
