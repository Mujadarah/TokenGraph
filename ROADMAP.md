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

## Later

Ideas under consideration:

- Incremental indexing.
- Language support beyond TypeScript/JavaScript and PostgreSQL.
- Public release packaging that does not require committing build output.
