# TokenGraph Phase 2 Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make line hints accurate, restore the incremental fast path after metadata-only changes, and serialize concurrent memory and project-index updates.

**Architecture:** Keep the existing scanner/indexer APIs, but make declaration-end detection balance closing delimiters, persist a semantically unchanged refreshed index, and place read-modify-write operations behind the existing queue patterns. Project indexing uses a per-resolved-root queue in `server.ts` so every `ensureProject` call observes the latest state before saving.

**Tech Stack:** TypeScript, Node.js, Vitest, JSON persistence, newline-delimited MCP smoke tests.

## Global Constraints

- Implement M1, M2, H3, and H4 only.
- Every behavior change starts with a failing regression test.
- Preserve the existing persisted schema and incremental API signatures.
- Never lose a concurrent memory link, confirmation, deprecation, or index change.
- Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke -- --root . --json`, and `pnpm validate:plugin` before publishing.

---

### Task 1: Correct declaration end-line hints (M1)

**Files:**

- Modify: `plugins/tokengraph/src/core/fileScanner.ts:156-171`
- Modify: `plugins/tokengraph/tests/core.test.ts`

**Interfaces:**

- Consumes: TypeScript/JavaScript declarations passed through `scanProject`.
- Produces: `CodeSymbol.endLine` ending at the declaration's closing `)` or `);`, while preserving brace-in-string behavior.

- [ ] **Step 1: Write the failing regression test**

```ts
it("ends an arrow declaration at its closing parenthesis", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "factory.ts"), [
    "export const makePatient = () => (",
    "  {",
    "    id: 'patient-1'",
    "  }",
    ");",
    "",
    "export const unrelated = true;"
  ].join("\n"));

  const graph = await scanProject(root);
  expect(graph.symbols.find((symbol) => symbol.name === "makePatient")).toMatchObject({ startLine: 1, endLine: 5 });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "closing parenthesis"`

Expected: FAIL because `declarationEndLine` currently stops only on `}` or `;` and reports the later declaration line.

- [ ] **Step 3: Implement the smallest terminal-line fix**

Update the terminal-line matcher in `declarationEndLine` to accept a closing parenthesis with optional semicolon while retaining the existing brace/string guard:

```ts
const terminalLine = /[};)]\s*;?\s*$/;
```

Keep the existing line-by-line balance logic and do not treat a parenthesis inside a quoted string as a declaration terminator.

- [ ] **Step 4: Verify the focused tests pass**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "closing parenthesis|braces appear in strings"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/fileScanner.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(scanner): stop declaration hints at closing parentheses"
```

### Task 2: Persist refreshed scan signatures (M2)

**Files:**

- Modify: `plugins/tokengraph/src/server.ts:133-151`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

**Interfaces:**

- Consumes: `updateProjectIndexIncremental(root, existing)` results whose fingerprint is unchanged but `scanSignature` is refreshed.
- Produces: `ensureProject(root)` saving the refreshed `ProjectIndex` and returning it instead of returning stale metadata.

- [ ] **Step 1: Write the failing metadata-only freshness test**

```ts
it("persists a refreshed scan signature after a metadata-only change", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "src"), { recursive: true });
  const file = join(root, "src", "stable.ts");
  await writeFile(file, "export const stable = true;\n");
  await request(70, "tools/call", { name: "tokengraph_index_project", arguments: { root } });
  const before = JSON.parse(await readFile(join(root, ".tokengraph", "index.json"), "utf8"));

  const original = await readFile(file, "utf8");
  await writeFile(file, original);
  await request(71, "tools/call", { name: "tokengraph_project_map", arguments: { root } });
  const after = JSON.parse(await readFile(join(root, ".tokengraph", "index.json"), "utf8"));

  expect(after.fingerprint).toBe(before.fingerprint);
  expect(after.scanSignature).not.toBe(before.scanSignature);
  const status = await request(72, "tools/call", { name: "tokengraph_index_status", arguments: { root } });
  expect(status.structuredContent).toMatchObject({ state: "fresh" });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "metadata-only change"`

Expected: FAIL because `ensureProject` returns `existing` without saving `current` when the semantic fingerprint is unchanged.

- [ ] **Step 3: Save the refreshed index metadata**

Replace the unchanged branch in `ensureProject`:

```ts
if (isFreshProjectIndex(existing, current)) {
  await saveProjectIndex(root, current);
  return current;
}
```

- [ ] **Step 4: Verify the focused test passes**

Run: `pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "metadata-only change"`

Expected: PASS with equal fingerprints and a fresh persisted scan signature.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/server.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "fix(index): persist refreshed scan metadata"
```

### Task 3: Make memory lifecycle mutations atomic (H3)

**Files:**

- Modify: `plugins/tokengraph/src/core/memoryStore.ts:145-211`
- Modify: `plugins/tokengraph/tests/core.test.ts:1591-1766`

**Interfaces:**

- Consumes: `MemoryStore.deprecate`, `confirm`, and `link` calls.
- Produces: a private `mutate(id, transform)` read-modify-write helper that runs entirely inside `enqueueWrite`.

- [ ] **Step 1: Write the failing concurrent-link test**

```ts
it("preserves links from concurrent link calls", async () => {
  const root = await makeRoot();
  const store = new MemoryStore(memoryPath(root));
  const memory = await store.add({ type: "architecture", title: "Keep links", body: "Keep all links.", tags: [] });

  await Promise.all([
    store.link(memory.id, { linkedFiles: ["src/first.ts"] }),
    store.link(memory.id, { linkedFiles: ["src/second.ts"] })
  ]);

  await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: memory.id, linkedFiles: expect.arrayContaining(["src/first.ts", "src/second.ts"]) })]);
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "concurrent link calls"`

Expected: FAIL because one link overwrites the other.

- [ ] **Step 3: Implement the atomic mutation helper**

Add:

```ts
private async mutate(id: string, transform: (memory: MemoryEntry) => MemoryEntry): Promise<MemoryEntry | undefined> {
  return this.enqueueWrite(async () => {
    const memories = await this.readAll();
    const index = memories.findIndex((memory) => memory.id === id);
    if (index === -1) return undefined;
    const next = transform(memories[index]);
    memories[index] = next;
    await this.writeAtomic(memories);
    return next;
  });
}
```

Refactor `deprecate`, `confirm`, and `link` so each calls `mutate` and computes unique arrays from the fresh memory passed to `transform`. Keep `update` and `delete` behavior unchanged.

- [ ] **Step 4: Add confirm/deprecate concurrency coverage and run tests**

Add a `Promise.all` test for `confirm` with different evidence and a `Promise.all` test for `deprecate` with different `supersededBy` IDs. Run: `pnpm vitest run tests/core.test.ts --testNamePattern "concurrent|lifecycle"`.

Expected: PASS; all evidence and supersession IDs survive.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/memoryStore.ts plugins/tokengraph/tests/core.test.ts
git commit -m "fix(memory): serialize lifecycle read-modify-write operations"
```

### Task 4: Serialize concurrent project-index writes (H4)

**Files:**

- Modify: `plugins/tokengraph/src/server.ts:133-151`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

**Interfaces:**

- Consumes: all callers of `ensureProject(root)`.
- Produces: a per-resolved-root `enqueueProjectWrite(root, operation)` queue around scan, load, diff, and save.

- [ ] **Step 1: Write the failing overlapping-index test**

```ts
it("serializes overlapping index operations for one project", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "first.ts"), "export const first = true;\n");
  await request(80, "tools/call", { name: "tokengraph_index_project", arguments: { root } });
  await writeFile(join(root, "src", "second.ts"), "export const second = true;\n");

  const [first, second] = await Promise.all([
    request(81, "tools/call", { name: "tokengraph_project_map", arguments: { root } }),
    request(82, "tools/call", { name: "tokengraph_index_status", arguments: { root } })
  ]);

  expect(first.isError).not.toBe(true);
  expect(second.isError).not.toBe(true);
  const final = await request(83, "tools/call", { name: "tokengraph_project_map", arguments: { root } });
  expect(final.structuredContent).toMatchObject({ counts: { files: 2 } });
});
```

- [ ] **Step 2: Verify the test fails or reproduces a dropped update**

Run: `pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "overlapping index operations"`

Expected: FAIL intermittently or report only one indexed source file on the final map.

- [ ] **Step 3: Add a per-root write queue around `ensureProject`**

```ts
const projectWriteChains = new Map<string, Promise<void>>();

async function enqueueProjectWrite<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = projectWriteChains.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  projectWriteChains.set(key, current.then(() => undefined, () => undefined));
  return current;
}
```

Move the complete body of `ensureProject` into `enqueueProjectWrite(root, async () => { ... })`. Do not queue only the final file write; the load, scan, incremental diff, and save must share one serialized operation.

- [ ] **Step 4: Run the focused test repeatedly**

Run: `1..10 | ForEach-Object { pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "overlapping index operations" }`

Expected: ten passing runs with two final indexed files every time.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/server.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "fix(index): serialize concurrent project updates"
```

### Task 5: Verify and publish Phase 2

- [ ] **Step 1: Run the complete gate**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
```

- [ ] **Step 2: Scan changed files for non-ASCII characters**

```powershell
git diff --name-only main...HEAD | ForEach-Object { if (Select-String -LiteralPath $_ -Pattern '[^\x00-\x7F]' -Quiet) { throw "non-ASCII: $_" } }
```

- [ ] **Step 3: Push and open the Phase 2 PR**

```bash
git push -u origin codex/tokengraph-phase2-indexing
gh pr create --repo Mujadarah/TokenGraph --base codex/tokengraph-phase1-security --head codex/tokengraph-phase2-indexing --title "fix: make TokenGraph indexing updates atomic" --body "Implements M1, M2, H3, and H4 with regression coverage."
```
