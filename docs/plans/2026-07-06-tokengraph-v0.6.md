# TokenGraph v0.6 Developer Experience Implementation Plan

> **For agentic workers:** Use test-driven development for behavior changes. Keep the release focused on local validation, regression fixtures, and install/troubleshooting guidance.

**Goal:** Make TokenGraph easier to validate, install, and troubleshoot outside a live Codex thread while preserving the existing MCP tool contracts.

**Architecture:** Keep the MCP server as a local stdio Node.js process. Add a standalone smoke script that drives the built MCP entry point over JSON-RPC, fixture projects that exercise scanner/planner behavior, and documentation for local marketplace setup and common failure modes.

**Tech Stack:** Codex plugin manifest, MCP TypeScript SDK server package, Node.js, TypeScript, Vitest, Zod, local JSON persistence.

---

### Task 1: CLI Smoke Command

**Files:**
- Add: `plugins/tokengraph/tests/cli-smoke.test.ts`
- Add: `plugins/tokengraph/scripts/smoke.mjs`
- Modify: `plugins/tokengraph/package.json`

- [x] **Step 1: Write failing CLI smoke test**

Add a test that runs `node scripts/smoke.mjs --root <fixture> --json` and expects a structured success report from the built stdio MCP server.

- [x] **Step 2: Run targeted tests to verify failure**

Run: `pnpm test -- tests/core.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because `scripts/smoke.mjs` does not exist.

- [x] **Step 3: Implement the smoke command**

Add a standalone JSON-RPC stdio client script that spawns `dist/index.js`, initializes MCP, lists tools, calls project status/map/planner/token-savings tools, and reports actionable failures.

- [x] **Step 4: Run targeted tests to verify pass**

Run: `pnpm test -- tests/core.test.ts tests/cli-smoke.test.ts`

Expected: PASS.

### Task 2: Fixture Regression Projects

**Files:**
- Add: `plugins/tokengraph/tests/fixtures/next-supabase/**`
- Add: `plugins/tokengraph/tests/fixtures/ignored-output/**`
- Modify: `plugins/tokengraph/tests/core.test.ts`

- [x] **Step 1: Add reusable fixture projects**

Create one Next.js/Supabase fixture and one ignored-output fixture for scanner and planner regression coverage.

- [x] **Step 2: Add fixture-backed tests**

Assert the scanner resolves routes/imports and respects ignored generated output. Assert the planner selects the route, service, test, RLS policy, and materialized view for a patient summary task.

- [x] **Step 3: Run targeted tests**

Run: `pnpm test -- tests/core.test.ts tests/cli-smoke.test.ts`

Expected: PASS.

### Task 3: Installation And Troubleshooting Documentation

**Files:**
- Modify: `README.md`
- Modify: `plugins/tokengraph/README.md`
- Modify: `ROADMAP.md`

- [x] **Step 1: Document local validation**

Document `pnpm smoke -- --root <project>` as the validation path after `pnpm build`.

- [x] **Step 2: Document local marketplace install**

Document repo-local marketplace setup, rebuild/restart expectations, and plugin install notes.

- [x] **Step 3: Document troubleshooting**

Cover missing MCP tools, stale indexes, plugin build failures, marketplace visibility, and smoke command failures.

### Task 4: Version, Validation, And Release Check

**Files:**
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/.codex-plugin/plugin.json`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [x] **Step 1: Update version metadata**

Set package, plugin manifest, and MCP server version to `0.6.0`.

- [x] **Step 2: Extend validator**

Have `validate-plugin.mjs` check for the smoke script, package script, fixture directories, and v0.6 built output/version metadata.

- [x] **Step 3: Final verification**

Run:

```powershell
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
```

Expected: all commands exit 0.
