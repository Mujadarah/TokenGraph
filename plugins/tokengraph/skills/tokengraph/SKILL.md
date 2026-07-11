---
name: tokengraph
description: Use when working in a codebase where a coding agent should reduce token waste by routing through TokenGraph's local MCP project map, wiki, context planner, SQL graph, memory, and log compressor before reading raw files.
when_to_use: Use at the start of coding-agent work when TokenGraph MCP tools are available and raw repository reads would be broad.
---

# TokenGraph

Use TokenGraph as the context router before raw repository exploration.

## Core Rule

For coding tasks in a project where TokenGraph MCP tools are available, use this order:

1. Call `tokengraph_get_config` when available to see the active token-saving profile and local limits.
2. Call `tokengraph_index_status` when available. Pass the current workspace root explicitly when the tool schema offers `root`; plugin installs may launch the MCP server from the plugin directory rather than the user's project. If the tool says TokenGraph is running from its plugin directory, retry with the explicit workspace root. If the status reports `missing` or `stale`, call `tokengraph_index_project` with the same root. Use `fullReindex: true` only when the user asks for a full rebuild or the index looks corrupt.
3. After indexing, use `tokengraph_generate_wiki` when the wiki is missing or stale. If `wikiGenerationEnabled` is true, indexing should refresh it automatically; still check `wikiStatus` before trusting a page.
4. For orientation questions about project shape, routes, database objects, or recorded decisions, call `tokengraph_show_wiki_page` and prefer the relevant wiki page over raw file reads.
5. Call `tokengraph_project_map` for a compact overview when the wiki is not enough or when counts and graph metadata are needed.
6. Call `tokengraph_plan_context` with the user's task and an appropriate `profile` before reading raw files.
7. Read only the recommended first files or narrow snippets from the returned patch scope, using `startLine`/`endLine` hints when present.
8. Call `tokengraph_explain_symbol` before opening a file or symbol when inbound/outbound references would clarify the patch scope.
9. If the task touches data, auth, reports, persistence, RLS, migrations, or database-backed UI, call `tokengraph_summarize_sql`.
10. Compress long test, build, install, diff, or log output with `tokengraph_compress_output` before using it as context.
11. Review local memories with `tokengraph_review_memories` before relying on older or broad memory entries.
12. Export compact graph visuals with `tokengraph_export_project_map` when a diagram would clarify project structure.
13. Store durable project decisions only when they are deliberate and useful with `tokengraph_remember_decision`.

If the TokenGraph MCP tools are not exposed in the current thread, say that briefly, then fall back to narrow `rg`/file reads. Do not pretend TokenGraph was used.

## Do Not

- Do not dump full files, full migrations, full logs, or all memories unless the user explicitly asks.
- Do not treat wiki pages as raw source replacements for implementation details; they are orientation pages derived from indexed paths, names, SQL metadata, and memory titles/tags.
- Do not treat TokenGraph memory as automatically correct. Prefer inspectable, editable, user-approved memory.
- Do not claim exact token savings. TokenGraph reports estimates.
- Do not send repository content to cloud services from TokenGraph. This version is local-only.
- Do not use `tokengraph_reset_project` unless the user asks to reset TokenGraph state or a stale/corrupt local index is blocking progress.
- Do not force `fullReindex` for ordinary stale indexes; compatible indexes should update incrementally.

## Useful Prompts

- "Use TokenGraph to index this project and show the project map."
- "Use TokenGraph to generate the local wiki and show the overview page."
- "Use TokenGraph to switch to the aggressive token-saving profile."
- "Use TokenGraph to check whether this project index is stale."
- "Use TokenGraph to plan context for this task before reading files."
- "Use TokenGraph to explain this symbol before reading the source file."
- "Use TokenGraph to compress this failing test output."
- "Use TokenGraph to remember this project decision."
