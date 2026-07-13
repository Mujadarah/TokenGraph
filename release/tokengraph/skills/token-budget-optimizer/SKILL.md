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
2. Call `tokengraph_prepare_context({ root: trusted root, task, constraints?, profile, maxTokens? })` once and capture its taskId. Forward explicit constraints verbatim. The optional token cap is task policy derived from the constraints; this skill prescribes no fixed numeric defaults. Advanced breadth budgets remain on the opt-in full compatibility surface.
3. Reuse that exact taskId and trusted root. Use `tokengraph_query_context` for only the overview, search, symbol, SQL, or wiki evidence the plan requires. Use `tokengraph_compress` with `mode: "output"` or `mode: "context"` for oversized material.
4. Use the default compact response. Request `responseMode: "verbose"` only for explicit diagnostics. Compare the returned original, compact, and overhead estimates. Describe estimated savings including overhead and uncertainty; make no exact claims. Never trade away constraints, correctness, or verification for a lower estimate.
5. Call `tokengraph_task_report({ taskId, root: trusted root, disposition: "complete" })` only after the requested outcome and verification are complete. Use `tokengraph_task_report({ taskId, root: trusted root, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use narrow local searches and reads, and provide no TokenGraph savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
