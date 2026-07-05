# TokenGraph v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden TokenGraph v0.1 into a more reliable v0.2 with ignore-file support, better context planning, MCP smoke coverage, local plugin validation, and clearer skill guidance.

**Architecture:** Keep the local-only Node/TypeScript MCP server and JSON persistence model. Add narrowly scoped core helpers and tests rather than changing tool contracts. Treat plugin validation as a local script that checks the package, manifest, MCP entry, built output, and skill metadata.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK server package, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: Scanner Reliability

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/fileScanner.ts`

- [ ] **Step 1: Write the failing test**

Add a scanner test that creates `.gitignore` with `generated/`, writes `generated/client.ts`, writes `src/real.ts`, and expects only `src/real.ts` to be indexed while `generated` is excluded as `ignored`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`
Expected: FAIL because `.gitignore` patterns are not applied.

- [ ] **Step 3: Implement minimal scanner support**

Use the existing `ignore` dependency to load root `.gitignore` patterns, add `ignored` to the exclusion reason union, and skip ignored entries before reading file contents.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`
Expected: PASS.

### Task 2: Planner Relevance

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/planner.ts`

- [ ] **Step 1: Write the failing test**

Add a planner test with a matching service file and an unrelated Next route. For task `Fix patient summary loading`, assert the matching service is selected and the unrelated route is not selected only because it is a route.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`
Expected: FAIL because route files receive a relevance boost even without task overlap.

- [ ] **Step 3: Implement minimal scoring fix**

Only apply route/kind boosts after lexical overlap exists, and make the reason describe matched graph data.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`
Expected: PASS.

### Task 3: MCP Smoke Coverage

**Files:**
- Create: `plugins/tokengraph/tests/mcp-smoke.test.ts`

- [ ] **Step 1: Write smoke test**

Spawn `node dist/index.js`, send JSON-RPC `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` for `tokengraph_index_project`, then assert the expected TokenGraph tool names and structured content are returned.

- [ ] **Step 2: Run build and smoke test**

Run: `pnpm build`
Run: `pnpm test -- tests/mcp-smoke.test.ts`
Expected: PASS once the built entry point and protocol handling are valid.

### Task 4: Plugin Validation

**Files:**
- Create: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/package.json`

- [ ] **Step 1: Add local validator**

Create a Node script that validates package version/name, `.codex-plugin/plugin.json`, `.mcp.json`, `dist/index.js`, and `skills/tokengraph/SKILL.md`.

- [ ] **Step 2: Add script command**

Add `validate:plugin` to `package.json` with `node scripts/validate-plugin.mjs`.

- [ ] **Step 3: Run validation**

Run: `pnpm validate:plugin`
Expected: PASS with a concise success line.

### Task 5: Docs And Skill Cleanup

**Files:**
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/README.md`
- Modify: `plugins/tokengraph/skills/tokengraph/SKILL.md`

- [ ] **Step 1: Update version metadata**

Set the package and plugin manifest version to `0.2.0`.

- [ ] **Step 2: Update README**

Describe v0.2 additions and include `pnpm validate:plugin` in local development commands.

- [ ] **Step 3: Tighten the TokenGraph skill**

Keep the skill concise, state the MCP-tool-first workflow, and add a fallback rule for when TokenGraph tools are not exposed.

### Task 6: Final Verification

**Files:**
- Verify: `plugins/tokengraph`

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 2: Run TypeScript build**

Run: `pnpm build`
Expected: exit code 0.

- [ ] **Step 3: Run plugin validator**

Run: `pnpm validate:plugin`
Expected: exit code 0.
