# TokenGraph Benchmark Methodology

TokenGraph's evidence benchmark is a deterministic regression harness. It exercises the real project indexer, context planner, context compressor, failure tracer, change-risk assessor, and wiki builder against a checked-in fixture. It does not run an autonomous coding agent and is not universal proof of Codex, Claude, repository, patch, or token behavior.

## Corpus

`plugins/tokengraph/scripts/benchmark-corpus-v1.json` contains 30 distinct task specifications across code routing, SQL/security, debugging, change risk, compression, memory/wiki, and release packaging. Each task declares a stable id, query, critical constraints, required files, applicable forbidden false-positive files, expected tests, and whether targeted raw reads are allowed. Corpus validation requires at least 30 tasks and at least four tasks in every category.

The checked-in `plugins/tokengraph/tests/fixtures/evidence-project` contains route, service, test, authorization, audit, compression, memory, SQL migration, documentation, smoke, validation, and packaging evidence. Independent task inputs and expected-net observations live in `plugins/tokengraph/scripts/benchmark-evidence-v1.json`; they are not derived from corpus scoring labels at runtime.

## Task metrics

For each task the harness reports required-file recall, false positives, false negatives, critical-constraint preservation, recommended tests, estimated raw tokens, compact tokens, schema/footer overhead, net estimated savings, a quality result, and explicit failure reasons. Required files, forbidden files, critical constraints, expected tests, and targeted-raw-read expectations are scoring labels only. Mutating them does not change the core input, output, accounting, or recommendations.

Each category has one mutually exclusive flow: planner for code routing, SQL/security, and release packaging; tracer for debugging; risk assessment for change risk; compressor for compression; and a combined wiki/memory-review flow for memory/wiki tasks. The report includes the one serialized core output it scores. Compact tokens are estimated from that exact serialized output.

Raw tokens come from the task's independent, explicitly listed fixture files rather than the entire fixture. Schema overhead is estimated from the flow's serialized tool/schema envelope, and footer overhead is estimated from the benchmark caution footer. Net savings subtract compact, schema, and footer costs from the per-task raw baseline. These are estimates, not tokenizer billing measurements.

## Release gate

The deterministic release gate passes only when all of these conditions hold:

- The corpus contains at least 30 tasks.
- Every category contains at least four tasks.
- Critical-constraint preservation is 100%.
- Critical false negatives are zero.
- Required-file recall does not regress below the checked-in corpus baseline.
- Median net estimated savings is positive after tool and footer overhead.

Task-level false-positive, false-negative, preservation, test-recommendation, and net-savings failures remain visible. The current evidence does not force the release gate to pass.

## Calibration

The report emits a direct `taskCalibration` object matching Task 1A's `TaskCalibration` type plus explanatory calibration metadata. Each evidence entry contains independent expected-net observations. A residual is expected net savings minus the estimator's net result after actual compact, schema, and footer costs. The low and high residual fields are nearest-rank 10th and 90th percentiles. Observation order, quantiles, and serialization are deterministic.

Task 1A consumes `observations`, `lowResidual`, and `highResidual`. Fewer than 10 observations never establishes calibrated confidence. The current evidence supplies 12 or 15 observations per category; an integration test proves the emitted projection changes Task 1A's estimate range.

## Claim boundary

This harness proves repeatability against one synthetic local fixture and catches benchmark regressions. It does not prove universal agent output quality, real billed-token reduction, or equivalent behavior across hosts. Paired Codex and Claude runs on identical tasks, repository states, and acceptance checks remain a later release gate.
