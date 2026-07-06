# TokenGraph v0.8 Token Budget Profiles And Incremental Indexing Implementation Plan

> **For agentic workers:** Use test-driven development for every behavior change. Keep this release scoped to v0.8: local config, MCP config tools, token-saving profiles, planner budget enforcement, incremental indexing, docs, smoke coverage, and validation.

**Goal:** Turn TokenGraph's existing context planner into a profile-aware budget router and make repeated indexing reuse unchanged graph data after small project changes.

**Architecture:** Store user-editable settings in `.tokengraph/config.json`, resolve planner budgets from explicit arguments, active profile defaults, and local config, then keep the MCP output structured and additive. Incremental indexing should reuse compatible persisted index data, parse only added or changed files, remove deleted files, re-resolve imports against the current file set, and fall back to a full reindex when persisted index schema is incompatible.

**Tech Stack:** Codex plugin manifest, Codex skills, plugin-provided stdio MCP server, Node.js, TypeScript, Zod, Vitest, local JSON persistence.

## Global Constraints

- Use the official Codex manual as the source for Codex/plugin/MCP assumptions.
- The manual says skills should stay focused and plugins are the installable unit for bundling skills and MCP servers.
- The manual says plugin-provided MCP servers are launched from plugin manifests, with user config controlling enabled state and tool policy.
- The manual says installed plugin changes require a fresh thread or restart before updated skills and MCP servers are available.
- Do not remove existing working tools or rename existing MCP tools.
- Prefer additive changes to existing tool contracts.
- Keep TokenGraph local-first and do not add mandatory cloud services or API keys.
- Respect `.gitignore`, avoid secrets, and keep token savings as estimates.
- Keep v0.9+ skill bundle, wiki, rules, root-cause tracing, memory lifecycle, SQLite, benchmarks, and release packaging out of this release.

---

### Task 1: Local Config Persistence

**Files:**
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/persistence.ts`
- Add: `plugins/tokengraph/src/core/config.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

- [ ] **Step 1: Write failing config default test**

Add a test that calls `loadTokenGraphConfig(root)` on a fresh temp root and expects:

```ts
{
  tokenSavingProfile: "balanced",
  maxFiles: 6,
  maxSqlObjects: 6,
  maxMemories: 4,
  maxPlannedContextTokens: 8000,
  rawReadWarningThreshold: 8000,
  sqlIndexingEnabled: true,
  memoryEnabled: true,
  wikiGenerationEnabled: false
}
```

Run: `pnpm test -- tests/core.test.ts -t "config"`

Expected: FAIL because `src/core/config.ts` does not exist.

- [ ] **Step 2: Implement config types and persistence**

Add `TokenGraphConfig`, `TokenGraphConfigUpdate`, `DEFAULT_TOKEN_GRAPH_CONFIG`, `PROFILE_DEFAULTS`, `loadTokenGraphConfig`, `saveTokenGraphConfig`, `setTokenSavingProfile`, and `updateTokenGraphConfig`. Store the file at `.tokengraph/config.json`.

- [ ] **Step 3: Verify config tests pass**

Run: `pnpm test -- tests/core.test.ts -t "config"`

Expected: PASS.

### Task 2: MCP Config Tools

**Files:**
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`
- Modify: `plugins/tokengraph/scripts/smoke.mjs`

- [ ] **Step 1: Write failing MCP config tool test**

Extend MCP smoke coverage to assert these tools are listed and callable:

```text
tokengraph_get_config
tokengraph_set_profile
tokengraph_update_config
```

Expected behavior:
- `get_config` returns defaults for a new project.
- `set_profile` changes only `tokenSavingProfile`.
- `update_config` changes explicit numeric and boolean settings while preserving unspecified defaults.

- [ ] **Step 2: Register MCP tools**

Use read-only annotations for `tokengraph_get_config`. Use write annotations for `tokengraph_set_profile` and `tokengraph_update_config`. Keep results compact JSON with structured content.

- [ ] **Step 3: Verify MCP focused tests**

Run: `pnpm test -- tests/mcp-smoke.test.ts -t "config"`

Expected: PASS.

### Task 3: Profile-Aware Context Planner

**Files:**
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/planner.ts`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

- [ ] **Step 1: Write failing planner profile tests**

Add tests showing conservative, balanced, and aggressive profiles produce different caps:

```ts
conservative: maxFiles 10, maxSqlObjects 10, maxMemories 6, firstReads 5, rawReadWarningThreshold 12000
balanced: maxFiles 6, maxSqlObjects 6, maxMemories 4, firstReads 3, rawReadWarningThreshold 8000
aggressive: maxFiles 3, maxSqlObjects 3, maxMemories 2, firstReads 2, rawReadWarningThreshold 4000
```

Add a test showing explicit planner arguments override profile defaults.

- [ ] **Step 2: Add planner budget resolution**

Extend `ContextPlanInput` and MCP schema with:

```ts
profile?: TokenSavingProfile;
maxEstimatedTokens?: number;
allowRawReads?: boolean;
```

Have the server resolve budgets from explicit arguments, selected profile, and persisted config. Have the planner trim context when estimated compact output exceeds `maxEstimatedTokens` and report exclusions as estimates.

- [ ] **Step 3: Verify planner tests**

Run: `pnpm test -- tests/core.test.ts -t "buildContextPlan"`

Expected: PASS.

### Task 4: Incremental Indexing

**Files:**
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/fileScanner.ts`
- Modify: `plugins/tokengraph/src/core/projectIndexer.ts`
- Modify: `plugins/tokengraph/src/core/indexStatus.ts`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

- [ ] **Step 1: Write failing incremental tests**

Add tests for:
- one changed TypeScript file updates its symbols and preserves unchanged file metadata;
- one deleted file removes file, symbols, imports, and SQL objects from the index;
- one changed SQL migration updates only that file's SQL objects;
- schema version mismatch falls back to a full reindex;
- stale index detection still reports fresh/stale correctly after v0.8 indexes.

- [ ] **Step 2: Add schema version and scan metadata**

Add a current index schema version and per-file scan metadata to newly written indexes. Treat missing or mismatched schema metadata as incompatible for incremental reuse.

- [ ] **Step 3: Implement incremental update**

Add `updateProjectIndexIncremental(root, existingIndex)` that:
- scans current file metadata;
- detects added, changed, and deleted indexed files;
- parses only added and changed files;
- preserves unchanged file, symbol, import, and SQL graph data;
- re-resolves imports after merge;
- recomputes frameworks, fingerprint, scan signature, and scanned timestamp.

- [ ] **Step 4: Wire MCP indexing**

Add `fullReindex?: boolean` to `tokengraph_index_project`. Default to incremental when a compatible existing index exists. Return an additive `indexingMode` field of `full` or `incremental`.

- [ ] **Step 5: Verify incremental tests**

Run: `pnpm test -- tests/core.test.ts -t "incremental"`

Expected: PASS.

### Task 5: Docs, Validator, Smoke, Release Metadata

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `plugins/tokengraph/README.md`
- Modify: `plugins/tokengraph/skills/tokengraph/SKILL.md`
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/scripts/smoke.mjs`

- [ ] **Step 1: Update docs**

Document v0.8, config file location, config tools, token-saving profiles, incremental indexing behavior, `fullReindex`, and that token counts are estimates.

- [ ] **Step 2: Update validator and smoke**

Require built output to include v0.8 config tools, profile-aware planner arguments, incremental indexing mode, and version `0.8.0`.

- [ ] **Step 3: Final verification**

Run from `plugins/tokengraph`:

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm smoke -- --root . --json
pnpm validate:plugin
```

Expected: all commands exit 0.
