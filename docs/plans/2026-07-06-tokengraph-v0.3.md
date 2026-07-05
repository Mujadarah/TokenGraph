# TokenGraph v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add index freshness and reset controls so Codex can detect stale TokenGraph context before trusting a persisted project map.

**Architecture:** Extend the existing JSON index with a deterministic project fingerprint derived from scanned graph metadata. Add read-only status logic that compares the stored fingerprint to a fresh scan, and add a reset tool that clears the index by default while preserving memory unless the caller explicitly requests all local TokenGraph state.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK server package, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: Index Fingerprints

**Files:**
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/projectIndexer.ts`

- [ ] **Step 1: Write failing test**

Add a test that indexes a project, records `project.fingerprint`, modifies a source file, indexes again, and expects the new fingerprint to differ while `scannedAt` remains an ISO timestamp.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`
Expected: FAIL because `ProjectIndex` has no `fingerprint`.

- [ ] **Step 3: Implement minimal fingerprinting**

Add `fingerprint: string` to `ProjectIndex` and compute it from sorted files, symbols, imports, exclusions, and SQL graph data using Node `crypto.createHash("sha256")`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`
Expected: PASS.

### Task 2: Status And Reset Core

**Files:**
- Create: `plugins/tokengraph/src/core/indexStatus.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/src/core/persistence.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`

- [ ] **Step 1: Write failing tests**

Add tests for `getIndexStatus(root)` returning `missing`, `fresh`, and `stale`. Add a reset test that clears `index.json` while preserving `memory.json` when mode is `index`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/core.test.ts`
Expected: FAIL because status/reset helpers do not exist.

- [ ] **Step 3: Implement minimal core**

Implement `getIndexStatus` by loading the persisted index, scanning/indexing the current project, and comparing fingerprints. Add `clearProjectIndex(root)` that removes only `.tokengraph/index.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/core.test.ts`
Expected: PASS.

### Task 3: MCP Tool Surface

**Files:**
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

- [ ] **Step 1: Write failing smoke expectations**

Update the smoke test to expect `tokengraph_index_status` and `tokengraph_reset_project`, call status before indexing, call status after indexing, reset the index, and call status again.

- [ ] **Step 2: Run build and smoke test**

Run: `pnpm build`
Run: `pnpm test -- tests/mcp-smoke.test.ts`
Expected: FAIL until the server registers both tools.

- [ ] **Step 3: Register tools**

Add `tokengraph_index_status` as read-only/idempotent and `tokengraph_reset_project` as destructive. `mode: "index"` clears only `index.json`; `mode: "all"` clears the full `.tokengraph` directory.

- [ ] **Step 4: Run smoke test to verify it passes**

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

- [ ] **Step 1: Update versions**

Set package, plugin manifest, and MCP server version to `0.3.0`.

- [ ] **Step 2: Update docs and skill**

Document v0.3 status/reset behavior. Update the skill to call `tokengraph_index_status` before relying on an existing index when the tool is available.

- [ ] **Step 3: Extend validator**

Have `validate-plugin.mjs` check for `tokengraph_index_status` and `tokengraph_reset_project` in built `dist/server.js`.

### Task 5: Final Verification

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
