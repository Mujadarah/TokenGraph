---
name: token-budget-optimizer
description: Use when a task needs an explicit retrieval profile or context budget to control input size.
---

# Token Budget Optimizer

## When not to use

Do not minimize tokens when that could hide implementation or verification evidence.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_prepare_context` with the task policy's `profile`, `constraints`, and optional `maxTokens`; then use required `tokengraph_query_context` or `tokengraph_compress` calls. The policy supplies no fixed numeric defaults.

## Evidence required

Compare original, compact, and overhead budgets. Report estimated savings with uncertainty, never exact claims; show which evidence set the budget.

## Failure boundaries

Do not trade correctness, tests, security, or required context for a smaller budget. Stop when the profile conflicts with explicit constraints or when an estimate omits required evidence.

## Completion criteria

Return the selected profile, budget rationale, preserved constraints, and an uncertainty-aware estimate. A lower estimate is not success if the task evidence is incomplete.
