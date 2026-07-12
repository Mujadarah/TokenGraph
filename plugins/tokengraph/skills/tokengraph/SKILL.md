---
name: tokengraph
description: Use when repository work needs compact, task-scoped project evidence before broad raw reads.
---

# TokenGraph

Use this skill as the router for TokenGraph work. Specialized bundled skills follow this lifecycle and add only their exact mode or action calls.

## Common lifecycle

1. Call `tokengraph_setup({})` before any project tool and capture `trustedWorkspace.root` as the trusted root. If setup is blocked, follow its recovery guidance, do not invent a taskId, and do not call project tools against an arbitrary root.
2. Call `tokengraph_prepare_context({ root: trusted root, task, profile?, budgets?, host? })` once and capture its one taskId. Confirm its returned resolved root matches the trusted root.
3. Pass the exact taskId and trusted root to every subsequent task-aware call. Never merge tasks or workspaces, invent an id, reuse an id from another task, or reuse a completed taskId.
4. Route evidence through the core surface as needed:
   - `tokengraph_query_context` for overview, search, symbol, SQL, or wiki context.
   - `tokengraph_compress` for output or mixed context.
   - `tokengraph_recall` for recalled or reviewed knowledge.
   - `tokengraph_analyze` for failure, risk, or architecture analysis.
   - `tokengraph_propose_knowledge` for review-queue actions, never direct application.
5. Call `tokengraph_task_report({ taskId, root: trusted root, disposition: "complete" })` only after the requested outcome and verification are complete. Use `tokengraph_task_report({ taskId, root: trusted root, disposition: "pause" })` for approval, missing evidence, blocked setup after task creation, or unfinished work.

Setup blocked before task creation means recovery without an invented taskId. Setup blocked after task creation means pause the captured task. If core tools are unavailable, state “TokenGraph was not used,” use narrow local `rg`, targeted file reads, and relevant local commands, and never claim savings or graph-backed evidence.

Codex or Claude plugin refresh may require a fresh task or `/reload-plugins`. The lifecycle hook tracks core tool calls and checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call `tokengraph_task_report` explicitly and include its returned status manually.

## Completion discipline

- Treat compact output as routing evidence; use recommended targeted raw reads when exact source or confidence requires them.
- Preserve user constraints and distinguish verified facts from hypotheses.
- Do not claim exact token savings; estimates include tool overhead.
- Do not complete a task whose approval, application, evidence, change, or verification remains pending.
