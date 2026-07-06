# TokenGraph v0.1 Design

## Goal

TokenGraph v0.1 is a local-first Codex plugin that gives Codex a compact project map before raw repository reads. It must not use paid APIs or cloud services. It runs as a Node/TypeScript MCP server launched locally by Codex.

## Scope

The first version focuses on TypeScript, JavaScript, React, Next.js, PostgreSQL, and Supabase-style migrations. It provides useful routing and compression without trying to solve every language or database.

Included:
- Codex plugin manifest and repo-local marketplace entry.
- A TokenGraph skill that tells Codex to plan context before raw exploration.
- A stdio MCP server with tools for indexing, planning, graph search, SQL summaries, memory, compression, and token savings.
- Local project scanning that respects common ignore rules and excludes secrets, dependencies, build output, and generated assets by default.
- Lightweight code graph extraction for files, imports, exports, functions, classes, React components, Next.js routes, and test files.
- Lightweight PostgreSQL/Supabase extraction for tables, columns, foreign keys, policies, indexes, triggers, functions, and views.
- Local JSON persistence under `.tokengraph/`.

Excluded from v0.1:
- Cloud sync.
- OpenAI API keys.
- Paid external APIs.
- Automatic code editing.
- Full semantic embeddings.
- Full cross-language support.

## Architecture

The plugin has two layers. The Codex plugin layer packages metadata, the TokenGraph skill, and `.mcp.json`. The MCP layer exposes a local stdio server implemented in TypeScript. The MCP server owns scanning, indexing, planning, memory, compression, and savings reporting.

The v0.1 data model is intentionally simple. It stores a deterministic project snapshot as JSON so the plugin is portable on Windows without native database build friction. The schema is SQLite-ready: files, symbols, imports, SQL objects, memories, and sessions are already separated into graph-like records. SQLite FTS5 can replace JSON persistence in a later version without changing tool contracts.

## Tool Surface

- `tokengraph_index_project`: scan the workspace and persist a local index.
- `tokengraph_project_map`: return compact framework, module, symbol, SQL, and memory counts.
- `tokengraph_plan_context`: classify a task and return a small patch scope, relevant SQL, relevant memory, first reads, files to avoid, tests, and token estimate.
- `tokengraph_search_graph`: search indexed files, symbols, and SQL objects. Memory review is handled by memory-specific tools in later versions.
- `tokengraph_explain_symbol`: explain why a file or symbol is relevant.
- `tokengraph_summarize_sql`: return relevant database objects without dumping full migrations.
- `tokengraph_compress_output`: compress test/build/install/diff/log output.
- `tokengraph_remember_decision`: store a deliberate project memory.
- `tokengraph_show_token_savings`: show estimated avoided tokens for the latest session.

## Token Policy

Every tool response has a budget. TokenGraph prefers summaries and relationships over source text. Raw snippets are not returned in v0.1 except short evidence lines such as paths, symbol names, failing test names, and error summaries.

## Safety And Privacy

TokenGraph defaults to local-only indexing. It excludes `.env*`, keys, certificates, lock-heavy dependency folders, build output, caches, binary files, and large files. It records where local state is stored and provides a clear reset path by deleting `.tokengraph/`.

## Validation

The build is verified with:
- Unit tests for scanner, SQL extraction, planning, memory, and compression.
- TypeScript compilation.
- MCP server smoke checks where practical.
- Codex plugin manifest validation.
