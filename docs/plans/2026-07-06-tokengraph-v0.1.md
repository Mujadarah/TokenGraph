# TokenGraph v0.1 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first local TokenGraph Codex plugin with a Node/TypeScript stdio MCP server.

**Architecture:** A repo-local Codex plugin points Codex at a local TypeScript MCP server. The server scans the current workspace into a compact graph snapshot, persists it under `.tokengraph/`, and exposes focused tools for context planning, graph search, SQL summaries, memory, log compression, and token savings.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: Package And Test Harness

**Files:**
- Create: `plugins/tokengraph/package.json`
- Create: `plugins/tokengraph/tsconfig.json`
- Create: `plugins/tokengraph/vitest.config.ts`
- Create: `plugins/tokengraph/tests/core.test.ts`

**Steps:**
1. Write failing tests for scanner, SQL parser, context planner, memory store, and compressor.
2. Install dependencies with `pnpm install`.
3. Run `pnpm test` and verify tests fail because implementation modules do not exist.

### Task 2: Core Indexing

**Files:**
- Create: `plugins/tokengraph/src/core/types.ts`
- Create: `plugins/tokengraph/src/core/token.ts`
- Create: `plugins/tokengraph/src/core/fileScanner.ts`
- Create: `plugins/tokengraph/src/core/sqlParser.ts`
- Create: `plugins/tokengraph/src/core/projectIndexer.ts`

**Steps:**
1. Implement the minimal scanner and SQL parser to satisfy tests.
2. Run `pnpm test`.
3. Refactor names and data shapes while tests remain green.

### Task 3: Planning, Memory, Compression

**Files:**
- Create: `plugins/tokengraph/src/core/planner.ts`
- Create: `plugins/tokengraph/src/core/memoryStore.ts`
- Create: `plugins/tokengraph/src/core/compressor.ts`
- Create: `plugins/tokengraph/src/core/persistence.ts`

**Steps:**
1. Implement local memory persistence and task planning.
2. Implement compact log and diff compression.
3. Run `pnpm test`.

### Task 4: MCP Server

**Files:**
- Create: `plugins/tokengraph/src/server.ts`
- Create: `plugins/tokengraph/src/index.ts`

**Steps:**
1. Register TokenGraph MCP tools with Zod schemas and clear annotations.
2. Ensure tools return `structuredContent` plus concise text content.
3. Run `pnpm build`.

### Task 5: Codex Plugin Packaging

**Files:**
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/.mcp.json`
- Create: `plugins/tokengraph/skills/tokengraph/SKILL.md`
- Create: `plugins/tokengraph/README.md`

**Steps:**
1. Patch plugin metadata for TokenGraph identity and discoverability.
2. Point `.mcp.json` at the built MCP server.
3. Add a skill that instructs Codex to use TokenGraph before raw file exploration.
4. Run plugin validation.

### Task 6: Final Verification

**Steps:**
1. Run `pnpm test`.
2. Run `pnpm build`.
3. Run `python validate_plugin.py plugins/tokengraph`.
4. Report validation level reached and any known gaps.

