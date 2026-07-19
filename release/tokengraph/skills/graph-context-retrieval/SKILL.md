---
name: graph-context-retrieval
description: Use when project structure, symbols, SQL objects, routes, or wiki orientation must be narrowed before source inspection.
---

# Graph Context Retrieval

## When not to use

Do not use for a known one-file lookup or when the user explicitly wants raw source only.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root. If blocked, follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a retrieval plan is needed. Otherwise omit `taskId` from the first `tokengraph_query_context` call so it can auto-start the ledger and return a taskId; capture the returned taskId.
3. Reuse that exact taskId for queries. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root:
   - `tokengraph_query_context({ taskId, mode: "overview" })` for project shape.
   - `tokengraph_query_context({ taskId, mode: "search", query })` for paths or identifiers.
   - `tokengraph_query_context({ taskId, mode: "symbol", target })` for references.
   - `tokengraph_query_context({ taskId, mode: "sql", query })` for schema, policy, or migration context.
   - `tokengraph_query_context({ taskId, mode: "wiki", slug })` for a known page.
4. Use targeted raw reads only when recommended by the plan or when confidence is insufficient. State which exact evidence requires the read.
5. Pass `knownArtifacts: ["id@hash"]` only for exact artifact keys retained from a prior response. Otherwise omit `knownArtifacts`; TokenGraph resends required evidence by default.
6. Only after the requested orientation is delivered and checked, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state "TokenGraph was not used," use narrow local `rg` and targeted file reads, and claim no graph-backed evidence or savings.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
