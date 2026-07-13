---
name: token-budget-optimizer
description: Use when a task needs an explicit retrieval profile or context budget to control excessive input size.
---

# Token Budget Optimizer

## When not to use

Do not use merely to minimize tokens when doing so could hide required implementation or verification evidence.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; if blocked, follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task, constraints?, profile, maxTokens? })` only when a retrieval plan is needed; capture the returned taskId. Otherwise omit `taskId` from the first direct intent call so it can auto-start the ledger and return a taskId; capture the returned taskId. Forward explicit constraints verbatim. The optional token cap is task policy derived from constraints; this skill prescribes no fixed numeric defaults. Advanced breadth budgets remain on the opt-in full compatibility surface.
3. Reuse that exact taskId. Use `tokengraph_query_context` for only the overview, search, symbol, SQL, or wiki evidence the plan requires. Use `tokengraph_compress` with `mode: "output"` or `mode: "context"` for oversized material. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Use compact responses by default. Request `responseMode: "verbose"` only for explicit diagnostics. Compare original, compact, and overhead estimates. Describe estimated savings including overhead and uncertainty; make no exact claims. Never trade away constraints, correctness, or verification for a lower estimate.
5. Only after the requested outcome and verification are complete, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state "TokenGraph was not used," use narrow local searches and reads, and provide no TokenGraph savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
