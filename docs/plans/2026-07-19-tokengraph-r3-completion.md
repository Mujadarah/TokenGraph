# TokenGraph R3.4-R3.7 Completion Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete R3.4-R3.7 by linking runner facts to scoped task outcomes, exposing category economics, adding deterministic Git-recency and task-type retrieval weights, and finishing the C3 trust disclosures.

**Architecture:** Keep completed task ledgers as the worktree-scoped outcome boundary and migrate them once to schema v3 with estimator v2. Persist bounded Git commit-distance metadata in project index schema v4, then keep the canonical BM25 scorer pure by consuming only indexed signals and a shared task classifier. Preserve both MCP tool surfaces and regenerate `release/tokengraph/` only after source, tests, and docs are green.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest, Zod, Git CLI through argv-safe `execFile`, pnpm 10.14, esbuild.

---

## Preconditions and invariants

- Work only on `codex/tokengraph-v021-r3-completion`, based on main commit `e70bee5` and design commit `6dd9782`.
- Treat `docs/superpowers/specs/2026-07-19-tokengraph-r3-completion-design.md` as the approved design and the supplied frozen v4 roadmap plus audit R3.4-R3.7 as controlling.
- Use `@superpowers:test-driven-development` for every production change and `@verification-before-completion` before every completion or publication claim.
- Do not add an MCP tool or change the eight-tool core and 42-tool full surfaces.
- Do not hand-edit `release/tokengraph/`; regenerate it with `pnpm package:plugin -- --release`.
- Do not use filesystem mtime or ctime in stable retrieval metadata or ranking.
- Do not let a caller select `verified` status directly.

### Task 1: Migrate task reports and ledgers once

**Files:**
- Modify: `plugins/tokengraph/src/core/taskEstimator.ts:3-195`
- Modify: `plugins/tokengraph/src/core/taskLedger.ts:18-64, 138-220, 366-390, 530-565`
- Test: `plugins/tokengraph/tests/task-ledger.test.ts`
- Test: `plugins/tokengraph/tests/hooks.test.ts`

**Step 1: Write failing schema and category tests**

Update the ledger creation test to require schema v3, estimator v2, and an empty outcome collection:

```ts
expect(ledger).toMatchObject({
  schemaVersion: 3,
  estimatorVersion: "task-estimator-v2",
  outcomes: [],
  events: []
});
```

Add a category-report test with one positive context event and one negative SQL event:

```ts
const report = buildTaskReport({
  ...ledger,
  events: [
    event({ category: "context", originalTokens: 100, compactTokens: 40, overheadTokens: 10 }),
    event({ category: "sql", originalTokens: 50, compactTokens: 60, overheadTokens: 5 })
  ]
});

expect(report.categories).toEqual([
  expect.objectContaining({ category: "context", eventCount: 1, basis: ["context:uncalibrated"] }),
  expect.objectContaining({ category: "sql", eventCount: 1, basis: ["sql:uncalibrated"] })
]);
expect(formatTaskReportFooter(report)).toContain("categories context=");
expect(formatTaskReportFooter(report)).toContain("sql:uncalibrated");
```

Add a migration fixture that writes a completed schema-v2/estimator-v1 ledger with no `outcomes` or `categories`, then asserts `loadTaskLedger` rewrites it as schema v3, keeps its events, adds `outcomes: []`, and rebuilds `completedReport.categories`.

Update exact hook/footer expectations to require byte-equal category clauses for Codex and Claude.

**Step 2: Run the focused tests and verify RED**

Run:

```powershell
cd plugins/tokengraph
pnpm test -- tests/task-ledger.test.ts tests/hooks.test.ts --reporter=dot
```

Expected: FAIL because the current report has no `categories`, the ledger is schema v2, and the estimator is v1.

**Step 3: Implement category estimates**

In `taskEstimator.ts`, introduce the new contract:

```ts
export const TASK_ESTIMATOR_VERSION = "task-estimator-v2" as const;

export interface TaskCategoryReport {
  category: string;
  eventCount: number;
  range: { low: number; likely: number; high: number; unit: "estimated_tokens" };
  confidence: EstimateConfidence;
  basis: string[];
  overhead: number;
}

export interface TaskReport {
  taskId: string;
  eventCount: number;
  estimate: {
    range: { low: number; likely: number; high: number; unit: "estimated_tokens" };
    confidence: EstimateConfidence;
    basis: string[];
    overhead: number;
    estimatorVersion: typeof TASK_ESTIMATOR_VERSION;
  };
  categories: TaskCategoryReport[];
  quality: { status: QualityStatus; checks: string[] };
}
```

Extract the current event arithmetic into a pure helper that accepts a category-filtered event list. Build one entry per category, sorted with `localeCompare`, without assigning report-footer overhead to a tool category. Keep the aggregate path unchanged except for estimator version.

Render the deterministic suffix after the existing quality clause:

```ts
const categoryText = report.categories
  .map((entry) => `${entry.category}=~${formatRange(entry.range)} (${entry.basis.join(",")})`)
  .join("; ");
return `${aggregateFooter.slice(0, -1)}; categories ${categoryText}.`;
```

Keep the exact no-event string unchanged.

**Step 4: Implement the single ledger migration**

Set:

```ts
export const TASK_LEDGER_SCHEMA_VERSION = 3 as const;
```

Add `outcomes: TaskOutcome[]` to `TaskLedger`, initialize it to `[]`, and reconstruct it through a strict allowlist. Accept legacy schema versions 1 and 2. When a legacy ledger loads:

```ts
ledger.schemaVersion = TASK_LEDGER_SCHEMA_VERSION;
ledger.estimatorVersion = TASK_ESTIMATOR_VERSION;
ledger.outcomes ??= [];
if (ledger.status === "completed") {
  ledger.completedReport = buildTaskReport(ledger);
}
await writeJsonAtomic(path, ledger);
```

Never accept a schema newer than 3. `reconstructTaskReport` must strictly validate new category entries and allow the ledger migration path to rebuild legacy reports from stored events.

**Step 5: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; footer snapshots are identical across hook adapters, negative SQL category values remain visible, and legacy ledgers migrate without quarantine.

**Step 6: Commit**

```powershell
git add plugins/tokengraph/src/core/taskEstimator.ts plugins/tokengraph/src/core/taskLedger.ts plugins/tokengraph/tests/task-ledger.test.ts plugins/tokengraph/tests/hooks.test.ts
git commit -m "feat: report category-level task economics"
```

### Task 2: Classify and persist provenance-aware outcomes

**Files:**
- Modify: `plugins/tokengraph/src/core/memoryCore.ts:7-31, 73-79`
- Modify: `plugins/tokengraph/src/core/taskLedger.ts:497-603`
- Test: `plugins/tokengraph/tests/memory-vault.test.ts`
- Test: `plugins/tokengraph/tests/task-ledger.test.ts`

**Step 1: Write failing provenance tests**

Add a pure factory test:

```ts
const base = {
  taskId: "task", summary: "command observed", evidence: ["run:r1"],
  createdAt: "2026-07-19T00:00:00.000Z", branch: "main",
  worktreeId: "wt", headCommit: "abc"
};

expect(createTaskOutcome({ ...base, provenance: "runner" }).status).toBe("verified");
expect(createTaskOutcome({ ...base, provenance: "agent" }).status).toBe("proposed");
expect(createTaskOutcome({ ...base, provenance: "inferred" }).status).toBe("proposed");
```

Add ledger tests that:

- append a runner outcome once even if its ID is retried;
- reject an outcome whose branch or worktree differs from the ledger identity;
- reject writes to paused/completed ledgers;
- list outcomes only from completed, valid ledgers in deterministic order;
- preserve proposed outcomes in storage while `verifiedOutcomes` excludes them from recall.

**Step 2: Run focused tests and verify RED**

Run:

```powershell
cd plugins/tokengraph
pnpm test -- tests/memory-vault.test.ts tests/task-ledger.test.ts --reporter=dot
```

Expected: FAIL because no provenance factory or ledger outcome functions exist.

**Step 3: Implement the outcome boundary**

In `memoryCore.ts` add:

```ts
export type TaskOutcomeProvenance = "runner" | "hook" | "filesystem-diff" | "agent" | "inferred";

export function createTaskOutcome(
  input: Omit<TaskOutcome, "id" | "status"> & { id?: string; provenance: TaskOutcomeProvenance }
): TaskOutcome {
  const status: TaskOutcome["status"] = ["runner", "hook", "filesystem-diff"].includes(input.provenance)
    ? "verified"
    : "proposed";
  const summary = filterUntrustedSourceText(input.summary).trim();
  if (!summary) throw new Error("Task outcome summary is empty after safety filtering.");
  const content: Omit<TaskOutcome, "id"> = {
    taskId: input.taskId.trim(),
    summary,
    status,
    evidence: [...new Set(input.evidence.map((entry) => entry.trim()).filter(Boolean))].sort(),
    createdAt: input.createdAt,
    ...(input.staleAt ? { staleAt: input.staleAt } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
    branch: input.branch,
    worktreeId: input.worktreeId,
    headCommit: input.headCommit
  };
  const id = input.id?.trim() || createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
    .slice(0, 24);
  return { id, ...content };
}
```

Do not accept a status parameter. Filter instruction-like outcome summaries through the existing untrusted-source filter before persistence.

In `taskLedger.ts` add locked functions with strict reconstruction:

```ts
export async function recordTaskOutcome(root: string, taskId: string, outcome: TaskOutcome): Promise<TaskLedger>;
export async function listCompletedTaskOutcomes(root: string): Promise<TaskOutcome[]>;
export async function requireOpenTaskForOutcome(root: string, taskId: string): Promise<TaskLedger>;
```

`recordTaskOutcome` must compare repository ID, branch, and worktree ID with the ledger identity, deduplicate by outcome ID, and refuse non-open tasks. `listCompletedTaskOutcomes` must use `loadTaskLedger`, ignore quarantined/open/paused ledgers, flatten outcomes, and sort newest first then by ID.

**Step 4: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; runner provenance is verified, agent/inferred provenance is proposed, and only completed valid ledgers feed later recall.

**Step 5: Commit**

```powershell
git add plugins/tokengraph/src/core/memoryCore.ts plugins/tokengraph/src/core/taskLedger.ts plugins/tokengraph/tests/memory-vault.test.ts plugins/tokengraph/tests/task-ledger.test.ts
git commit -m "feat: persist provenance-aware task outcomes"
```

### Task 3: Link CLI runs to active tasks and recall them

**Files:**
- Modify: `plugins/tokengraph/src/core/runner.ts:9-51, 117-128, 176-184`
- Modify: `plugins/tokengraph/src/cli.ts:7-55`
- Modify: `plugins/tokengraph/src/server.ts:820-868`
- Test: `plugins/tokengraph/tests/cli-runner.test.ts`
- Test: `plugins/tokengraph/tests/mcp-smoke.test.ts`

**Step 1: Write the failing CLI integration tests**

Build a real task ledger, invoke the compiled CLI with `--task-id`, and assert:

```ts
const ledger = await createTaskLedger(root, { host: "codex" });
const result = await execFileAsync(process.execPath, [
  resolve("dist", "cli.js"), "run", "--root", root, "--task-id", ledger.taskId,
  "--", process.execPath, "-e", "process.exit(7)"
], { cwd: process.cwd() }).catch((error) => error);

const stored = await loadTaskLedger(root, ledger.taskId);
expect(stored?.outcomes).toEqual([
  expect.objectContaining({
    taskId: ledger.taskId, status: "verified", branch: expect.any(String),
    worktreeId: expect.any(String), headCommit: expect.any(String),
    evidence: expect.arrayContaining([expect.stringMatching(/^run:/), "exit-code:7"])
  })
]);
```

Add a marker-file command with a missing, paused, completed, or wrong-branch task ID and prove the marker is never created.

Add an MCP test that completes the first task, calls a new verbose `tokengraph_prepare_context`, and finds the prior verified outcome under `memory.outcomes`. A proposed outcome must remain absent.

**Step 2: Run focused tests and verify RED**

Run:

```powershell
cd plugins/tokengraph
pnpm test -- tests/cli-runner.test.ts tests/mcp-smoke.test.ts --reporter=dot
```

Expected: FAIL because `--task-id` is ignored/rejected and prepare context still passes `outcomes: []`.

**Step 3: Build a privacy-minimal runner outcome**

In `runner.ts`, add a helper that uses the existing argument redactor and never copies stdout/stderr:

```ts
export function taskOutcomeFromRun(
  run: SavedRun,
  taskId: string,
  identity: RepositoryIdentity
): TaskOutcome {
  const command = redactRunnerArguments([run.command, ...run.args]).join(" ");
  return createTaskOutcome({
    id: `run-${run.runId}`,
    taskId,
    summary: `${command} -> ${run.status} (exit ${run.exitCode ?? "null"})`,
    evidence: [`run:${run.runId}`, `exit-code:${run.exitCode ?? "null"}`, `runner-status:${run.status}`],
    createdAt: run.finishedAt,
    branch: identity.branch,
    worktreeId: identity.worktreeId,
    headCommit: identity.headCommit,
    provenance: "runner"
  });
}
```

**Step 4: Wire `--task-id` in the safe order**

In `cli.ts`:

1. Parse the optional task ID.
2. Before `executeRun`, call `requireOpenTaskForOutcome` and refresh repository identity.
3. Preserve standalone behavior when no task ID is supplied.
4. Save the quota-checked run first.
5. Record the derived outcome under the ledger lock.
6. If linkage fails after capture persistence, include the run ID in the error and do not claim linkage.

Update CLI usage text to include `[--task-id <uuid>]`.

**Step 5: Feed completed outcomes into memory composition**

Replace the disconnected placeholder in `server.ts`:

```ts
const outcomes = await listCompletedTaskOutcomes(resolvedRoot);
const memoryContext = composeMemoryContext({
  repositoryId: identity.repositoryId,
  worktreeId: identity.worktreeId,
  branch: identity.branch,
  sourceFingerprint: project.fingerprint,
  projectBrief,
  indexedFacts: project.files.slice(0, config.maxFiles).map((file) => `${file.path}:${file.language}`),
  capsules: [capsuleStableArtifact.hash],
  reviewedDecisions: [
    ...appliedKnowledge.map((entry) => `${entry.title}: ${entry.proposedContent}`),
    ...memories.filter((memory) => Boolean(memory.confirmedAt)).map((memory) => `${memory.title}: ${memory.body}`)
  ],
  maxTokens: config.memory.maxRetrievalTokens,
  outcomes,
});
```

Do not bypass `composeMemoryContext`; it is the branch/worktree/proposal filter from R3.2.

**Step 6: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; a real exit-7 runner fact is verified and recalled only on the matching branch/worktree, while invalid tasks do not spawn.

**Step 7: Commit**

```powershell
git add plugins/tokengraph/src/core/runner.ts plugins/tokengraph/src/cli.ts plugins/tokengraph/src/server.ts plugins/tokengraph/tests/cli-runner.test.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "feat: link runner facts to active tasks"
```

### Task 4: Persist bounded Git recency in index schema v4

**Files:**
- Modify: `plugins/tokengraph/src/core/types.ts:284-303`
- Modify: `plugins/tokengraph/src/core/repositoryIdentity.ts:15-23, 144-165`
- Modify: `plugins/tokengraph/src/core/projectIndexer.ts:12, 197-225`
- Modify: `plugins/tokengraph/src/core/persistence.ts:121-165`
- Modify: `plugins/tokengraph/src/server.ts:881-896`
- Test: `plugins/tokengraph/tests/foundations.test.ts`
- Test: `plugins/tokengraph/tests/core.test.ts`

**Step 1: Write a real Git-history RED test**

Create a temporary repository with two indexed files. Commit `src/old.ts`, then commit `src/recent.ts`, and request signals for both:

```ts
expect(await getGitFileRecency(root, ["src/old.ts", "src/recent.ts"], 50)).toEqual({
  source: "git-commit-distance",
  historyDepth: 50,
  fileCommitDistance: { "src/old.ts": 1, "src/recent.ts": 0 }
});
```

Change both filesystem mtimes without creating a commit and assert the signal is byte-identical. Add a non-Git fixture expecting:

```ts
{ source: "unavailable", historyDepth: 50, fileCommitDistance: {} }
```

Update index tests to require schema v4, retrieval signals in the fingerprint payload, and a stale/rebuilt schema-v3 index.

**Step 2: Run focused tests and verify RED**

Run:

```powershell
cd plugins/tokengraph
pnpm test -- tests/foundations.test.ts tests/core.test.ts --reporter=dot
```

Expected: FAIL because the Git-recency API and schema-v4 fields do not exist.

**Step 3: Implement one bounded Git read**

Add the type:

```ts
export interface RetrievalSignals {
  source: "git-commit-distance" | "unavailable";
  historyDepth: number;
  fileCommitDistance: Record<string, number>;
}
```

Add `retrievalSignals?: RetrievalSignals` to `ProjectIndex`.

In `repositoryIdentity.ts`, use one argv-safe `execFile` call with a 1 MiB cap:

```ts
git -C <root> -c core.quotePath=false log -n <depth> --format=commit:%H%x00 --name-only -z --no-renames HEAD --
```

Parse NUL-delimited commit markers and paths. Normalize to forward slashes, retain only requested indexed paths, record the first commit distance, and serialize keys with lexical ordering. Clamp depth to 1-50. Catch Git absence/failure and return the explicit neutral structure.

**Step 4: Upgrade index and artifact metadata**

Set `CURRENT_INDEX_SCHEMA_VERSION = 4`, update persistence newer-schema guards to 4, and obtain `retrievalSignals` in `buildProjectIndex`. Include them in the project fingerprint payload and returned index. Update stable artifact metadata from `tokengraph-index-v3` to `tokengraph-index-v4`.

Add a strict persistence guard: schema-v4 indexes must contain a signal source,
an integer history depth from 1 through 50, normalized relative path keys, and
integer distances from zero through `historyDepth - 1`. The `unavailable`
source must have an empty distance map. Reject or rebuild malformed derived
indexes instead of passing attacker-controlled weights to retrieval.

Old schema-v3 derived indexes must rebuild; never silently treat them as schema v4.

**Step 5: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; commit distance is correct, mtime changes have no effect, non-Git fallback is neutral, and schema v3 rebuilds.

**Step 6: Commit**

```powershell
git add plugins/tokengraph/src/core/types.ts plugins/tokengraph/src/core/repositoryIdentity.ts plugins/tokengraph/src/core/projectIndexer.ts plugins/tokengraph/src/core/persistence.ts plugins/tokengraph/src/server.ts plugins/tokengraph/tests/foundations.test.ts plugins/tokengraph/tests/core.test.ts
git commit -m "feat: index deterministic git recency"
```

### Task 5: Apply task-type and recency weights in the pure scorer

**Files:**
- Create: `plugins/tokengraph/src/core/taskClassifier.ts`
- Modify: `plugins/tokengraph/src/core/planner.ts:1-25, 299`
- Modify: `plugins/tokengraph/src/core/retrieval.ts:68-96, 113-144`
- Test: `plugins/tokengraph/tests/retrieval.test.ts`
- Test: `plugins/tokengraph/tests/core.test.ts`

**Step 1: Write failing ranking tests**

Create lexically tied files with different commit distances and assert the recent file ranks first. Then hold recency equal and assert:

- `test` ranks an indexed test first;
- `database` ranks SQL first;
- `docs` ranks docs first;
- `feature` and `refactor` favor non-test modules/routes/components;
- `bug` applies the specified test and source boosts;
- `architecture` applies the specified module/doc boost;
- a zero-BM25 file never appears from boosts alone;
- top-k and path tie-breaking remain deterministic.

Add an artifact assertion that capsule schema version is 4.

**Step 2: Run focused tests and verify RED**

Run:

```powershell
cd plugins/tokengraph
pnpm test -- tests/retrieval.test.ts tests/core.test.ts --reporter=dot
```

Expected: FAIL because the scorer ignores both new signals and task type, and the capsule schema is 3.

**Step 3: Centralize task classification**

Move the existing classifier unchanged into `taskClassifier.ts`:

```ts
export function classifyTask(task: string): TaskType {
  const text = task.toLowerCase();
  if (/\b(fix|bug|error|failing|regression)\b/.test(text)) return "bug";
  if (/\b(refactor|cleanup|rename|split)\b/.test(text)) return "refactor";
  if (/\b(sql|database|table|migration|rls|policy|postgres|supabase)\b/.test(text)) return "database";
  if (/\b(test|spec|coverage)\b/.test(text)) return "test";
  if (/\b(doc|readme|guide|documentation)\b/.test(text)) return "docs";
  if (/\b(architecture|design|why|explain)\b/.test(text)) return "architecture";
  return "feature";
}
```

Import it from both planner and retrieval; remove the planner-local duplicate.

**Step 4: Implement the exact pure weights**

Keep BM25 calculation unchanged. For each positive lexical result, compute:

```ts
const distance = index.retrievalSignals?.fileCommitDistance[file.path];
const validDistance = typeof distance === "number" && Number.isInteger(distance) && distance >= 0 && distance < 50;
const recencyBoost = validDistance
  ? 0.15 * (50 - distance) / 50
  : 0;
const taskTypeBoost = boostForTaskType(file, taskType);
const score = Number((bm25 + recencyBoost + taskTypeBoost).toFixed(6));
```

Implement the boost table directly:

```ts
function boostForTaskType(file: CodeFile, taskType: TaskType): number {
  const source = !file.isTest && ["module", "next-route", "react-component"].includes(file.kind);
  if (taskType === "test") return file.isTest ? 0.20 : 0;
  if (taskType === "database") return file.kind === "sql" ? 0.20 : 0;
  if (taskType === "docs") return file.kind === "doc" ? 0.20 : 0;
  if (taskType === "bug") return file.isTest ? 0.20 : source ? 0.10 : 0;
  if (taskType === "feature" || taskType === "refactor") return source ? 0.15 : 0;
  if (taskType === "architecture") return file.kind === "module" || file.kind === "doc" ? 0.10 : 0;
  return 0;
}
```

Use the design's exact boost table and indexed `kind`/`isTest` facts. Do not add a file whose base BM25 is zero. Sort score descending, then path ascending. Keep graph expansion after ranking.

Change:

```ts
return createStableArtifact("capsule/retrieval", capsule, 4);
```

**Step 5: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; Git recency and task type break lexical ties exactly, unrelated files stay excluded, and artifact schema is 4.

**Step 6: Commit**

```powershell
git add plugins/tokengraph/src/core/taskClassifier.ts plugins/tokengraph/src/core/planner.ts plugins/tokengraph/src/core/retrieval.ts plugins/tokengraph/tests/retrieval.test.ts plugins/tokengraph/tests/core.test.ts
git commit -m "feat: weight retrieval by recency and task type"
```

### Task 6: Complete C3 trust disclosures and benchmark contracts

**Files:**
- Modify: `docs/trust/security.md`
- Modify: `docs/trust/privacy.md`
- Modify: `CHANGELOG.md:3-12`
- Modify: `plugins/tokengraph/tests/cli-smoke.test.ts:187-280`
- Modify: `plugins/tokengraph/tests/benchmark.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`

**Step 1: Write failing documentation and schema tests**

Require both trust files to contain case-insensitive matches for:

```ts
expect(text).toMatch(/best effort.*not a guarantee/is);
expect(text).toMatch(/\.tokengraph\/runs\/.*plaintext/is);
expect(text).toMatch(/do not invoke.*tokengraph run/is);
expect(text).toMatch(/regulated|highly sensitive/is);
expect(text).toMatch(/not encrypted today.*future.*local encryption/is);
```

In benchmark and MCP tests, assert every completed verbose report has a sorted `categories` array with category, event count, range, confidence, overhead, and basis, and that the compact footer includes the category clause. Preserve the existing no-event exact string.

**Step 2: Run focused tests and verify RED**

Run:

```powershell
cd plugins/tokengraph
pnpm test -- tests/cli-smoke.test.ts tests/benchmark.test.ts tests/mcp-smoke.test.ts --reporter=dot
```

Expected: FAIL because the trust disclosures and benchmark category assertions are not yet satisfied.

**Step 3: Write only accurate C3 guidance**

Update both trust files to state:

- redaction is best effort and not a guarantee;
- saved captures are plaintext JSON under `.tokengraph/runs/` in the active worktree;
- there is no always-on capture, and complete avoidance means not invoking `tokengraph run` and using normal host execution;
- regulated or highly sensitive output should not pass through the runner;
- storage is not encrypted today, while isolated storage interfaces permit future optional local encryption.

Do not claim a configuration flag that does not exist.

Append four R3.4-R3.7 bullets under `## Unreleased` in `CHANGELOG.md`; do not edit published entries.

**Step 4: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: PASS; docs satisfy C3, benchmark/MCP output exposes category schema, and old compact/no-event behavior remains covered.

**Step 5: Commit**

```powershell
git add docs/trust/security.md docs/trust/privacy.md CHANGELOG.md plugins/tokengraph/tests/cli-smoke.test.ts plugins/tokengraph/tests/benchmark.test.ts plugins/tokengraph/tests/mcp-smoke.test.ts
git commit -m "docs: complete R3 storage and reporting contracts"
```

### Task 7: Regenerate the release and run the complete gate

**Files:**
- Regenerate: `release/tokengraph/`
- Verify: all files changed by Tasks 1-6

**Step 1: Run source verification before generation**

From `plugins/tokengraph` run each command separately and stop on the first nonzero exit:

```powershell
pnpm typecheck
pnpm test -- --reporter=dot
pnpm benchmark
pnpm build
pnpm smoke -- --root . --surface full --json
pnpm validate:plugin
```

Expected:

- typecheck exits 0;
- all test files and tests pass with zero failures;
- benchmark reports `release gate: PASS`;
- build exits 0;
- smoke reports `status: ok` and exactly 42 tools;
- plugin validation passes.

**Step 2: Regenerate the release output**

Run:

```powershell
pnpm package:plugin -- --release
```

Expected: `release/tokengraph/` is updated from source. Do not manually edit generated files.

**Step 3: Inspect generated scope and privacy**

Run from the repository root:

```powershell
git status --short
git diff --stat
rg -n "C:\\Users\\|/home/|rabia|api[_-]?key|password" release/tokengraph docs CHANGELOG.md
```

Expected: only intended source/docs/tests plus generated release files are changed; the privacy scan finds no machine-local paths or secrets. Any generic documentation occurrence must be inspected rather than silently ignored.

**Step 4: Commit generated output**

```powershell
git add release/tokengraph
git commit -m "chore: regenerate R3 completion package"
```

**Step 5: Run the complete gate again on the committed tree**

Repeat all Step 1 commands, then run:

```powershell
pnpm package:plugin -- --release
git -C ../.. diff --exit-code
git -C ../.. status --short --branch
```

Expected: every gate passes, release regeneration produces no diff, and the branch is clean.

**Step 6: Audit acceptance line by line**

Verify:

- R3.4: real runner completion created a verified, scoped outcome; agent provenance remained proposed.
- R3.5: compact footer and verbose schema expose sorted category bases and the benchmark asserts them.
- R3.6: Git commit distance and shared task type affect only positive-BM25 files; mtime does not affect ranking.
- R3.7: both trust files contain all four C3 disclosures.
- Core/full tool counts remain 8/42.
- Router enforcement and R4 evidence state are unchanged.

Do not claim completion if any item lacks fresh command or test evidence.
