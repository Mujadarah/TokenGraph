# TokenGraph Phase 4 Honesty and Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tool metadata, shipped documentation, validation coverage, and low-severity accounting/parser behavior match what TokenGraph actually does.

**Architecture:** Keep the current MCP APIs and persistence formats additive where possible. Correct annotations at registration sites, derive README coverage from the built registration source, preserve project-wide findings explicitly, and use small deterministic heuristics for byte limits, token estimates, symlink visibility, and memory conflict matching.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, JavaScript plugin validator, generated release packaging.

## Global Constraints

- Implement Phase 4 findings H2, H5, M8, M9, L1, L2, L3, L4, L5, and L6 only.
- Every behavior change starts with a failing regression test or validator assertion.
- Do not hide writes behind read-only annotations; any tool that can call `ensureProject` must advertise `readOnlyHint: false`.
- Keep generated `release/tokengraph` synchronized by running the package script after source README or validator changes.
- Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke -- --root . --json`, and `pnpm validate:plugin` before publishing.

---

### Task 1: Correct write-capable MCP annotations (H2)

**Files:**

- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

**Interfaces:**

- Consumes: the registered MCP tool metadata returned by `tools/list`.
- Produces: `readOnlyHint: false` for every tool that can call `ensureProject` and therefore save an index.

- [ ] **Step 1: Write the failing annotation test**

Extend the tool-list smoke test to map `tool.annotations.readOnlyHint` by name and assert these tools are not read-only: `tokengraph_check_architecture`, `tokengraph_trace_failure`, `tokengraph_assess_change_risk`, `tokengraph_project_map`, `tokengraph_plan_context`, `tokengraph_search_graph`, `tokengraph_explain_symbol`, `tokengraph_summarize_sql`, `tokengraph_compress_context`, `tokengraph_export_project_map`, and `tokengraph_show_token_savings`.

- [ ] **Step 2: Verify it fails**

Run: `pnpm build; pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "tool metadata|lists tools"`

Expected: FAIL because those registrations currently advertise `readOnlyHint: true`.

- [ ] **Step 3: Set truthful annotations**

Change only the listed registrations to `readOnlyHint: false`; preserve their `idempotentHint` values and all other tool metadata.

- [ ] **Step 4: Verify it passes**

Run: `pnpm build; pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "tool metadata|lists tools"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/server.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "fix(mcp): mark index-writing tools as non-read-only"
```

### Task 2: Keep all tools documented and validator-enforced (H5)

**Files:**

- Modify: `plugins/tokengraph/README.md`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/tests/cli-smoke.test.ts`
- Regenerate: `release/tokengraph/README.md` via `pnpm package:plugin -- --release`

**Interfaces:**

- Consumes: `server.registerTool("tokengraph_..."` registrations and plugin README content.
- Produces: validator failure when any registered tool is absent from the source README; all 33 tools documented.

- [ ] **Step 1: Write the failing validator test**

Add a CLI smoke test that reads the source README and asserts the eight previously missing names are present: `tokengraph_compress_output`, `tokengraph_explain_symbol`, `tokengraph_plan_context`, `tokengraph_project_map`, `tokengraph_remember_decision`, `tokengraph_search_graph`, `tokengraph_show_token_savings`, and `tokengraph_summarize_sql`.

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/cli-smoke.test.ts --testNamePattern "README tool coverage"`

Expected: FAIL because the source plugin README omits those names.

- [ ] **Step 3: Document and validate every registration**

Add the eight tool names to the appropriate README feature bullets. In `validate-plugin.mjs`, extract registered names from `dist/server.js` and assert each appears as a backtick-delimited name in `sourceReadme`; fail with the missing name. Keep the existing release checks intact.

- [ ] **Step 4: Regenerate release docs and verify**

Run: `pnpm build; pnpm package:plugin -- --release; pnpm validate:plugin; pnpm vitest run tests/cli-smoke.test.ts --testNamePattern "README tool coverage"`

Expected: PASS, with source and release READMEs containing the same tool names.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/README.md plugins/tokengraph/scripts/validate-plugin.mjs plugins/tokengraph/tests/cli-smoke.test.ts release/tokengraph/README.md
git commit -m "docs(plugin): validate complete MCP tool coverage"
```

### Task 3: Preserve project-wide findings and broaden privacy scanning (M8/M9)

**Files:**

- Modify: `plugins/tokengraph/src/core/regressionRisk.ts`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: architecture findings with no changed-file path and all files copied by `package-plugin.mjs`.
- Produces: project-wide marketplace findings in risk reports and personal-path protection across every packaged text file.

- [ ] **Step 1: Write failing tests**

Add a change-risk test with a marketplace-target architecture warning and an unrelated changed file; assert the finding remains in `affectedRules`. Add a validator test fixture or direct helper invocation that places a personal `C:\\Users\\rabia\\...` path in a packaged skill/doc and expects validation failure.

- [ ] **Step 2: Verify both tests fail**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "project-wide|marketplace"` and `pnpm vitest run tests/cli-smoke.test.ts --testNamePattern "personal path"`.

Expected: the risk report drops the project-wide finding and the validator only scans its current three README strings.

- [ ] **Step 3: Implement project-wide retention and package-file scanning**

In `filterRuleFindings`, retain findings with neither `filePath` nor `targetPath` when they carry `sourcePath` or represent a project-wide warning. In the validator, enumerate the same source/release files copied by `package-plugin.mjs` and apply the personal Windows profile regex to each text file, including skills and docs.

- [ ] **Step 4: Verify focused coverage**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "project-wide|marketplace"; pnpm validate:plugin; pnpm vitest run tests/cli-smoke.test.ts --testNamePattern "personal path"`.

Expected: PASS and no personal path in the current packaged tree.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/regressionRisk.ts plugins/tokengraph/scripts/validate-plugin.mjs plugins/tokengraph/tests/core.test.ts plugins/tokengraph/tests/cli-smoke.test.ts
git commit -m "fix(validation): retain project findings and scan packaged paths"
```

### Task 4: Correct byte, SQL column, and lifecycle metadata semantics (L1/L2/L3)

**Files:**

- Modify: `plugins/tokengraph/src/core/compressor.ts`
- Modify: `plugins/tokengraph/src/core/sqlParser.ts`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: Unicode compressor input, quoted SQL column definitions, and recall tool annotations.
- Produces: a correctly named character cap, intact quoted column tokens, and non-idempotent recall metadata.

- [ ] **Step 1: Write failing tests**

Add tests that (a) assert the compressor source names its current `text.length` cap as characters, (b) parse `create table public.notes (\"Display Name\" text);` and expect the full quoted column token, and (c) read `tools/list` and assert `tokengraph_recall_memory.annotations.idempotentHint` is false.

- [ ] **Step 2: Verify they fail**

Run: `pnpm build; pnpm vitest run tests/core.test.ts --testNamePattern "quoted column|compressor cap"; pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "recall metadata"`.

Expected: the quoted column is truncated, the cap name says bytes, and recall is marked idempotent.

- [ ] **Step 3: Implement minimal corrections**

Rename `MAX_INPUT_BYTES` to `MAX_INPUT_CHARS` and update the truncation variable names. Parse a leading double-quoted column token until its closing quote before reading the type. Set recall’s `idempotentHint` to false while keeping `readOnlyHint: false`.

- [ ] **Step 4: Verify focused tests**

Run: `pnpm build; pnpm vitest run tests/core.test.ts --testNamePattern "quoted column|compressor cap"; pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "recall metadata"`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/compressor.ts plugins/tokengraph/src/core/sqlParser.ts plugins/tokengraph/src/server.ts plugins/tokengraph/tests/core.test.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "fix: correct compressor, SQL column, and recall metadata"
```

### Task 5: Improve symlink visibility, Unicode token estimates, and conflict precision (L4/L5/L6)

**Files:**

- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/fileScanner.ts`
- Modify: `plugins/tokengraph/src/core/token.ts`
- Modify: `plugins/tokengraph/src/core/memoryStore.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: symlink directory entries, Unicode text, and memory candidates.
- Produces: explicit `symlink` exclusions, script-aware token estimates, and conflict overlap that excludes memory type from matched terms.

- [ ] **Step 1: Write failing tests**

Add tests asserting `estimateTokens("患者患者") >= 4` and `estimateTokens("🙂🙂") >= 2`, and add two same-type memories sharing only one body term; assert `findConflicts` returns no conflict. For symlinks, create a temporary symlink where the platform permits it and assert the exclusion reason is `symlink`; skip only when the OS denies symlink creation.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "Unicode|same-type|symlink"`.

Expected: the current heuristic undercounts dense scripts, same-type overlap over-fires, and symlinks disappear without an exclusion.

- [ ] **Step 3: Implement the corrections**

Add `symlink` to `Exclusion["reason"]` and record it in both scan passes before directory/file handling. Count CJK/script-heavy code points and extended pictographic code points as approximately one token each, with the existing four-character estimate for remaining text. Build conflict terms from title/body/tags rather than including the memory type, while retaining same-type filtering.

- [ ] **Step 4: Verify focused coverage**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "Unicode|same-type|symlink"`.

Expected: PASS (or the symlink case is explicitly skipped only for a permission-denied platform).

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/types.ts plugins/tokengraph/src/core/fileScanner.ts plugins/tokengraph/src/core/token.ts plugins/tokengraph/src/core/memoryStore.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix: improve Unicode estimates and memory conflict precision"
```

### Task 6: Verify and publish Phase 4

- [ ] **Step 1: Run the complete gate**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
```

- [ ] **Step 2: Scan phase-specific changed files for non-ASCII characters**

```powershell
git diff --name-only codex/tokengraph-phase3-sql-scanning...HEAD | ForEach-Object { if (Select-String -LiteralPath $_ -Pattern '[^\\x00-\\x7F]' -Quiet) { throw "non-ASCII: $_" } }
```

- [ ] **Step 3: Push and open the Phase 4 PR**

```bash
git push -u origin codex/tokengraph-phase4-hygiene
gh pr create --repo Mujadarah/TokenGraph --base codex/tokengraph-phase3-sql-scanning --head codex/tokengraph-phase4-hygiene --title "fix: improve TokenGraph honesty and hygiene" --body "Implements Phase 4 findings H2, H5, M8, M9, L1, L2, L3, L4, L5, and L6 with regression coverage."
```
