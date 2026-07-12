---
name: regression-detector
description: Use TokenGraph graph, SQL, memory, and planner context to assess change risk and select regression tests.
when_to_use: Use when a coding agent reviews a diff, prepares tests, or estimates affected graph, SQL, memory, or route behavior.
---

# Regression Detector

Use this skill when reviewing a diff, preparing tests, or estimating which files, routes, SQL objects, memories, or rules may be affected by a change.

## MCP tools to call

Call `tokengraph_setup_status` first. If it reports `blocked`, follow its recovery steps and do not claim graph-backed regression analysis ran.

1. Call `tokengraph_assess_change_risk` with the changed files, task, diff summary, root, and profile when available.
2. Call `tokengraph_index_status` and refresh with `tokengraph_index_project` when needed.
3. Call `tokengraph_project_map` to inspect import counts, route exposure, and SQL involvement.
4. Call `tokengraph_plan_context` with the task and changed files.
5. Call `tokengraph_explain_symbol` for changed exports and high-fan-in modules.
6. Call `tokengraph_summarize_sql` for policy, migration, auth, tenant, audit, or data-model changes.
7. Call `tokengraph_review_memories` for known bug, fragile-module, or release-decision memories.

## Operating rules

- Avoid raw reads until the graph identifies affected files or tests.
- Mark hypotheses clearly when identifying possible regressions from graph proximity.
- Do not pretend `tokengraph_assess_change_risk` or other unavailable MCP tools were used. State the missing tool and use the available fallback tools above.
- Recommend tests based on evidence: direct tests, inbound dependents, route exposure, SQL policy involvement, and memories.
- Treat risk scores as estimates, not guarantees of correctness.
