# TokenGraph R4 Evidence Completion Design

Date: 2026-07-19
Status: Approved for implementation

## Purpose

Complete audit items R4.1 through R4.4 without weakening the frozen TokenGraph
roadmap contracts or presenting deterministic fixture evidence as autonomous
agent evidence.

The phase publishes router accuracy and latency evidence, charges exact source
reads on real edit-shaped benchmark tasks, records the first real paired Codex
host evaluation on this repository, and aligns the routing benefit contract with
the frozen enum.

## Controlling sources

Apply these sources in order:

1. `docs/superpowers/specs/2026-07-15-tokengraph-roadmap-v4-design.md` and
   `docs/superpowers/plans/2026-07-15-tokengraph-roadmap-v4.md`.
2. `docs/audits/2026-07-16-tokengraph-v0.21-audit.md`, specifically R4.1-R4.4.
3. The supplied frozen roadmap v4, with roadmap v3 consulted only for the
   `expectedBenefit` enum that v4 names but does not repeat.
4. This design for implementation details that the sources above leave open.

The user explicitly selected the frozen contract
`none | low | medium | high`. No numeric expected-benefit estimate remains in a
routing response or shadow trace after this phase.

## Scope

This phase contains four connected changes:

1. Publish Section 7.1 router accuracy, coverage, and latency evidence and fix
   the bounded exact-location misroute.
2. Charge exact source slices on a nonzero, reviewable set of edit-shaped corpus
   tasks and restate the deterministic benchmark results.
3. Capture and evaluate a real, counterbalanced TokenGraph ON/OFF Codex host
   run on the TokenGraph repository.
4. Replace numeric `expectedBenefit` values with the frozen enum and version all
   affected stable and evaluation artifacts.

The phase does not enable enforced routing, broaden public savings claims, add a
new language parser, or treat a one-repository host run as multi-repository
validation. Branch and worktree cleanup is a separate repository-maintenance
operation and is not part of the R4 code diff.

## R4.1 - Router metrics and bounded exact locations

### Routing truth

Every deterministic benchmark task carries an independent expected routing
label:

- `activate` for tasks that need repository discovery or cross-file evidence;
- `bypass` for bounded tasks that already identify the exact local target.

The benchmark compares the shadow decision with that label. Rates use the
Section 7.1 denominators rather than all observations:

- false-bypass rate = beneficial tasks incorrectly bypassed / beneficial tasks;
- false-activation rate = bounded tasks incorrectly activated / bounded tasks.

The report also includes total observations, activated and bypassed counts, and
sorted per-category coverage. A zero denominator is reported as unavailable and
cannot pass a promotion gate.

### Exact-location rule

Stage 0 recognizes one repository-relative source path, optionally followed by
a line or line-column reference, as bounded only when all of these hold:

- the prompt is short and describes a local lookup or edit;
- exactly one target path is present;
- no repository-wide, architecture, migration, dependency, security, debug,
  regression, or all-files language is present;
- no force-on mode overrides the advisor.

Examples such as `Fix src/core/routingAdvisor.ts:42` bypass at Stage 0. A prompt
such as `Review the repository security boundary around
src/core/routingAdvisor.ts:42` still activates. The reason is derived from the
final decision so `bounded-task` never accompanies activation and discovery
reasons never accompany bypass.

### Latency evidence

Deterministic fixture results and real runtime measurements remain separate.
The deterministic corpus publishes routing accuracy and coverage. The real host
manifest records monotonic elapsed milliseconds for:

- the Stage 0 routing decision; and
- context activation through the first usable TokenGraph context response.

The paired evaluator publishes sample counts, medians, and whether Stage 0 is
strictly faster. Missing, negative, non-finite, or mixed-clock observations are
invalid. Latency is diagnostic and machine-specific; it is never folded into a
stable artifact hash or presented as cross-machine reproducible.

`docs/benchmarks/results-current.json` and its Markdown projection show fixture
router accuracy and the latest reviewed real-host latency evidence in distinct,
clearly labeled sections.

## R4.2 - Execution-inclusive exact-slice accounting

The corpus currently contains zero `requiresExactSlice` tasks. R4 marks a
nonzero set using an explicit rule: a task is charged when its natural accepted
outcome edits code, SQL, tests, or release configuration and its compact
lifecycle evidence does not already contain the exact source span needed for
that edit.

The implementation plan enumerates every selected task ID. Bounded lookups,
prose-only memory/wiki work, pure output compression, and tasks whose supplied
runtime evidence is already exact remain uncharged. Each selected task must
have a checked-in required file and a hash-validated slice target; a Boolean
flag without a resolvable target is a corpus error.

The benchmark reports the exact-slice task count, targeted-read call count, and
targeted-read token charge. The release gate then recomputes execution-inclusive
median, p25, non-negative rate, and category results from those charges.

Because the published Unreleased numbers change, `CHANGELOG.md` receives a dated
R4 accounting note. Published version entries remain untouched.

## R4.3 - Real paired Codex host evaluation

### Evidence boundary

The existing synthetic paired fixture remains a parser and statistics test. It
can never authorize promotion. A manifest identifies its evidence source as one
of:

- `fixture`, for checked-in deterministic test data; or
- `real-host`, for traces produced by an actual supported host invocation.

Only reviewed `real-host` evidence is eligible for a promotion decision.
Eligibility still requires every frozen quality, token, resource, router-rate,
latency, sample-size, and category-coverage gate.

### Host-run protocol

The R4 harness drives the locally installed Codex CLI through a configurable
adapter. It refuses to run when the executable, JSON event stream, token usage,
model identity, or acceptance command cannot be verified. It never substitutes
estimated tokens for missing host usage.

The first run uses the TokenGraph repository at one fixed commit. Each task has
the same prompt template, model identifier, reasoning level, acceptance
command, and starting commit under both conditions:

- ON exposes the built TokenGraph plugin in shadow mode;
- OFF disables TokenGraph and uses normal host repository tools.

Order is deterministically counterbalanced from the manifest seed. At least
five repeats per task are retained, including failures, timeouts, invalid host
responses, and failed acceptance commands. ON and OFF execute in separate
temporary Git worktrees. A run never reuses another condition's task worktree.

Raw host event streams and command output stay in git-excluded
`.tokengraph/runs/` storage. The checked-in reviewed manifest contains only the
allowlisted protocol metadata and normalized measurements needed for audit:

- exact host/model/plugin/repository versions and commits;
- prompt-template identifier and hash, tool configuration, cache/index state,
  condition order, and repeat number;
- input, output, and execution-inclusive token counts reported by the host;
- quality score and acceptance-command result;
- timeout/failure status and bounded failure class;
- router decision, stage, reason, expected overhead, benefit enum, truth label,
  and false-decision flags;
- monotonic routing and activation latency measurements for ON observations.

No prompt transcript, model response, absolute personal path, secret, or raw
command output is checked in.

### Report and promotion decision

The reviewed manifest and generated report live under
`docs/benchmarks/host-evaluations/`. The report includes paired per-task
differences, bootstrap intervals, retained failures, quality non-inferiority,
token superiority, fallback reads, router rates, latency, resource gates, and
category coverage.

One real repository satisfies the R4.3 evidence milestone but not the frozen
multi-repository ambition by itself. The report records the promotion decision
either way and names every failing or unavailable gate. Routing remains
unenforced unless all gates pass. B7 remains promotion-gated.

## R4.4 - Benefit enum and schema versions

`RoutingDecision.expectedBenefit` becomes:

```text
none | low | medium | high
```

The deterministic mapping is:

- bypass, kill-switch, force-bypass, and fail-open: `none`;
- Stage 0 activation: `medium`;
- Stage 1 indexed activation: `high`.

`low` is reserved for a future measured weak-activation class and is not
invented for this release.

Stable retrieval artifacts move from schema v4 to v5 because routing and
retrieval evidence semantics change together in the public R4 contract. Existing
artifacts remain hash-verifiable and fetchable by their stored schema version,
but newly generated artifacts use v5 and cannot collide with v4 hashes.

Paired-evaluation manifests and promotion reports move to schema v2. Schema-v1
fixtures remain readable for regression tests, are labeled legacy fixture
evidence, and are never promotion-eligible. A schema-v2 promotion report must
carry real-host provenance plus all new router accuracy and latency fields.

## Failure handling and trust

- Invalid benchmark routing labels or exact-slice targets fail corpus loading.
- Invalid or incomplete host traces remain retained failures; they are not
  dropped from paired counts.
- A host adapter failure cannot create or overwrite promotion evidence.
- A failed evaluation writes a non-promoting report and returns a failing CLI
  status without changing the global routing mode.
- Runtime latency and host identifiers are excluded from canonical stable
  artifact hashes.
- Raw captures follow existing quotas, retention, redaction disclaimers, and
  purge behavior.

## Test strategy

Implementation follows red-green-refactor cycles.

1. Router unit tests prove exact file-and-line bypass, broad-task activation,
   reason consistency, enum values, and v5 artifact hashes.
2. Benchmark tests fail with missing truth labels or unresolved slice targets,
   prove nonzero real-corpus slice charging, and lock the regenerated aggregate
   and router metrics.
3. Paired-evaluation tests prove denominator-correct router rates, monotonic
   latency validation, schema-v1 non-promotion, schema-v2 real-host eligibility,
   retained failures, and deterministic report rendering.
4. Host-harness tests use a fake executable and JSON event stream to prove
   counterbalancing, isolation, exact metadata, missing-usage refusal, and raw
   capture confinement before a live Codex run is attempted.
5. CLI and MCP smoke tests prove the enum is exposed consistently without
   changing the eight-tool core or 42-tool compatibility surfaces.
6. The checked-in real-host manifest is validated by the same production parser
   used by `tokengraph evaluate-routing`.

## Completion evidence

R4 is complete only when all of the following are true:

- `expectedBenefit` is the frozen enum everywhere and new artifacts are v5;
- the explicit file-and-line probe bypasses correctly at Stage 0;
- current benchmark JSON and Markdown publish router rates, coverage, nonzero
  exact-slice charges, and restated execution-inclusive results;
- a reviewed schema-v2 real Codex host manifest and generated report exist for
  this repository, with a recorded promotion decision;
- enforced routing remains off unless every frozen gate actually passes;
- `release/tokengraph/` is regenerated;
- typecheck, tests, benchmark, build, full-surface smoke, plugin validation,
  ASCII/LF checks, and generated-release reproducibility all pass freshly.
