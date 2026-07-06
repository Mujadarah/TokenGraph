# TokenGraph v0.5 SQL And Persistence Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand TokenGraph SQL indexing so Codex can route database work through richer PostgreSQL and Supabase migration context without changing existing MCP tool contracts.

**Architecture:** Keep the current JSON-backed project index as the default persistence layer. Extend `SqlGraph` with backward-compatible arrays and optional fields, then make parser, planner, project map, search, and SQL summary consume the richer graph.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK server package, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: PostgreSQL Object Coverage

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/sqlParser.ts`

- [ ] **Step 1: Write the failing parser test**

Add a `parsePostgresMigration` test with `create type`, `create extension`, `grant`, `create materialized view`, named constraints, table constraints, and `alter table ... add constraint`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`

Expected: FAIL because `SqlGraph` does not include enums, extensions, grants, materialized views, or constraints.

- [ ] **Step 3: Add minimal types and parser support**

Extend `SqlGraph` with `constraints`, `enums`, `extensions`, `grants`, and `materializedViews`. Parse these objects with conservative regexes that keep existing table, relation, policy, index, trigger, function, and view behavior unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`

Expected: PASS.

### Task 2: Supabase RLS Policy Detail

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/sqlParser.ts`

- [ ] **Step 1: Write the failing RLS test**

Add a policy test that expects command, roles, `usingExpression`, and `checkExpression` from a Supabase-style policy.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`

Expected: FAIL because policies only expose name, table, command, and file path.

- [ ] **Step 3: Add minimal policy parsing**

Parse optional `for`, `to`, `using (...)`, and `with check (...)` clauses into optional policy fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`

Expected: PASS.

### Task 3: Migration Object History

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/sqlParser.ts`
- Modify: `plugins/tokengraph/src/core/projectIndexer.ts`

- [ ] **Step 1: Write the failing history test**

Add an indexing test with multiple ordered SQL migration files and expect object history entries sorted by migration file path.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`

Expected: FAIL because merged SQL graphs do not track ordered object history.

- [ ] **Step 3: Add migration history support**

Add `history` entries to `SqlGraph`, emit history while parsing, and sort SQL files before merging.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`

Expected: PASS.

### Task 4: Planner And MCP Summaries

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/planner.ts`
- Modify: `plugins/tokengraph/src/server.ts`

- [ ] **Step 1: Write failing summary tests**

Add expectations that planner and MCP SQL summaries can rank policies by RLS expressions and include v0.5 object kinds without changing tool names.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test -- tests/core.test.ts tests/mcp-smoke.test.ts`

Expected: FAIL until new SQL object kinds are ranked and summarized.

- [ ] **Step 3: Extend ranking and summaries**

Add the new SQL object kinds to `RankedSqlObject`, planner ranking, project map counts, search, and `tokengraph_summarize_sql`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test -- tests/core.test.ts tests/mcp-smoke.test.ts`

Expected: PASS.

### Task 5: Version, Docs, And Validation

**Files:**
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/README.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update version metadata**

Set package, plugin manifest, and MCP server version to `0.5.0`.

- [ ] **Step 2: Update docs**

Document v0.5 SQL parser depth, RLS detail, and migration history. Mark v0.5 complete in the roadmap and leave optional SQLite as a later persistence enhancement unless it becomes required.

- [ ] **Step 3: Extend validator**

Have `validate-plugin.mjs` check for v0.5 SQL surface keywords in the built server output or source contract checks.

- [ ] **Step 4: Final verification**

Run:

```powershell
pnpm test
pnpm build
pnpm validate:plugin
```

Expected: all commands exit 0.
