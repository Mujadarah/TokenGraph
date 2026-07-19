# TokenGraph R3.4-R3.7 Completion Design

Status: approved direction on 2026-07-19.

## Goal

Complete audit items R3.4 through R3.7 without changing the frozen TokenGraph
v4 architecture: runner observations become scoped verified task outcomes,
task reports expose category economics, retrieval implements deterministic Git
recency and task-type weighting, and the trust documentation states the storage
and redaction limits accurately.

## Controlling requirements

This design is subordinate to and implements these checked-in plans:

- `docs/superpowers/specs/2026-07-15-tokengraph-roadmap-v4-design.md`
- `docs/superpowers/plans/2026-07-15-tokengraph-roadmap-v4.md`
- `docs/audits/2026-07-16-tokengraph-v0.21-audit.md`, specifically R3.4-R3.7

The binding v4 requirements are C1 identity and memory scoping, C2 canonical
serialization and artifact hashing, C3 storage security, C5 schema migration,
B1.4 category-level footer reporting, B2.6 deterministic retrieval signals,
B3.2 provenance-aware task outcomes, and B4 bounded runner capture.

## Scope

The phase contains exactly four behavior changes:

1. Link an explicitly selected active task to a saved CLI runner observation.
2. Add deterministic per-category detail to task reports and their canonical
   footer.
3. Rank lexically matched files with bounded Git commit recency and task-type
   boosts while retaining canonical BM25 as the base score.
4. Complete the C3 redaction, raw-capture, disable-capture, and encryption
   readiness documentation.

The phase does not add an MCP tool, change the eight-tool core or 42-tool full
surface, promote router enforcement, perform R4 evidence work, add encryption,
or treat an agent assertion as verified evidence.

## R3.4 - Runner observations and task outcomes

### Storage and provenance

Completed task ledgers remain the worktree-scoped outcome retention boundary
already recognized by the storage purge policy. The ledger schema increments
and gains a sorted, deduplicated `outcomes` collection containing the existing
`TaskOutcome` shape. Loading an older ledger migrates it with an empty outcome
collection instead of quarantining valid historical state.

A single outcome factory accepts a provenance class:

- `runner`, `hook`, or `filesystem-diff` creates a `verified` outcome.
- `agent` or `inferred` creates a `proposed` outcome.

Only the runner producer is wired in this phase. The complete classifier and
tests prevent later producers from bypassing the B3.2 review boundary.
Proposed outcomes remain review candidates in the ledger and are excluded from
recall; this phase adds no caller-controlled approval shortcut. Failed commands
are still verified observations: the fact is that the command exited with the
recorded failure status, not that the task succeeded.

Runner outcomes include the task ID, redacted command and arguments, run ID,
exact exit code, runner status, creation time, branch, worktree ID, and HEAD
commit. They reference the saved run but do not copy stdout or stderr into the
task ledger. This preserves the raw-capture retention boundary and avoids a
second secret-bearing store.

### CLI and data flow

`tokengraph run` gains an optional `--task-id <uuid>` argument. Omitting it
preserves standalone runner behavior. When it is supplied, the CLI performs
this sequence:

1. Resolve the trusted root and load the task ledger before spawning anything.
2. Require an open task in the same repository, worktree, and branch.
3. Execute the command with the existing bounded runner.
4. Apply quota checks and atomically save the redacted run capture.
5. Build a runner-provenance outcome from the saved run and current repository
   identity, then append it under the task-ledger lock.
6. Emit the compact runner summary and preserve the command exit semantics.

If task validation fails, the command is not started. If the capture succeeds
but outcome persistence fails, the capture remains recoverable and the CLI
reports that it was not linked; it never claims the outcome was recorded.

When a later task prepares context, completed ledgers are scanned within the
existing bounded worktree task directory. Their outcomes are passed through
`composeMemoryContext`, which already rejects proposed, stale, wrong-branch,
and wrong-worktree records. Repository-scoped reviewed decisions remain
unaffected.

## R3.5 - Category reporting in the canonical footer

`TaskReport` gains a `categories` array sorted by category name. Every entry
contains:

- category name and event count;
- low, likely, and high estimated-token range;
- confidence and overhead;
- the category calibration basis.

The aggregate estimate remains the primary number and continues to charge the
footer overhead. Category entries describe their qualifying events; they do
not hide negative values or pretend the reporting overhead belongs to a tool
category.

The canonical footer keeps its current aggregate and quality clauses, then
adds one deterministic category clause. Each category renders its range and
basis in sorted order. The no-event footer stays unchanged because there is no
category evidence to report.

The estimator version and task-ledger schema increment. Older completed
reports are reconstructed from their stored events using the new estimator,
so valid ledgers migrate without losing their prior event evidence. Compact
MCP task reports still return one footer string; verbose mode additionally
exposes the structured category array. The benchmark asserts the structured
schema and accounts for the longer serialized footer.

## R3.6 - Deterministic Git recency and task-type weighting

### Alternatives considered

Three sources can provide a recency signal:

1. Persist bounded Git commit distance during indexing. This is selected.
2. Run Git during every retrieval request. This repeats subprocess work and
   makes stable artifact construction harder to reason about.
3. Use filesystem modification time. This is rejected because checkout times
   differ across machines and would violate C2 cross-platform stability.

### Indexed signal

Project index schema version 4 gains optional retrieval signal metadata:

- source: `git-commit-distance` or `unavailable`;
- bounded history depth;
- a normalized path-to-commit-distance map.

Indexing makes one bounded, non-shell Git call for at most the latest 50
commits. NUL-delimited output is parsed without executing repository code.
The first occurrence of an indexed path determines its zero-based commit
distance. Paths are workspace-relative with forward slashes, filtered to the
indexed file set, and serialized in lexical order. Untracked files and non-Git
workspaces receive no recency boost. Git failure produces the explicit neutral
`unavailable` signal rather than failing indexing or inventing recency.

Because commit order and paths are properties of the selected Git history,
identical Git state produces identical metadata across Windows and Linux.
File mtime and ctime remain scan-freshness inputs only and never enter
retrieval scoring or stable artifact content.

### Pure scoring

Task classification moves to one shared pure helper so the planner and
retrieval scorer cannot disagree. Canonical BM25 remains the base score. Only
files with a positive lexical BM25 score are eligible; recency and task type
cannot introduce unrelated files.

The final score is:

`BM25 + recencyBoost + taskTypeBoost`

- For commit distance `d` from 0 through 49, `recencyBoost` is
  `0.15 * (50 - d) / 50`; paths absent from the map receive zero.
- `taskTypeBoost` uses only file facts already in the index: test tasks add
  0.20 to tests; database tasks add 0.20 to SQL; documentation tasks add 0.20
  to docs; bug tasks add 0.20 to tests and 0.10 to non-test modules, routes,
  and components; feature and refactor tasks add 0.15 to non-test modules,
  routes, and components; architecture tasks add 0.10 to modules and docs.
- Scores are rounded to six decimal places and ties fall back to lexical path
  order.

Graph expansion remains a separate deterministic stage after ranking.
Evidence provenance remains attached to capsule statements and exact-read
recommendations; it is not replaced by the recency or task-type signal.
Capsule artifact schema increments because default ranked selection semantics
change.

## R3.7 - Storage and redaction documentation

Both `docs/trust/security.md` and `docs/trust/privacy.md` will state all of the
following without claiming a feature that does not exist:

- secret redaction is best effort, not a guarantee;
- redacted raw captures are plaintext JSON under `.tokengraph/runs/` in the
  active worktree;
- TokenGraph has no always-on process capture, and capture is disabled
  entirely by not invoking `tokengraph run` and using ordinary host execution;
- regulated or highly sensitive output should not be sent through the runner;
- storage is not encrypted today; the storage interfaces and isolated write
  boundaries preserve the ability to add optional local encryption later.

## Error handling and compatibility

- Existing `tokengraph run` invocations without a task ID remain compatible.
- Invalid, missing, paused, completed, wrong-worktree, or wrong-branch task IDs
  fail before command execution.
- Old task ledgers and project indexes migrate or rebuild through versioned
  paths; newer unknown schemas continue to fail closed.
- Git history absence or failure removes only the recency boost. BM25 and
  task-type scoring continue deterministically.
- No outcome becomes verified from a caller-selected status value.
- No run output is duplicated into durable memory or model-facing task
  outcomes.

## Test strategy

Implementation follows red-green-refactor in these groups:

1. Runner integration tests create an active task, execute a real bounded
   command, and assert a verified branch/worktree/HEAD-scoped outcome with the
   exact command, exit code, and run reference. A marker-file fixture proves an
   invalid task fails before spawn. Agent provenance produces only a proposal.
2. Ledger migration tests load older ledgers and reports, preserve events, and
   rebuild the new outcome and category fields without quarantine.
3. Task estimator tests assert sorted category schema, negative category
   preservation, exact footer snapshots, idempotent completion, and byte-equal
   hook enforcement. Benchmark tests assert category output and serialized
   overhead accounting.
4. Retrieval tests use a real temporary Git repository with multiple commits
   to prove commit-distance ranking. Separate fixtures prove task-type
   tie-breaking, non-Git fallback, top-k limits, and identical results after
   changing filesystem timestamps without changing Git state.
5. Documentation contract tests assert all C3 disclosures in both trust files.
6. Release verification runs typecheck, the complete test suite, benchmark,
   build, full-surface smoke, plugin validation, release regeneration, and a
   clean generated-output diff.

## Acceptance mapping

- R3.4/B3.2: a real runner fixture yields a verified task outcome; agent-only
  provenance yields a proposal.
- R3.5/B1.4: the canonical footer and verbose report contain sorted category
  ranges and bases; the benchmark asserts the schema.
- R3.6/B2.6/C2: retrieval uses BM25, bounded Git commit distance, and shared
  task classification without filesystem-time drift.
- R3.7/C3: security and privacy documents disclose best-effort redaction, raw
  capture placement, complete capture avoidance, and encryption readiness.
