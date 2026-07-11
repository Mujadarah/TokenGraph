# TokenGraph Phase 1 Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the C1 workspace escape and C2 catastrophic-regex denial of service without breaking trusted project indexing.

**Architecture:** Tools resolve roots only from a host-controlled workspace: `CLAUDE_PROJECT_DIR`, `TOKENGRAPH_WORKSPACE_ROOT`, or an MCP Roots response. Architecture rule writes validate every pattern in a bounded worker before JSON persistence.

**Tech Stack:** TypeScript, Node.js worker threads, MCP SDK, Zod v4, Vitest, newline-delimited JSON-RPC.

## Global Constraints

- Implement C1 and C2 only; do not include later-plan changes.
- Never accept a tool's `root` argument as the allowed workspace boundary.
- Reject filesystem roots and the user's home directory as trusted workspaces.
- Reject unsafe rules before they are written to `.tokengraph/rules.json`.
- Run typecheck, tests, build, smoke, validator, and a changed-file non-ASCII scan before opening the pull request.

---

### Task 1: Prove and close the workspace escape

**Files:**

- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts:14-82,1019-1078`
- Modify: `plugins/tokengraph/src/server.ts:1-104,353-368`
- Modify: `plugins/tokengraph/src/index.ts:1-6`

**Interfaces:**

- Consumes: `CLAUDE_PROJECT_DIR`, `TOKENGRAPH_WORKSPACE_ROOT`, and `McpServer.server.listRoots()`.
- Produces: `createTokenGraphServer(options?: { trustedWorkspace?: () => Promise<string | undefined> }): McpServer`.

- [ ] **Step 1: Write failing JSON-RPC boundary tests**

```ts
function startServer(cwd = process.cwd(), env: NodeJS.ProcessEnv = {}) {
  server = spawn(process.execPath, [serverEntry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

it("rejects an outside root from a plugin-root launch", async () => {
  const workspace = await makeRoot();
  const outside = await makeRoot();
  await stopServer();
  startServer(process.cwd(), { TOKENGRAPH_WORKSPACE_ROOT: workspace });
  await initialize();
  const result = await request(61, "tools/call", {
    name: "tokengraph_index_project",
    arguments: { root: outside }
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toMatch(/outside the trusted workspace/i);
  await expect(access(join(outside, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed without a trusted host workspace", async () => {
  await stopServer();
  startServer(process.cwd(), { TOKENGRAPH_WORKSPACE_ROOT: "", CLAUDE_PROJECT_DIR: "" });
  await initialize();
  const result = await request(62, "tools/call", { name: "tokengraph_project_map", arguments: { root: await makeRoot() } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toMatch(/trusted workspace root/i);
});
```

- [ ] **Step 2: Verify the tests fail for the expected insecure behavior**

Run: `pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "outside root|trusted host workspace"`

Expected: FAIL because the current plugin-root launch accepts arbitrary explicit roots.

- [ ] **Step 3: Implement the fail-closed resolver**

```ts
function createWorkspaceResolver(server: McpServer, provider?: () => Promise<string | undefined>) {
  return async (inputRoot?: string): Promise<string> => {
    const cwd = await realpath(process.cwd());
    const configured = await (provider?.() ?? resolveTrustedWorkspace(server));
    const allowed = configured ? await realpath(configured) : await isPluginRoot(cwd) ? undefined : cwd;
    if (!allowed) throw new Error("TokenGraph needs a trusted workspace root from the host before it can access project files.");
    if (allowed === parse(allowed).root || allowed === homedir()) throw new Error("TokenGraph refuses filesystem and home directories as workspace roots.");
    const resolved = await realpath(inputRoot?.trim() ? resolve(allowed, inputRoot.trim()) : allowed);
    const relation = relative(allowed, resolved);
    if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Requested root is outside the trusted workspace: ${resolved}`);
    return resolved;
  };
}
```

Implement `resolveTrustedWorkspace` with environment precedence (`CLAUDE_PROJECT_DIR`, then `TOKENGRAPH_WORKSPACE_ROOT`) and an `await server.server.listRoots({}, { timeout: 1000 })` fallback. Update `isPluginRoot` to recognize both `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`, so a Claude plugin-cache launch also fails closed. Create the resolver after constructing `McpServer`, pass it through every existing tool handler, and update `root` parameter descriptions.

- [ ] **Step 4: Verify the focused tests pass**

Run: `pnpm vitest run tests/mcp-smoke.test.ts --testNamePattern "outside root|trusted host workspace"`

Expected: PASS, and no outside `.tokengraph` directory exists.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/server.ts plugins/tokengraph/src/index.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "fix(server): confine tool roots to trusted workspace"
```

### Task 2: Reject catastrophic architecture patterns before persistence

**Files:**

- Create: `plugins/tokengraph/src/core/patternSafety.ts`
- Modify: `plugins/tokengraph/src/core/architectureRules.ts:1-103`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts:259-328`

**Interfaces:**

- Produces: `assertSafeArchitectureRulePatterns(input: Partial<ArchitectureRuleInput>): Promise<void>`.
- Consumes: rule pattern fields before `ArchitectureRuleStore.add` and `ArchitectureRuleStore.update` call `writeAtomic`.

- [ ] **Step 1: Write failing storage tests**

```ts
it("refuses a catastrophic architecture rule before it is persisted", async () => {
  const store = new ArchitectureRuleStore(join(await makeRoot(), ".tokengraph", "rules.json"));
  await expect(store.add({ type: "forbidden-import", name: "Unsafe rule", fromPattern: "^(a+)+$" }))
    .rejects.toThrow(/unsafe architecture rule pattern/i);
  await expect(store.list()).resolves.toEqual([]);
});

it("persists a normal anchored architecture rule", async () => {
  const store = new ArchitectureRuleStore(join(await makeRoot(), ".tokengraph", "rules.json"));
  const rule = await store.add({ type: "forbidden-import", name: "No service imports", fromPattern: "^app/", targetPattern: "^src/services/" });
  expect(rule.fromPattern).toBe("^app/");
});
```

- [ ] **Step 2: Verify the unsafe-rule test is red**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "catastrophic architecture rule|normal anchored architecture rule"`

Expected: FAIL because the dangerous rule is currently persisted.

- [ ] **Step 3: Implement bounded worker validation**

```ts
const PATTERN_FIELDS = ["fromPattern", "targetPattern", "allowedTargetPattern", "modulePattern", "testPattern", "namePattern", "sqlPattern"] as const;
const PROBE = "a".repeat(24_000) + "!";
const TIMEOUT_MS = 100;

export async function assertSafeArchitectureRulePatterns(input: Partial<ArchitectureRuleInput>): Promise<void> {
  for (const field of PATTERN_FIELDS) {
    const pattern = input[field];
    if (typeof pattern === "string" && pattern) await assertSafePattern(pattern);
  }
}
```

Implement `assertSafePattern` in `patternSafety.ts` with `new Worker(..., { eval: true, workerData: { pattern, probe: PROBE } })`; terminate and reject on the timer, reject invalid syntax, and resolve only after `new RegExp(pattern).test(probe)` completes. Call the exported validator inside `enqueueWrite` before normalization in `add`, and against `{ ...current, ...update }` before replacing a rule in `update`.

- [ ] **Step 4: Verify the focused tests pass**

Run: `pnpm vitest run tests/core.test.ts --testNamePattern "catastrophic architecture rule|normal anchored architecture rule"`

Expected: PASS; the unsafe pattern is absent from `rules.json`.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/src/core/patternSafety.ts plugins/tokengraph/src/core/architectureRules.ts plugins/tokengraph/tests/core.test.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "fix(rules): reject unsafe architecture patterns"
```

### Task 3: Document and verify Phase 1

**Files:**

- Modify: `plugins/tokengraph/.mcp.json`
- Modify: `plugins/tokengraph/README.md`
- Modify: `docs/hosts/codex.md`
- Modify: `docs/hosts/claude-code.md`
- Modify: `docs/trust/security.md`
- Modify: `plugins/tokengraph/scripts/smoke.mjs`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`

**Interfaces:**

- Produces: Codex setup for `TOKENGRAPH_WORKSPACE_ROOT`, Claude setup for `CLAUDE_PROJECT_DIR`, and smoke coverage that provides a trusted root.

- [ ] **Step 1: Add failing validator assertions**

```js
assert((await readFile(sourceReadmePath, "utf8")).includes("TOKENGRAPH_WORKSPACE_ROOT"), "plugin README must document the trusted workspace variable");
assert((await readFile(resolve(hostDocsPath, "claude-code.md"), "utf8")).includes("CLAUDE_PROJECT_DIR"), "Claude guide must document its trusted project root");
assert((await readFile(resolve(trustDocsPath, "security.md"), "utf8")).match(/trusted workspace/i), "security guide must explain the workspace boundary");
```

- [ ] **Step 2: Verify validation fails before documentation changes**

Run: `pnpm validate:plugin`

Expected: FAIL because the deployed security contract is not documented.

- [ ] **Step 3: Implement host configuration and smoke updates**

```json
{
  "mcpServers": {
    "tokengraph": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": ".",
      "env_vars": ["TOKENGRAPH_WORKSPACE_ROOT"]
    }
  }
}
```

Make `smoke.mjs` spawn the bundled runtime with `TOKENGRAPH_WORKSPACE_ROOT` equal to its `--root` value. Explain that Claude Code supplies `CLAUDE_PROJECT_DIR`; Codex clients that do not support MCP Roots must forward `TOKENGRAPH_WORKSPACE_ROOT`.

- [ ] **Step 4: Run all Phase 1 checks**

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
git diff --name-only main...HEAD | ForEach-Object { if (Select-String -Path $_ -Pattern '[^\x00-\x7F]' -Quiet) { throw "non-ASCII: $_" } }
```

Expected: every command exits `0`.

- [ ] **Step 5: Commit**

```bash
git add plugins/tokengraph/.mcp.json plugins/tokengraph/README.md docs/hosts/codex.md docs/hosts/claude-code.md docs/trust/security.md plugins/tokengraph/scripts/smoke.mjs plugins/tokengraph/scripts/validate-plugin.mjs
git commit -m "docs: explain trusted TokenGraph workspace configuration"
```

### Task 4: Publish the Phase 1 pull request

**Files:**

- Modify: none.

- [ ] **Step 1: Inspect the final branch**

Run: `git diff --check main...HEAD; git diff --stat main...HEAD; git status --short`

Expected: no whitespace errors or uncommitted tracked files.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin codex/tokengraph-phase1-security
gh pr create --base main --head codex/tokengraph-phase1-security --title "fix: secure TokenGraph workspace and architecture rules" --body "## Scope\n- Confines tool roots to host-trusted workspaces.\n- Rejects unsafe persisted architecture patterns.\n\n## Verification\n- pnpm typecheck\n- pnpm test\n- pnpm build\n- pnpm smoke -- --root . --json\n- pnpm validate:plugin"
```

Expected: GitHub returns a pull request URL. Do not merge until review and CI complete.
