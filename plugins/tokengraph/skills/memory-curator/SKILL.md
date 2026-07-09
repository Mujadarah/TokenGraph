---
name: memory-curator
description: Use TokenGraph memory review and decision capture to retrieve, qualify, and store durable project memory without injecting stale assumptions.
---

# Memory Curator

Use this skill when Codex needs to recall project decisions, compare current work with known memories, or decide whether a new durable memory should be stored.

## MCP tools to call

1. Call `tokengraph_review_memories` with a narrow query before relying on memory.
2. Call `tokengraph_plan_context` when memories should be ranked alongside files, tests, and SQL objects.
3. Call `tokengraph_remember_decision` only for deliberate, durable project decisions that are useful later.
4. Call `tokengraph_project_map` or `tokengraph_explain_symbol` when a memory refers to files or symbols that need current graph confirmation.
5. Use `tokengraph_recall_memory`, `tokengraph_update_memory`, `tokengraph_delete_memory`, `tokengraph_deprecate_memory`, `tokengraph_confirm_memory`, `tokengraph_find_memory_conflicts`, and `tokengraph_link_memory` for lifecycle-aware memory work.

## Operating rules

- Avoid raw memory dumps. Retrieve only relevant memories and verify drift-prone facts against current files or commands.
- Mark hypotheses clearly when memory suggests but does not prove a current-state fact.
- Do not pretend memory lifecycle MCP tools were used when they are unavailable. State the missing tool and fall back to review and current-state verification.
- Do not store important durable memories without explicit user instruction or clear approval.
- Treat deprecated, stale, or weakly evidenced memories as context to verify, not as truth.
