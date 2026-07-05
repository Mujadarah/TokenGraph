---
name: tokengraph
description: Use when working in a codebase where Codex should reduce token waste by routing through TokenGraph's local MCP project map, context planner, SQL graph, memory, and log compressor before reading raw files.
---

# TokenGraph

Use TokenGraph as the context router before raw repository exploration.

## Core Rule

For coding tasks in a project where TokenGraph MCP tools are available, use this order:

1. Call `tokengraph_index_status` when available. If it reports `missing` or `stale`, call `tokengraph_index_project`.
2. Call `tokengraph_project_map` for a compact overview.
3. Call `tokengraph_plan_context` with the user's task before reading raw files.
4. Read only the recommended first files or narrow snippets from the returned patch scope, using `startLine`/`endLine` hints when present.
5. Call `tokengraph_explain_symbol` before opening a file or symbol when inbound/outbound references would clarify the patch scope.
6. If the task touches data, auth, reports, persistence, RLS, migrations, or database-backed UI, call `tokengraph_summarize_sql`.
7. Compress long test, build, install, diff, or log output with `tokengraph_compress_output` before using it as context.
8. Store durable project decisions only when they are deliberate and useful with `tokengraph_remember_decision`.

If the TokenGraph MCP tools are not exposed in the current thread, say that briefly, then fall back to narrow `rg`/file reads. Do not pretend TokenGraph was used.

## Do Not

- Do not dump full files, full migrations, full logs, or all memories unless the user explicitly asks.
- Do not treat TokenGraph memory as automatically correct. Prefer inspectable, editable, user-approved memory.
- Do not claim exact token savings. TokenGraph reports estimates.
- Do not send repository content to cloud services from TokenGraph. This version is local-only.
- Do not use `tokengraph_reset_project` unless the user asks to reset TokenGraph state or a stale/corrupt local index is blocking progress.

## Useful Prompts

- "Use TokenGraph to index this project and show the project map."
- "Use TokenGraph to check whether this project index is stale."
- "Use TokenGraph to plan context for this task before reading files."
- "Use TokenGraph to explain this symbol before reading the source file."
- "Use TokenGraph to compress this failing test output."
- "Use TokenGraph to remember this project decision."
