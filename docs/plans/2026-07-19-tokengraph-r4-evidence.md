# TokenGraph R4 Evidence Completion Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete R4.1-R4.4 with an enum routing contract, honest router and exact-slice benchmark accounting, schema-v2 real-host paired evidence, and a recorded non-fabricated promotion decision.

**Architecture:** Keep deterministic fixture economics and real Codex host evidence in separate report sections. Extend the current pure routing and paired-evaluation modules, add one bounded host-run adapter around `codex exec --json`, and make promotion require reviewed schema-v2 real-host provenance plus every frozen gate. Stable retrieval artifacts advance to v5 while old hashes remain readable.

**Tech Stack:** TypeScript 5.9.3, Node.js 22, Vitest 3.2.6, esbuild, pnpm 10.14.0, Codex CLI JSONL, Git worktrees, deterministic JSON/Markdown generation.

---

## Constraints

- Work only in `plugins/tokengraph/` for implementation and regenerate `release/tokengraph/` with `pnpm package:plugin -- --release`.
- Follow test-driven development: write each behavior test, run it and observe the expected failure, then implement the minimum production change.
- Keep tracked text ASCII and LF-only.
- Do not edit a published changelog entry; add dated notes under `## Unreleased`.
- Do not enable enforced routing unless every frozen gate passes on eligible real-host evidence.
- Do not check in raw Codex event streams, prompts, model output, personal paths, or secrets.
- Do not delete local worktrees/branches or remote branches as part of the R4 commits.

### Task 1: Freeze the enum router and artifact-v5 contract

**Files:**
- Modify: `plugins/tokengraph/src/core/artifact.ts`
- Modify: `plugins/tokengraph/src/core/routingAdvisor.ts`
- Modify: `plugins/tokengraph/src/core/retrieval.ts`
- Modify: `plugins/tokengraph/tests/routing-artifact.test.ts`
- Modify: `plugins/tokengraph/tests/retrieval.test.ts`

**Step 1: Write the failing routing tests**

Add assertions that:

```ts
expect(adviseRouting({ task: "Fix src/core/routingAdvisor.ts:42" })).toMatchObject({
  useTokenGraph: false,
  stage: 0,
  reason: "bounded-task",
  expectedBenefit: "none"
});
expect(adviseRouting({ task: "Review the repository security boundary around src/core/routingAdvisor.ts:42" })).toMatchObject({
  useTokenGraph: true,
  expectedBenefit: "medium"
});
expect(adviseRouting({ task: "Trace architecture", indexAvailable: true }).expectedBenefit).toBe("high");
```

Assert all bypass, kill-switch, force-bypass, and fail-open decisions use
`expectedBenefit: "none"`. Assert every `bounded-task` decision bypasses and
every discovery reason activates.

In `retrieval.test.ts`, change the current capsule artifact expectation from v4
to v5 and prove the same content produces a different v5 hash than v4.

**Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm vitest run tests/routing-artifact.test.ts tests/retrieval.test.ts
```

Expected: FAIL because `expectedBenefit` is numeric, the exact file-and-line task
activates, and new retrieval artifacts are schema v4.

**Step 3: Implement the minimum router contract**

In `artifact.ts`, add:

```ts
export const CURRENT_ARTIFACT_SCHEMA_VERSION = 5;
export type ExpectedBenefit = "none" | "low" | "medium" | "high";
```

Change `RoutingDecision.expectedBenefit` to `ExpectedBenefit`. Keep
`createStableArtifact` able to accept an explicit historical schema version,
but default new artifacts to `CURRENT_ARTIFACT_SCHEMA_VERSION`.

In `routingAdvisor.ts`, add one bounded exact-location predicate that accepts a
single repository-relative source/config path with optional `:line` or
`:line:column`, only for short local lookup/edit prompts and only when no broad
discovery term is present. Include `risk` in broad terms. Compute the decision
first, then derive `reason` and benefit from it:

```ts
const expectedBenefit: ExpectedBenefit = !useTokenGraph
  ? "none"
  : stage === 1 ? "high" : "medium";
```

In `retrieval.ts`, create new capsule artifacts with schema v5.

**Step 4: Run focused tests and verify GREEN**

Run the same focused command. Expected: both files PASS.

**Step 5: Run typecheck**

Run `pnpm typecheck`. Expected: PASS with all routing consumers updated to the
enum.

**Step 6: Commit**

```powershell
git add plugins/tokengraph/src/core/artifact.ts plugins/tokengraph/src/core/routingAdvisor.ts plugins/tokengraph/src/core/retrieval.ts plugins/tokengraph/tests/routing-artifact.test.ts plugins/tokengraph/tests/retrieval.test.ts
git commit -m "fix(tokengraph): align routing benefit contract"
```

### Task 2: Publish denominator-correct fixture router metrics

**Files:**
- Modify: `plugins/tokengraph/scripts/benchmark-corpus-v1.json`
- Modify: `plugins/tokengraph/scripts/benchmark-lib.ts`
- Modify: `plugins/tokengraph/scripts/benchmark-cli.ts`
- Modify: `plugins/tokengraph/tests/benchmark.test.ts`

**Step 1: Write failing corpus and metrics tests**

Extend `BenchmarkTask` with required `expectedRouting: "activate" | "bypass"`.
Write tests proving corpus validation rejects a missing/invalid truth label.

Add a benchmark assertion equivalent to:

```ts
expect(report.routerShadow).toMatchObject({
  beneficialTaskCount: 27,
  boundedTaskCount: 3,
  falseBypassCount: 0,
  falseActivationCount: 0,
  falseBypassRate: 0,
  falseActivationRate: 0
});
expect(Object.keys(report.routerShadow.categoryCounts)).toEqual([...BENCHMARK_CATEGORIES]);
```

The expected bounded tasks are `code-routing-01`, `code-routing-04`, and
`debugging-01`; all remaining tasks are beneficial/activate truth labels.

Add a mutation test that flips one beneficial task to a bypass decision and
asserts false-bypass is divided by beneficial tasks, not all tasks. Add the
corresponding bounded-task mutation for false activation.

**Step 2: Run the focused benchmark tests and verify RED**

Run:

```powershell
pnpm vitest run tests/benchmark.test.ts
```

Expected: FAIL because the corpus has no truth labels and the report has no
`routerShadow` block.

**Step 3: Add independent routing truth to every corpus task**

Set `expectedRouting: "bypass"` only on the three IDs above. Set all other tasks
to `activate`. Do not derive truth from the router decision.

**Step 4: Implement pure router-metric aggregation**

Add a pure exported helper in `benchmark-lib.ts` that accepts task truth plus
decisions and returns sorted counts, per-category coverage, and denominator-
correct rates. Treat a zero truth denominator as unavailable rather than a
passing zero. Include each task's truth and false-decision flags in task output.

Add `routerShadow` to the stable JSON projection in `benchmark-cli.ts`.

**Step 5: Run focused tests and verify GREEN**

Run `pnpm vitest run tests/benchmark.test.ts`. Expected: PASS.

**Step 6: Commit**

```powershell
git add plugins/tokengraph/scripts/benchmark-corpus-v1.json plugins/tokengraph/scripts/benchmark-lib.ts plugins/tokengraph/scripts/benchmark-cli.ts plugins/tokengraph/tests/benchmark.test.ts
git commit -m "feat(tokengraph): report router shadow accuracy"
```

### Task 3: Charge exact slices on real edit-shaped corpus tasks

**Files:**
- Modify: `plugins/tokengraph/scripts/benchmark-corpus-v1.json`
- Modify: `plugins/tokengraph/scripts/benchmark-lib.ts`
- Modify: `plugins/tokengraph/scripts/benchmark-cli.ts`
- Modify: `plugins/tokengraph/tests/benchmark.test.ts`
- Modify: `plugins/tokengraph/tests/cli-smoke.test.ts`
- Modify: `docs/benchmarks/results-current.json`
- Modify: `docs/benchmarks/results-current.md`
- Modify: `CHANGELOG.md`

**Step 1: Write failing slice-contract tests**

Require `exactSliceTarget` when `requiresExactSlice` is true:

```ts
interface ExactSliceTarget {
  file: string;
  symbol?: string;
}
```

Assert corpus validation rejects a true flag without a target, a target outside
`requiredFiles`, or a target that cannot resolve to an indexed file/symbol.

Assert the real corpus has exactly these selected edit-shaped tasks:

- `code-routing-02` -> `services/patientService.ts`, symbol `getPatient`;
- `debugging-01` -> `services/patientService.test.ts`;
- `debugging-03` -> `app/patients/[id]/page.tsx`;
- `debugging-04` -> `services/patientService.ts`.

Assert the report has `exactSliceAccounting.taskCount === 4`, at least four
targeted calls, and a positive targeted-read token charge.

**Step 2: Run focused tests and verify RED**

Run `pnpm vitest run tests/benchmark.test.ts tests/cli-smoke.test.ts`.
Expected: FAIL because no corpus task is charged and no exact-slice summary is
published.

**Step 3: Implement target-driven exact reads**

Validate each target against `requiredFiles` at corpus load and against the
current indexed project during evaluation. Resolve the named symbol when given;
otherwise use the first bounded symbol range in the target file. Never fall
back to all recommended first reads for an exact-slice task.

Publish:

```ts
exactSliceAccounting: {
  taskCount: number;
  targetedReadCallCount: number;
  targetedReadTokens: number;
  taskIds: string[];
}
```

**Step 4: Run focused tests and verify GREEN**

Run the same focused tests. Expected: PASS.

**Step 5: Regenerate current benchmark evidence**

Run:

```powershell
pnpm benchmark -- --json
```

Update `results-current.json` from the stable JSON output and update the
Markdown projection with the new exact-slice counts, router metrics, aggregate,
category results, and honest fixture limitations. Add a dated 2026-07-19 R4
accounting note under `## Unreleased`; do not modify versioned entries.

**Step 6: Lock the regenerated values**

Update exact benchmark assertions and smoke schema assertions from the fresh
output. Re-run `pnpm vitest run tests/benchmark.test.ts tests/cli-smoke.test.ts`.
Expected: PASS.

**Step 7: Commit**

```powershell
git add plugins/tokengraph/scripts/benchmark-corpus-v1.json plugins/tokengraph/scripts/benchmark-lib.ts plugins/tokengraph/scripts/benchmark-cli.ts plugins/tokengraph/tests/benchmark.test.ts plugins/tokengraph/tests/cli-smoke.test.ts docs/benchmarks/results-current.json docs/benchmarks/results-current.md CHANGELOG.md
git commit -m "fix(tokengraph): charge implementation evidence slices"
```

### Task 4: Version paired evidence and promotion eligibility

**Files:**
- Modify: `plugins/tokengraph/src/core/pairedEval.ts`
- Modify: `plugins/tokengraph/src/core/routingControl.ts`
- Modify: `plugins/tokengraph/src/core/types.ts`
- Modify: `plugins/tokengraph/tests/paired-eval.test.ts`
- Modify: `plugins/tokengraph/tests/fixtures/paired-eval-v1.json`
- Create: `plugins/tokengraph/tests/fixtures/paired-eval-v2.json`

**Step 1: Write failing schema-v2 tests**

Define v2 additions:

```ts
type EvidenceSource = "fixture" | "real-host";

interface RouterShadowObservation {
  expectedBenefit: "none" | "low" | "medium" | "high";
  expectedRouting: "activate" | "bypass";
  routingLatencyMs: number;
  activationLatencyMs?: number;
}
```

Add tests that:

- schema v1 remains parseable but is normalized as legacy fixture evidence;
- schema v1 and schema-v2 `fixture` reports can never enable enforcement;
- schema-v2 `real-host` traces require finite non-negative monotonic latencies,
  benefit enum, truth labels, repeat number, condition order, host-reported
  tokens, and acceptance status;
- false rates use truth-specific denominators;
- missing denominators and Stage-0 median not strictly below activation median
  fail gates;
- retained failures still count toward task/category coverage;
- promotion report schema v2 requires real-host provenance and latency fields.

**Step 2: Run paired tests and verify RED**

Run `pnpm vitest run tests/paired-eval.test.ts`. Expected: FAIL because only
schema v1 and all-observation rate denominators exist.

**Step 3: Implement schema-v2 parsing and evaluation**

Keep the v1 parser for the existing fixture but normalize it to
`evidenceSource: "fixture"` and `promotionEligible: false`. Add strict v2
allowlists. Pair by `(taskId, repeat)` rather than taking the first ON/OFF trace.

Add router report fields for truth denominators, rates, category coverage, Stage
0 latency median, activation latency median, latency sample counts, and
`stage0FasterThanActivation`.

Make `enforcementEnabled` require:

```ts
manifest.evidenceSource === "real-host" &&
allFrozenGatesPass &&
report.failures.length === 0
```

Persist only schema-v2 promotion reports. Failed/ineligible evidence removes a
stale promotion as today.

**Step 4: Run paired tests and verify GREEN**

Run `pnpm vitest run tests/paired-eval.test.ts`. Expected: PASS.

**Step 5: Run typecheck**

Run `pnpm typecheck`. Expected: PASS.

**Step 6: Commit**

```powershell
git add plugins/tokengraph/src/core/pairedEval.ts plugins/tokengraph/src/core/routingControl.ts plugins/tokengraph/src/core/types.ts plugins/tokengraph/tests/paired-eval.test.ts plugins/tokengraph/tests/fixtures/paired-eval-v1.json plugins/tokengraph/tests/fixtures/paired-eval-v2.json
git commit -m "feat(tokengraph): require real paired promotion evidence"
```

### Task 5: Build the bounded Codex host-run adapter

**Files:**
- Create: `plugins/tokengraph/src/core/pairedHost.ts`
- Modify: `plugins/tokengraph/src/cli.ts`
- Create: `plugins/tokengraph/tests/paired-host.test.ts`
- Modify: `plugins/tokengraph/tests/cli-runner.test.ts`
- Modify: `plugins/tokengraph/scripts/build.mjs`

**Step 1: Write failing fake-host tests**

Use a temporary fake executable that emits representative Codex JSONL events.
Prove the adapter:

- parses exact model, host version, input/output/total usage, tool calls, final
  status, and bounded failure class;
- refuses a stream without host-reported usage;
- counterbalances ON/OFF order and emits five distinct repeats;
- creates one clean Git worktree per condition/repeat at the same commit;
- executes the same acceptance command after each host turn;
- retains timeouts, process failures, and failed acceptance commands;
- writes raw JSONL only under `.tokengraph/runs/paired-host/`;
- emits a privacy-minimal schema-v2 manifest without absolute paths or raw text;
- does not delete a worktree until its trace and acceptance result are durable.

**Step 2: Run host tests and verify RED**

Run:

```powershell
pnpm vitest run tests/paired-host.test.ts tests/cli-runner.test.ts
```

Expected: FAIL because the host adapter and CLI command do not exist.

**Step 3: Implement the pure event parser**

In `pairedHost.ts`, separate JSONL parsing/normalization from process execution.
Use strict allowlists and integer token counters. Count fallback raw reads only
from normalized host tool-call events. Hash the prompt template; do not persist
prompt or response text in the reviewed manifest.

**Step 4: Implement bounded orchestration**

Add `tokengraph evaluate-host` options for protocol path, root, output manifest,
Codex executable, timeout, and dry-run. Spawn with argv arrays, never shell
strings. ON uses `--ignore-user-config` plus only the local TokenGraph MCP
configuration; OFF uses `--ignore-user-config` without TokenGraph. Both use the
same model, reasoning, sandbox, prompt template, and acceptance command.

Constrain all generated worktrees beneath a verified `.tokengraph/runs/paired-host/<evaluation-id>/worktrees/`
directory. On Windows, verify resolved paths stay beneath that root before any
recursive removal.

**Step 5: Run focused tests and verify GREEN**

Run the same focused tests. Expected: PASS.

**Step 6: Build and smoke the CLI help path**

Run:

```powershell
pnpm build
node dist/cli.js evaluate-host --help
```

Expected: build PASS and usage text without starting a host run.

**Step 7: Commit**

```powershell
git add plugins/tokengraph/src/core/pairedHost.ts plugins/tokengraph/src/cli.ts plugins/tokengraph/tests/paired-host.test.ts plugins/tokengraph/tests/cli-runner.test.ts plugins/tokengraph/scripts/build.mjs
git commit -m "feat(tokengraph): capture paired Codex host traces"
```

### Task 6: Run and publish the first real host evaluation

**Files:**
- Create: `docs/benchmarks/host-evaluations/2026-07-19-tokengraph-codex-protocol.json`
- Create after live run: `docs/benchmarks/host-evaluations/2026-07-19-tokengraph-codex-manifest.json`
- Create after evaluation: `docs/benchmarks/host-evaluations/2026-07-19-tokengraph-codex-report.json`
- Create after evaluation: `docs/benchmarks/host-evaluations/2026-07-19-tokengraph-codex-report.md`
- Modify: `plugins/tokengraph/tests/paired-eval.test.ts`
- Modify: `docs/benchmarks/results-current.json`
- Modify: `docs/benchmarks/results-current.md`

**Step 1: Write the checked-in protocol**

Define one real TokenGraph implementation task against base commit `11129c2`:
align `expectedBenefit` with the frozen enum, preserve routing semantics, and
pass focused routing/retrieval tests plus typecheck. Configure five repeats,
counterbalanced order, minimum-per-category 10, the exact model/reasoning used
for this task, and a bounded acceptance command.

The expected promotion decision is not predetermined. With one task and five
pairs, category coverage should remain insufficient for promotion even if all
five patches pass.

**Step 2: Validate the local host before spending runs**

Run:

```powershell
codex --version
codex exec --help
node plugins/tokengraph/dist/cli.js evaluate-host --root . --protocol docs/benchmarks/host-evaluations/2026-07-19-tokengraph-codex-protocol.json --dry-run
```

Expected: Codex version is captured; dry run prints ten ordered ON/OFF runs,
verified roots, and no host invocation.

**Step 3: Run the real evaluation**

Run the same command without `--dry-run` and with the reviewed output-manifest
path. Do not parallelize the ten host turns. Preserve every failure/timeout.

Expected: a schema-v2 manifest with five ON/OFF pairs and exact host usage.
If authentication, JSON usage, plugin configuration, or acceptance evidence is
unavailable, stop and report the concrete blocker; do not synthesize traces.

**Step 4: Evaluate without promotion**

Run:

```powershell
node plugins/tokengraph/dist/cli.js evaluate-routing --root . --manifest docs/benchmarks/host-evaluations/2026-07-19-tokengraph-codex-manifest.json
```

Expected: a report and a non-promoting decision unless every frozen gate truly
passes. A nonzero exit from failed coverage is expected evidence, not a harness
failure.

**Step 5: Add production-parser validation**

Add a test that loads the checked-in manifest, reproduces the checked-in report,
asserts `evidenceSource === "real-host"`, and asserts the recorded promotion
decision. Run `pnpm vitest run tests/paired-eval.test.ts` and verify PASS.

**Step 6: Project real-host evidence into current results**

Add a separately labeled `realHostEvaluation` block and Markdown section with
manifest path, scope, model/host/plugin/repository versions, pair counts,
retained failures, router rates, latency medians, paired intervals, and the
recorded promotion decision. Do not merge host tokens with deterministic fixture
economics.

**Step 7: Commit**

```powershell
git add docs/benchmarks/host-evaluations plugins/tokengraph/tests/paired-eval.test.ts docs/benchmarks/results-current.json docs/benchmarks/results-current.md
git commit -m "test(tokengraph): record real paired host evidence"
```

### Task 7: Finish R4 documentation and regenerate the release

**Files:**
- Modify: `README.md`
- Modify: `plugins/tokengraph/README.md`
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`
- Modify: `plugins/tokengraph/scripts/package-plugin.mjs`
- Modify: `release/tokengraph/**` (generated)
- Modify tests only where generated-copy contracts require it.

**Step 1: Write failing documentation/package contract tests**

Extend smoke or validation tests to require:

- benefit enum wording;
- distinct fixture and real-host evidence wording;
- exact-slice task count and charge;
- real-host manifest/report links and promotion state;
- no claim that one repository satisfies multi-repository B6 validation.

Run the focused tests and verify RED.

**Step 2: Update public and internal documentation**

State the frozen enum, R4 fixture metrics, exact-slice accounting, the exact real
host scope, and the recorded non-promotion/promotion outcome. Mark R4.1-R4.4
complete in roadmap status only when the checked-in evidence exists. Keep
enforcement and B7 activation wording consistent with the report.

**Step 3: Run focused tests and verify GREEN**

Run the documentation/smoke tests. Expected: PASS.

**Step 4: Regenerate release output**

From `plugins/tokengraph` run:

```powershell
pnpm package:plugin -- --release
pnpm validate:plugin
```

Expected: release regenerated and validation PASS.

**Step 5: Commit**

```powershell
git add README.md ROADMAP.md CHANGELOG.md plugins/tokengraph/README.md plugins/tokengraph/scripts/package-plugin.mjs release/tokengraph plugins/tokengraph/tests
git commit -m "docs(tokengraph): publish R4 evidence state"
```

### Task 8: Run the complete release gate and prove reproducibility

**Files:**
- Modify only if a gate exposes an R4 defect; use a new failing regression test
  before each production fix.

**Step 1: Run the full project gate from `plugins/tokengraph`**

```powershell
pnpm typecheck
pnpm test
pnpm benchmark
pnpm build
pnpm smoke -- --root . --surface full --json
pnpm validate:plugin
pnpm package:plugin -- --release
```

Expected: every command exits 0 except the separately recorded real-host
promotion command when its honest decision is non-promoting.

**Step 2: Verify generated release cleanliness**

Run `git diff --exit-code -- release/tokengraph` after the final package command.
Expected: no drift.

**Step 3: Verify text and path hygiene**

Scan tracked text for non-ASCII, CRLF, secrets, and personal Windows profile
paths using the existing project gates plus explicit `rg`/PowerShell checks.
Expected: no findings.

**Step 4: Verify source/release runtime parity**

Probe source and release MCP servers. Expected: eight core tools, 42 full tools,
enum routing output, artifact v5, and identical R4 contracts.

**Step 5: Review the final diff against R4.1-R4.4**

Map each acceptance criterion to production code, tests, current benchmark
artifacts, real-host manifest/report, and release files. Confirm routing remains
unenforced unless the report passes every gate.

**Step 6: Commit only if verification created a required correction**

Use a conventional `fix(tokengraph): ...` commit after its regression test.

### Task 9: Inventory stale merged branches and worktrees

**Files:**
- None.

**Step 1: Refresh and classify**

Run `git fetch --prune origin`, list worktrees, and calculate local/remote
branches fully merged into `main`/`origin/main`.

**Step 2: Inspect every linked candidate for changes**

Run `git status --short` in each candidate worktree. Separate clean merged,
dirty, unmerged, detached/prunable, and current R4 entries.

**Step 3: Present exact cleanup sets**

Report exact local worktree paths, local branch names, and remote branch names
that are both clean and fully merged. Do not remove anything until the user
explicitly approves those exact sets.

## Dated correction - 2026-07-22

The original frozen requirements above remain unchanged as the historical
execution record. Review of the first implementation identified two places
where those requirements were not strict enough. This correction supersedes
only the affected promotion and exact-slice rules.

### Stage-0 latency ceiling and evidence compatibility

The relative check that Stage-0 median latency is strictly below activation
median latency is necessary but not sufficient. Corrected schema-v3 promotion
evidence also fixes `stage0LatencyMaximumMs` at 5 and requires Stage-0 median
latency to be at most that ceiling. Schema-v1 and schema-v2 manifests remain
parseable for historical inspection, but neither may promote routing.

### Exact-slice locator contract

An exact-slice target must use exactly one locator: `{ file, symbol }` or
`{ file, startLine, endLine }`. Reject missing or combined locators, invalid
ranges, unresolved symbols, files outside `requiredFiles`, and tasks whose
targeted-read policy disallows the requested slice. The `debugging-01` fixture
uses `services/patientService.test.ts` lines 4-6. There is no first-symbol or
line-1 fallback for a file-only target.
