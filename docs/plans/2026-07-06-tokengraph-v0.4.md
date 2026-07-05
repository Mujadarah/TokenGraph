# TokenGraph v0.4 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve TokenGraph's code graph enough that context plans can route Codex through resolved local imports, React/Next.js structure, symbol references, and targeted first-read line hints.

**Architecture:** Keep the existing JSON index and MCP tool contracts, extending graph metadata in backward-compatible optional fields. Scanner extraction owns file, import, symbol, component, route, and line metadata; planner scoring consumes that metadata with separate weights for files, tests, SQL, symbols, and memories; the MCP explain tool surfaces inbound and outbound references without reading raw source.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK server package, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: Scanner Graph Intelligence

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/fileScanner.ts`

**Step 1: Write failing tests**

Add scanner tests for:
- `@/` alias and relative import resolution into indexed local file paths.
- `pages/**` Next.js route detection.
- React component symbols from exported arrow/function components.
- Symbol line hints.

**Step 2: Run test to verify failure**

Run: `pnpm test -- tests/core.test.ts`
Expected: FAIL because import edges do not include `resolvedPath`, `pages/**` routes are not detected, component symbols are not classified, and symbols do not carry line hints.

**Step 3: Implement minimal scanner support**

Add optional `resolvedPath`, `line`, `startLine`, and `endLine` metadata. Resolve relative imports and common root aliases after scanning files. Detect `pages/**` routes and classify PascalCase TSX/JSX exports that return JSX as components.

**Step 4: Run test to verify pass**

Run: `pnpm test -- tests/core.test.ts`
Expected: PASS.

### Task 2: Planner Scoring And Line Hints

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/planner.ts`

**Step 1: Write failing tests**

Add planner tests that:
- Prefer relevant memories by task overlap when the provided memory list is unsorted.
- Include safe `startLine` and `endLine` hints in `recommendedFirstReads`.

**Step 2: Run test to verify failure**

Run: `pnpm test -- tests/core.test.ts`
Expected: FAIL because planner memory selection is a slice and ranked files do not include line hints.

**Step 3: Implement minimal planner support**

Score files with separate contributions from path/kind, symbols, imports, routes, tests, and SQL. Rank memories by task overlap inside `buildContextPlan`. Add line hints from matching symbols when available.

**Step 4: Run test to verify pass**

Run: `pnpm test -- tests/core.test.ts`
Expected: PASS.

### Task 3: Explain Symbol References

**Files:**
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`
- Modify: `plugins/tokengraph/src/server.ts`

**Step 1: Write failing smoke expectations**

Extend the MCP smoke test to call `tokengraph_explain_symbol` for a symbol and expect inbound and outbound references based on resolved imports.

**Step 2: Run build and smoke test**

Run: `pnpm build`
Run: `pnpm test -- tests/mcp-smoke.test.ts`
Expected: FAIL until the explain tool returns reference metadata.

**Step 3: Implement explain output**

Return matched files/symbols plus inbound references, outbound references, and local import edges.

**Step 4: Run smoke test to verify pass**

Run: `pnpm build`
Run: `pnpm test -- tests/mcp-smoke.test.ts`
Expected: PASS.

### Task 4: Version, Docs, Skill, Validation

**Files:**
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/README.md`
- Modify: `plugins/tokengraph/skills/tokengraph/SKILL.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`

**Step 1: Update version metadata**

Set package, plugin manifest, and MCP server version to `0.4.0`.

**Step 2: Update docs and skill**

Document v0.4 graph intelligence, explain references, and first-read line hints.

**Step 3: Extend validator**

Have `validate-plugin.mjs` check for v0.4 tool-output keywords in the built server.

### Task 5: Final Verification

**Files:**
- Verify: `plugins/tokengraph`

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: all tests pass.

**Step 2: Run TypeScript build**

Run: `pnpm build`
Expected: exit code 0.

**Step 3: Run plugin validator**

Run: `pnpm validate:plugin`
Expected: exit code 0.
