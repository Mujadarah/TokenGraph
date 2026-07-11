---
name: graph-context-retrieval
description: Use focused TokenGraph graph, wiki, SQL, and planner tools to retrieve compact implementation context before raw reads.
when_to_use: Use when a coding agent needs project structure, scope, routes, imports, SQL objects, or symbols before reading source.
---

# Graph Context Retrieval

Use this skill when a coding agent needs to understand project structure, likely patch scope, routes, imports, SQL objects, or symbols before opening source files.

## MCP tools to call

1. Call `tokengraph_get_config` to understand the active profile and context limits.
2. Call `tokengraph_index_status` with the explicit workspace root. If the index is missing or stale, call `tokengraph_index_project`.
3. Prefer `tokengraph_show_wiki_page` for overview, structure, routes, database, and decisions orientation.
4. Call `tokengraph_project_map` when counts, frameworks, or graph shape are needed.
5. Call `tokengraph_plan_context` with the concrete task before selecting files.
6. Call `tokengraph_explain_symbol` when inbound or outbound references would clarify a target symbol.
7. Call `tokengraph_summarize_sql` when SQL, RLS, auth, tenant isolation, migrations, or data access are relevant.

## Operating rules

- Avoid raw reads until the wiki, project map, and planner have narrowed the target.
- Use raw files only for the recommended first reads or narrowly targeted snippets.
- Mark hypotheses clearly when the graph suggests but does not prove a relationship.
- Do not pretend TokenGraph MCP tools were used when they are unavailable. Say they are unavailable and fall back to narrow `rg` plus targeted file reads.
- Preserve implementation quality. If compact context omits something important, recommend a targeted raw read.
