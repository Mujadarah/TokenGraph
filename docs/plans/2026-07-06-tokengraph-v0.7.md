# TokenGraph v0.7 Review And Export Implementation Plan

> **For agentic workers:** Use test-driven development for behavior changes. Keep the release focused on read-only memory review, compact visual graph export, MCP smoke coverage, and release metadata.

**Goal:** Add local-only review/export tools that help Codex inspect stored memories and visualize the indexed project graph without reading raw source content.

**Architecture:** Keep the MCP server as a local stdio Node.js process. Add pure core helpers for memory review and map export, then expose them as read-only MCP tools backed by the existing JSON index and memory store.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK server package, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: Memory Review Workflow

**Files:**
- Add: `plugins/tokengraph/src/core/review.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/server.ts`

- [x] **Step 1: Write failing memory review test**

Add a test that stores two memories, reviews them with a focused query, expects the relevant memory to rank first, and verifies memory state is unchanged.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm test -- tests/core.test.ts`

Expected: FAIL because `src/core/review.ts` does not exist.

- [x] **Step 3: Implement read-only review**

Add `reviewMemories` with bounded limits, matched terms, ranking, and a policy string that states the tool does not modify local memory state.

- [x] **Step 4: Expose MCP tool**

Register `tokengraph_review_memories` with read-only annotations and inputs for optional `root`, `query`, and `limit`.

### Task 2: Visual Project Map Export

**Files:**
- Add: `plugins/tokengraph/src/core/review.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/server.ts`

- [x] **Step 1: Write failing project map export test**

Add a test that indexes a small project with a resolved import edge, exports Mermaid output, and verifies the output contains file labels and no raw source.

- [x] **Step 2: Implement exporter**

Add `exportProjectMap` with `mermaid` and `json` formats, bounded node limits, resolved import edges only, and no source snippets.

- [x] **Step 3: Expose MCP tool**

Register `tokengraph_export_project_map` with read-only annotations and inputs for optional `root`, `format`, and `limit`.

### Task 3: MCP Smoke And Release Metadata

**Files:**
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`
- Modify: `plugins/tokengraph/scripts/smoke.mjs`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/src/server.ts`

- [x] **Step 1: Add MCP smoke coverage**

Assert both new tools are listed and callable through JSON-RPC stdio.

- [x] **Step 2: Update smoke command**

Require the new read-only tools and call them during CLI smoke validation.

- [x] **Step 3: Update release metadata**

Set package, plugin manifest, and MCP server version to `0.7.0`.

- [x] **Step 4: Extend validator**

Have `validate-plugin.mjs` check for v0.7 version metadata, tool registrations, and Mermaid export support in built output.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `plugins/tokengraph/README.md`
- Modify: `plugins/tokengraph/skills/tokengraph/SKILL.md`
- Modify: `ROADMAP.md`

- [x] **Step 1: Document release scope**

Document memory review, visual map export, and the two new MCP tools.

- [x] **Step 2: Final verification**

Run:

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm smoke -- --root . --json
pnpm validate:plugin
```

Expected: all commands exit 0.
