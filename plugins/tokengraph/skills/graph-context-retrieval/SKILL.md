---
name: graph-context-retrieval
description: Use when project structure, symbols, SQL objects, routes, or wiki orientation must be narrowed before source inspection.
---

# Graph Context Retrieval

## When not to use

Do not use for a known one-file lookup or when the user explicitly wants raw source only.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})`. If blocked, follow recovery and do not invent a taskId.
2. Call `tokengraph_prepare_context({ root?, task })` once; capture its taskId and trusted root.
3. Reuse that exact taskId and trusted root for queries:
   - `tokengraph_query_context({ taskId, root?, mode: "overview" })` for project shape.
   - `tokengraph_query_context({ taskId, root?, mode: "search", query })` for paths or identifiers.
   - `tokengraph_query_context({ taskId, root?, mode: "symbol", target })` for references.
   - `tokengraph_query_context({ taskId, root?, mode: "sql", query })` for schema, policy, or migration context.
   - `tokengraph_query_context({ taskId, root?, mode: "wiki", slug })` for a known page.
4. Use targeted raw reads only when recommended by the plan or when confidence is insufficient. State which exact evidence requires the read.
5. Call `tokengraph_task_report({ taskId, root?, disposition: "complete" })` only after the requested orientation is delivered and checked. Use `tokengraph_task_report({ taskId, root?, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use narrow local `rg` and targeted file reads, and claim no graph-backed evidence or savings.

A host refresh may require a fresh task or `/reload-plugins`. Until Phase 3 hook enforcement exists, call the report explicitly and manually include its returned status in the final report.
