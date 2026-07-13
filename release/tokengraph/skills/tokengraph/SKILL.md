---
name: tokengraph
description: Use when repository work needs compact, task-scoped project evidence before broad raw reads.
---

# TokenGraph

Use this skill as the router. Specialized skills add their exact mode or action calls.

## Common lifecycle

1. Call `tokengraph_setup({})` before project tools and capture `trustedWorkspace.root` as the trusted root. If blocked, follow recovery, do not invent a taskId, and do not use an arbitrary root.
2. Use `tokengraph_prepare_context({ task, constraints?, profile?, maxTokens?, host? })` only when a retrieval plan is needed; capture its returned taskId. For direct query, compress, recall, or analyze work, omit `taskId` from the first intent call so it can auto-start the ledger and return a taskId; capture the returned taskId. Forward user constraints verbatim.
3. Pass that exact taskId to subsequent task-aware calls. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root. Never merge tasks or workspaces, invent an id, reuse another task’s id, or reuse a completed taskId.
4. Route evidence through the core surface as needed:
   - `tokengraph_query_context` for overview, search, symbol, SQL, or wiki context.
   - `tokengraph_compress` for output or mixed context.
   - `tokengraph_recall` for recalled or reviewed knowledge.
   - `tokengraph_analyze` for failure, risk, or architecture analysis.
   - `tokengraph_propose_knowledge` for review-before-apply actions. Proposal does not mutate knowledge; approval needs a canonically rehashed path source and applies once; rejection applies nothing.
5. Only after the requested outcome and verification are complete, call `tokengraph_task_report({ taskId })`; compact reporting is the default and contains status, taskId, footer, and reportingStatus. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics. Use `tokengraph_task_report({ taskId, disposition: "pause" })` for approval, missing evidence, blocked setup after task creation, or unfinished work.

Blocked setup requires recovery. If core tools are unavailable, state “TokenGraph was not used,” use narrow local searches, reads, and commands, and never claim savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

Codex or Claude plugin refresh may require a fresh task or `/reload-plugins`. The lifecycle hook tracks core tool calls and checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call `tokengraph_task_report` explicitly and include its returned status manually.

## Completion discipline

- Treat compact output as routing evidence; use recommended targeted raw reads when exact source or confidence requires them.
- Skip TokenGraph intent calls for tiny self-contained work whose raw context is already bounded; use it when routing can avoid broader reads or preserve constraints.
- Core tools return compact projections by default. Request `responseMode: "verbose"` only for an explicit diagnostic need.
- Preserve user constraints and distinguish verified facts from hypotheses.
- Do not claim exact token savings; estimates include tool overhead.
- Do not complete a task whose approval, application, evidence, change, or verification remains pending.
