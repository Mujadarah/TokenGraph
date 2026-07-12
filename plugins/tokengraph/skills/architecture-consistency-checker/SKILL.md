---
name: architecture-consistency-checker
description: Use TokenGraph graph and SQL context to check dependency direction, rule fit, and architecture-sensitive changes.
when_to_use: Use when a coding agent changes module boundaries, imports, security rules, SQL, or release packaging.
---

# Architecture Consistency Checker

Use this skill when reviewing or implementing changes that may affect module boundaries, import direction, security rules, RLS, tenant isolation, audit logging, release packaging, or required tests.

## MCP tools to call

Call `tokengraph_setup_status` first. If it reports `blocked`, follow its recovery steps and do not retry project tools with untrusted roots.

1. Call `tokengraph_index_status` and refresh with `tokengraph_index_project` when needed.
2. Call `tokengraph_project_map` to inspect module groups, routes, imports, and SQL object counts.
3. Call `tokengraph_plan_context` with the architecture concern as the task.
4. Call `tokengraph_explain_symbol` for boundary symbols or suspicious imports.
5. Call `tokengraph_summarize_sql` for RLS, grants, auth, tenant, audit, or migration concerns.
6. Call `tokengraph_review_memories` for recorded architecture decisions.
7. Call `tokengraph_list_rules` and `tokengraph_check_architecture` before manual checks.
8. Call `tokengraph_add_rule`, `tokengraph_update_rule`, or `tokengraph_delete_rule` only when the user asks to change local architecture rules.

## Operating rules

- Avoid raw reads until graph output identifies the relevant boundary files.
- Mark hypotheses clearly, especially inferred dependency direction or security intent.
- Do not pretend architecture-rule MCP tools were used when they are unavailable.
- Treat compact warnings as routing evidence, not proof. Confirm with targeted source or SQL reads before changing code.
- If a rule is missing, propose it explicitly instead of silently enforcing an unstated convention.
