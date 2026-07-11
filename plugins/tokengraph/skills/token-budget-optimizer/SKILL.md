---
name: token-budget-optimizer
description: Use TokenGraph profiles, planner budgets, token estimates, and compression tools to keep context compact without lowering implementation quality.
when_to_use: Use when a coding agent risks excessive context use or needs a tighter retrieval profile.
---

# Token Budget Optimizer

Use this skill when a task risks excessive context use or when a coding agent needs a tighter retrieval profile without hiding important implementation detail.

## MCP tools to call

1. Call `tokengraph_get_config` to inspect the active token-saving profile and limits.
2. Call `tokengraph_set_profile` only when the user asks for a different profile or the task clearly needs a temporary conservative, balanced, or aggressive mode.
3. Call `tokengraph_update_config` for explicit local limits when requested.
4. Call `tokengraph_plan_context` with `maxEstimatedTokens`, `maxFiles`, and the chosen profile.
5. Call `tokengraph_compress_output` for long logs, diffs, tests, builds, and installs.
6. Call `tokengraph_show_token_savings` to report estimates after meaningful TokenGraph use.

## Operating rules

- Avoid raw reads when planner, wiki, map, SQL summaries, or compression can provide safe first context.
- Do not chase lower token counts at the expense of implementation quality.
- Mark hypotheses clearly when estimating savings or likely patch scope.
- Do not claim exact token savings; TokenGraph savings are estimates.
- Do not pretend MCP tools were used when unavailable. Fall back to narrow searches and say the estimate cannot be produced from TokenGraph.
