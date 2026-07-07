# TokenGraph Roadmap

This roadmap tracks the intended direction for TokenGraph. Dates are not commitments; priorities may change based on testing and real Codex usage.

## v0.1 - Local Foundation

Status: complete

- Codex plugin manifest and repo-local marketplace entry.
- Local stdio MCP server in Node.js and TypeScript.
- Project indexing for TypeScript, JavaScript, React, Next.js, PostgreSQL, and Supabase-style migrations.
- Context planner, SQL summary, memory store, log compressor, and token savings estimate.
- Local JSON persistence under `.tokengraph/`.

## v0.2 - Reliability Pass

Status: complete

- Root `.gitignore` support during scanning.
- Planner relevance fix for unrelated route files.
- JSON-RPC stdio smoke test for the built MCP server.
- Local plugin validation script.
- Clearer TokenGraph skill fallback behavior.

## v0.3 - Freshness And Reset

Status: complete

- Deterministic project fingerprints.
- `tokengraph_index_status` for missing, fresh, and stale indexes.
- `tokengraph_reset_project` with index-only reset by default.
- Scanner skip for TokenGraph's own `.tokengraph/` state.
- Validator coverage for new built MCP tools.

## v0.4 - Better Graph Intelligence

Status: complete

- Stronger import resolution for local aliases and relative paths.
- Better React and Next.js route/component extraction.
- More useful `tokengraph_explain_symbol` output with inbound/outbound references.
- Planner scoring that weights symbols, tests, SQL objects, and memories separately.
- More targeted first-read recommendations with line-range hints where safe.

## v0.5 - SQL And Persistence Depth

Status: complete

- Broader PostgreSQL parser coverage for constraints, enums, extensions, grants, and materialized views.
- Better Supabase RLS summaries, including policy command and using/check clauses.
- Migration ordering and object history summaries.
- JSON-backed local store preserved with the current MCP tool contracts.
- Optional SQLite-backed local store deferred for a later persistence enhancement.

## v0.6 - Developer Experience

Status: complete

- CLI smoke command for local validation outside Codex.
- Example fixture projects for scanner and planner regression tests.
- Installation guide for local marketplace setup.
- Troubleshooting guide for missing MCP tools, stale indexes, and plugin build failures.

## v0.7 - Review And Export

Status: complete

- Read-only memory review workflow so Codex can inspect, rank, and question local memories before relying on them.
- Mermaid and JSON project map export for compact visual graph review without raw source content.
- MCP smoke and CLI smoke coverage for the new review/export tools.
- Plugin validation checks for the v0.7 tool surface and built MCP server metadata.

## v0.8 - Token Budget Profiles And Incremental Indexing

Status: complete

- Local config stored in `.tokengraph/config.json`.
- MCP config tools for reading settings, switching profile, and updating explicit settings.
- Conservative, balanced, and aggressive token-saving profiles.
- Profile-aware context planning with first-read limits, estimated context budgets, and raw-read warning thresholds.
- Incremental indexing for compatible persisted indexes, with full reindex fallback for incompatible schema metadata.
- MCP, smoke, and validator coverage for the v0.8 tool surface.

## v0.9 - Local Project Wiki

Status: complete

- Deterministic local wiki builder derived only from persisted index and memory records.
- Markdown wiki pages under `.tokengraph/wiki/` with a manifest tied to the index fingerprint.
- Wiki pages for overview, structure, routes, database, and recorded decisions, omitting empty optional pages.
- Wiki status for missing, fresh, and stale generated pages.
- MCP tools `tokengraph_generate_wiki` and `tokengraph_show_wiki_page`.
- Config-driven auto-refresh on successful indexing when `wikiGenerationEnabled` is true.
- Reset behavior that clears derived wiki state with index resets while preserving memory and config.
- MCP, CLI smoke, validator, and core coverage for the v0.9 wiki surface.

## v0.10 - Release Packaging

Status: complete

- Self-contained bundled MCP entry point so installed Codex plugin caches can start without a cache-local dependency install.
- `pnpm package:plugin` command that builds a distributable plugin folder from source plus compiled `dist/`.
- Release artifact directory ignored by git so public source packaging does not require committed build output.
- Release-local `.agents/plugins/marketplace.json` that points at the packaged plugin folder with a relative `source.path`.
- Packaged plugin includes only install files: metadata, MCP config, compiled server, skills, README, package metadata, and license.
- CLI regression coverage and validator checks for the v0.10 packaging workflow.

## Later

Ideas under consideration:

- Language support beyond TypeScript/JavaScript and PostgreSQL.
