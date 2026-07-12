# TokenGraph Benchmark Methodology

TokenGraph's evidence benchmark is a deterministic regression harness. It exercises the real project indexer, context planner, context compressor, failure tracer, change-risk assessor, and wiki builder against a checked-in fixture. It does not run an autonomous coding agent and is not universal proof of Codex, Claude, repository, patch, or token behavior.

## Corpus

`plugins/tokengraph/scripts/benchmark-corpus-v1.json` contains 30 distinct task specifications across code routing, SQL/security, debugging, change risk, compression, memory/wiki, and release packaging. Each task declares a stable id, query, critical constraints, required files, applicable forbidden false-positive files, expected tests, and whether targeted raw reads are allowed. Corpus validation requires at least 30 tasks and at least four tasks in every category.

The checked-in `plugins/tokengraph/tests/fixtures/evidence-project` contains route, service, test, authorization, audit, compression, memory, SQL migration, documentation, smoke, validation, and packaging evidence. The fixture is deliberately small enough to audit and broad enough to expose routing differences among tasks.

## Task metrics

For each task the harness reports required-file recall, false positives, false negatives, critical-constraint preservation, recommended tests, estimated raw tokens, compact tokens, tool/footer overhead, net estimated savings, a quality result, and explicit failure reasons. Required files and forbidden files are scoring labels; they are not injected into the primary task query. Core results and indexed import relationships determine the selected scope.

Raw tokens are the sum of the indexed fixture files. Compact tokens use the larger of the planner and context-compressor estimates. Overhead is a deterministic estimate of 18 tokens per exercised core operation plus a 20-token compact footer. Net savings subtract both compact context and overhead from the raw baseline. These are estimates, not tokenizer billing measurements.

## Release gate

The deterministic release gate passes only when all of these conditions hold:

- The corpus contains at least 30 tasks.
- Every category contains at least four tasks.
- Critical-constraint preservation is 100%.
- Critical false negatives are zero.
- Required-file recall does not regress below the checked-in corpus baseline.
- Median net estimated savings is positive after tool and footer overhead.

Task-level false-positive failures remain visible even when the release gate passes. This distinction prevents the release gate from silently acquiring criteria that are not part of its versioned contract.

## Calibration

The report emits task-estimator-v1 calibration entries by category. A residual is the deterministic token cost of selected forbidden files or missed required files, expressed as a non-positive adjustment to the task's net estimate. The low and high residual fields are nearest-rank 10th and 90th percentiles. Observation order, quantiles, and serialization are deterministic.

Task 1A consumes `observations`, `lowResidual`, and `highResidual`. Fewer than 10 observations never establishes calibrated confidence. Every current category therefore remains explicitly low-confidence even though its residual quantiles are emitted.

## Claim boundary

This harness proves repeatability against one synthetic local fixture and catches benchmark regressions. It does not prove universal agent output quality, real billed-token reduction, or equivalent behavior across hosts. Paired Codex and Claude runs on identical tasks, repository states, and acceptance checks remain a later release gate.
