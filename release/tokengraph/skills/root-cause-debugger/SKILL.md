---
name: root-cause-debugger
description: Use TokenGraph compression, graph traversal, and targeted context planning to debug failures without broad log or file dumps.
when_to_use: Use when a coding agent investigates a test, build, runtime, install, or log failure.
---

# Root Cause Debugger

Use this skill when investigating test, build, runtime, install, or log failures and a coding agent needs a compact path from symptom to likely cause.

## MCP tools to call

Call `tokengraph_setup_status` first. If it reports `blocked`, follow its recovery steps and do not retry project-aware diagnostics against arbitrary roots.

1. Call `tokengraph_trace_failure` with the exact failure text, failure kind, root, task, and profile when available.
2. If `tokengraph_trace_failure` is unavailable, call `tokengraph_compress_output` on long failure output before using it as context.
3. Call `tokengraph_index_status` and refresh with `tokengraph_index_project` when the index is missing or stale.
4. Call `tokengraph_plan_context` with the exact failure and task.
5. Call `tokengraph_explain_symbol` for failing symbols, stack frames, or imported modules.
6. Call `tokengraph_search_graph` for exact failing test names, error paths, or public API names.
7. Call `tokengraph_summarize_sql` for SQL, RLS, migration, tenant, or auth failures.
8. Call `tokengraph_review_memories` for relevant known bug or fragile-module memories.

## Operating rules

- Avoid raw logs and broad raw reads. Preserve exact error messages, test names, stack paths, and line numbers.
- Separate proven facts from hypotheses. Label each hypothesis and attach the evidence that supports it.
- Recommend the smallest first read or command that could disprove the leading hypothesis.
- Do not pretend `tokengraph_trace_failure` or any other MCP tool was used when it is unavailable. State the missing tool and use the available tools above.
- Do not fix a bug without adding or identifying a regression test first.
