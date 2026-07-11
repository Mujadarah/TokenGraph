# TokenGraph Phase 3 SQL and Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SQL parsing and project scanning faithful on malformed SQL, mixed-case identifiers, nested ignore rules, route layouts, and Windows line endings.

**Architecture:** Preserve the existing scanner and SQL graph APIs while adding explicit SQL parse warnings, scoped `.gitignore` matchers, canonical content hashing, and page-only App Router route metadata. Bump the persisted index schema when the SQL graph shape changes so stale indexes reindex safely.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, `ignore`, JSON persistence, newline-delimited MCP smoke tests.

## Global Constraints

- Implement Phase 3 findings H1, M4, M5, M6, and M7 only.
- Every behavior change starts with a failing regression test.
- Preserve existing tool response shapes except for additive SQL warning data.
- Keep route and ignore behavior deterministic across Windows and POSIX path separators.
- Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke -- --root . --json`, and `pnpm validate:plugin` before publishing.

---

### Task 1: Surface malformed SQL parser warnings (H1)

**Files:**

- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/src/core/sqlParser.ts`
- Modify: `plugins/tokengraph/src/core/projectIndexer.ts`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: SQL text passed to `parsePostgresMigration(filePath, sql)`.
- Produces: `SqlGraph.warnings: SqlParseWarning[]`, merged and persisted with project indexes and exposed in the project-map database summary.

- [ ] **Step 1: Write failing malformed-SQL tests**

Add tests covering a mismatched dollar quote and an unterminated single-quoted string. Each test must assert a warning identifies the file and parser state, and that a later table is not silently presented as parsed data:

```ts
it("reports a case-mismatched dollar quote instead of silently dropping later SQL", () => {
  const graph = parsePostgresMigration(
    "supabase/migrations/003_malformed.sql",
    [
      "create function public.bad() returns void as $FUNC$",
      "begin",
      "  perform 1;",
      "end;",
      "$func$;",
      "create table public.after_bad (id uuid primary key);"
    ].join("\\n")
  );

  expect(graph.warnings).toEqual([
    expect.objectContaining({ filePath: "supabase/migrations/003_malformed.sql", message: expect.stringMatching(/dollar/i) })
  ]);
  expect(graph.tables).toEqual([]);
});

it("reports an unterminated SQL string", () => {
  const graph = parsePostgresMigration(
    "supabase/migrations/004_unterminated.sql",
    [
      "insert into public.seed_notes (body) values ('unfinished);",
      "create table public.after_bad (id uuid primary key);"
    ].join("\\n")
  );

  expect(graph.warnings).toEqual([
    expect.objectContaining({ filePath: "supabase/migrations/004_unterminated.sql", message: expect.stringMatching(/single-quoted/i) })
  ]);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "mismatched dollar|unterminated SQL"`

Expected: FAIL because `SqlGraph` has no warnings and the statement scanner does not report its terminal state.

- [ ] **Step 3: Add warning data and terminal-state detection**

Add:

```ts
export interface SqlParseWarning {
  filePath: string;
  message: string;
}

export interface SqlGraph {
  tables: SqlTable[];
  relations: SqlRelation[];
  constraints: SqlConstraint[];
  policies: SqlPolicy[];
  indexes: SqlIndex[];
  triggers: SqlTrigger[];
  functions: SqlFunction[];
  views: SqlView[];
  enums: SqlEnum[];
  extensions: SqlExtension[];
  grants: SqlGrant[];
  materializedViews: SqlMaterializedView[];
  history: SqlHistoryEntry[];
  warnings: SqlParseWarning[];
}
```

Change `sqlStatements` to return `{ statements, warningMessage?: string }`. After the scan loop, map `state === "dollar"` to a dollar-quote warning and `state === "single"` or `state === "double"` to an unterminated string warning. `parsePostgresMigration` should append `{ filePath, message }` to the graph. Include warnings in `emptyGraph` and `mergeSqlGraphs`, filter them by file in `sqlGraphForFiles`, and bump `CURRENT_INDEX_SCHEMA_VERSION` from `2` to `3`.

Expose `project.sql.warnings` as `database.warnings` in `projectMap` so index and map responses carry the warning without changing existing fields.

- [ ] **Step 4: Verify focused SQL tests pass**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "mismatched dollar|unterminated SQL|parsePostgresMigration"`

Expected: PASS, including the existing SQL parser coverage.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/types.ts plugins/tokengraph/src/core/sqlParser.ts plugins/tokengraph/src/core/projectIndexer.ts plugins/tokengraph/src/server.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(sql): surface malformed migration warnings"
```

### Task 2: Normalize SQL identifier case without changing quoted names (M4)

**Files:**

- Modify: `plugins/tokengraph/src/core/sqlParser.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: SQL identifiers from tables, policies, constraints, indexes, functions, views, grants, and relations.
- Produces: lower-case unquoted identifiers while preserving the case and spaces of double-quoted identifiers.

- [ ] **Step 1: Write the failing identifier-case test**

```ts
it("folds unquoted SQL identifiers but preserves quoted identifiers", () => {
  const graph = parsePostgresMigration(
    "supabase/migrations/005_case.sql",
    [
      "create table PUBLIC.Patients (ID uuid primary key);",
      "create policy read_patients on public.PATIENTS for select using (true);",
        "create table public.\"PatientNotes\" (\"DisplayName\" text);"
    ].join("\\n")
  );

  expect(graph.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "public.patients", columns: ["id"] }),
      expect.objectContaining({ name: "public.PatientNotes", columns: ["DisplayName"] })
    ])
  );
  expect(graph.policies).toEqual(expect.arrayContaining([expect.objectContaining({ table: "public.patients" })]));
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "folds unquoted SQL identifiers"`

Expected: FAIL because the current normalizer strips quotes but preserves unquoted case and truncates quoted names containing spaces when parsing columns.

- [ ] **Step 3: Implement quote-aware identifier normalization**

Replace `normalizeSqlName` with a quote-aware segment scanner that splits on dots only outside double quotes. For each segment, preserve a quoted identifier after unescaping doubled quotes; otherwise remove accidental quote characters and lower-case the segment. Add a separate first-token parser for table columns so a leading quoted column name containing spaces remains intact.

- [ ] **Step 4: Run focused SQL tests**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "folds unquoted SQL identifiers|parsePostgresMigration"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/sqlParser.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(sql): normalize unquoted identifier case"
```

### Task 3: Apply nested gitignore rules during both scan passes (M5)

**Files:**

- Modify: `plugins/tokengraph/src/core/fileScanner.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: root and nested `.gitignore` files while walking a project.
- Produces: identical ignore decisions and exclusions for full graph scans and metadata/signature scans.

- [ ] **Step 1: Write the failing nested-ignore test**

```ts
it("honors nested gitignore files", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "src", "generated"), { recursive: true });
  await writeFile(join(root, "src", ".gitignore"), "generated/\\n");
  await writeFile(join(root, "src", "generated", "client.ts"), "export const generated = true;\\n");
  await writeFile(join(root, "src", "real.ts"), "export const real = true;\\n");

  const graph = await scanProject(root);

  expect(graph.files.map((file) => file.path)).toEqual(["src/real.ts"]);
  expect(graph.exclusions).toContainEqual(expect.objectContaining({ path: "src/generated", reason: "ignored" }));
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "nested gitignore"`

Expected: FAIL because only the root `.gitignore` is loaded.

- [ ] **Step 3: Add scoped ignore matchers**

Introduce an ignore scope `{ base: string; matcher: Ignore }`. Load the root matcher once, load each directory's `.gitignore` before walking its entries, and evaluate every entry against each ancestor matcher using a path relative to that matcher base. Thread the same scopes through `walk` and `walkSignature`; preserve deterministic sorting and existing exclusion reasons.

- [ ] **Step 4: Verify full and metadata scans agree**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "nested gitignore|scanProjectSignature|incremental"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/fileScanner.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(scanner): honor nested gitignore rules"
```

### Task 4: Remove App Router layout duplicates from routes (M6)

**Files:**

- Modify: `plugins/tokengraph/src/core/fileScanner.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: App Router `page`, `route`, and `layout` filenames.
- Produces: route metadata only for endpoint files (`page` and `route`), while layouts remain indexed as ordinary modules.

- [ ] **Step 1: Write the failing route test**

```ts
it("does not expose App Router layouts as duplicate routes", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "app", "patients"), { recursive: true });
  await writeFile(join(root, "app", "patients", "layout.tsx"), "export default function Layout({ children }: { children: unknown }) { return children; }\\n");
  await writeFile(join(root, "app", "patients", "page.tsx"), "export default function Page() { return null; }\\n");

  const graph = await scanProject(root);
  const layout = graph.files.find((file) => file.path.endsWith("/layout.tsx"));
  const page = graph.files.find((file) => file.path.endsWith("/page.tsx"));

  expect(layout?.kind).not.toBe("next-route");
  expect(layout?.route).toBeUndefined();
  expect(page).toMatchObject({ kind: "next-route", route: "/patients" });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "layouts as duplicate routes"`

Expected: FAIL because `layout.tsx` currently receives the same route metadata as `page.tsx`.

- [ ] **Step 3: Restrict route detection to endpoint files**

Update `nextRouteForPath` so App Router files match only `page` and `route`. Keep route-file metadata and existing Pages Router behavior unchanged.

- [ ] **Step 4: Verify route and wiki coverage**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "layouts as duplicate routes|project wiki|routes"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/fileScanner.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(routes): exclude App Router layouts from route hints"
```

### Task 5: Canonicalize line endings for content hashes (M7)

**Files:**

- Modify: `plugins/tokengraph/src/core/fileScanner.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: UTF-8 file content using LF, CRLF, or CR line endings.
- Produces: identical `CodeFile.contentHash` and metadata `contentHash` for equivalent logical content.

- [ ] **Step 1: Write the failing line-ending test**

```ts
it("keeps content hashes stable across line endings", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "src"), { recursive: true });
  const file = join(root, "src", "line-endings.ts");
  await writeFile(file, "export const value = 1;\\nexport const other = 2;\\n");
  const lf = await scanProject(root);

  await writeFile(file, "export const value = 1;\\r\\nexport const other = 2;\\r\\n");
  const crlf = await scanProject(root);

  expect(crlf.files.find((entry) => entry.path === "src/line-endings.ts")?.contentHash).toBe(
    lf.files.find((entry) => entry.path === "src/line-endings.ts")?.contentHash
  );
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "line endings"`

Expected: FAIL because `hashText` currently hashes raw line endings.

- [ ] **Step 3: Hash canonical content**

Normalize `\\r\\n` and lone `\\r` to `\\n` inside the shared `hashText` helper. Keep file size and raw content available for existing token estimates; only semantic content hashes and scan signatures should canonicalize line endings. Update `metadataChanged` to use the canonical content hash and format metadata rather than raw size or timestamp fields, so equivalent line endings do not trigger reparsing.

- [ ] **Step 4: Run Phase 3 focused tests**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "line endings|nested gitignore|layouts as duplicate routes|folds unquoted SQL identifiers|mismatched dollar|unterminated SQL"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/fileScanner.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(scanner): canonicalize line endings in content hashes"
```

### Task 6: Verify and publish Phase 3

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
git diff --name-only codex/tokengraph-phase2-indexing...HEAD | ForEach-Object { if (Select-String -LiteralPath $_ -Pattern '[^\\x00-\\x7F]' -Quiet) { throw "non-ASCII: $_" } }
```

- [ ] **Step 3: Push and open the Phase 3 PR**

```bash
git push -u origin codex/tokengraph-phase3-sql-scanning
gh pr create --repo Mujadarah/TokenGraph --base codex/tokengraph-phase2-indexing --head codex/tokengraph-phase3-sql-scanning --title "fix: improve SQL and scanning fidelity" --body "Implements Phase 3 findings H1, M4, M5, M6, and M7 with regression coverage."
```
