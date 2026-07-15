# TokenGraph Benchmark Methodology

TokenGraph's evidence benchmark is a deterministic regression harness against a checked-in fixture. It exercises the real indexer, planner, compressor, failure and risk analysis, graph/SQL/wiki retrieval, and memory review. It does not run an autonomous coding agent and is not universal proof of patch quality, host behavior, or billed-token reduction.

## Corpus and evidence isolation

`plugins/tokengraph/scripts/benchmark-corpus-v1.json` contains 30 task specifications across code routing, SQL/security, debugging, change risk, compression, memory/wiki, and release packaging. Each task declares public inputs plus evaluator-only critical constraints, required files, forbidden files, expected tests, and raw-read policy. Corpus validation requires at least 30 tasks and four tasks per category.

Independent task inputs, raw-baseline files, memories, and reproducible expected compact references live in `plugins/tokengraph/scripts/benchmark-evidence-v1.json`. Runtime flows do not derive their output or accounting from scoring labels. Anti-gaming tests mutate hidden labels and verify that core output and accounting do not change.

## Exact session and task lifecycle

One benchmark session measures the actual eight core `tools/list` definitions and one `tokengraph_setup` request/result exactly once, then amortizes that cost across all 30 tasks. Built-in raw-reader schemas are excluded because the comparison assumes the same host and they cancel on both sides.

Every activated task contains exactly one intent call and one `tokengraph_task_report` call. Planner tasks use `tokengraph_prepare_context`. Debugging uses a real bounded CLI-runner capture followed by `tokengraph_analyze`; compression uses a runner capture followed by `tokengraph_compress`; change-risk uses direct `tokengraph_analyze`; memory/wiki uses one direct review-mode `tokengraph_recall`. Direct intents omit `taskId`, auto-start the ledger, and return the task id consumed by the report. Each JSON-RPC response contains exactly one serialized JSON `TextContent` item. The compact report contains `status`, `taskId`, `footer`, and `reportingStatus`; verbose report internals are not part of the default benchmark path.

## Accounting

The primary baseline is category-appropriate acquisition, not a full index dump. Code, SQL, risk, memory, and release tasks use an already-minimal expert selection of raw reads. Each listed file contributes one explicit built-in `read_file` JSON-RPC request and one single-`TextContent` result. Debugging and compression instead compare a real noisy command capture with the runner-backed compact lifecycle. The net is:

`raw file requests and results - core intent request/result - compact report request/result - amortized discovery/setup`

The report publishes an execution-inclusive net as its primary savings metric. A recommended exact slice is not automatically executed: the benchmark charges a real hash-validated slice request/result only when the corpus explicitly declares an unresolved post-lifecycle evidence gap. This follows the production read-policy state machine and avoids fabricating unnecessary reads. A separate mutation test forces one slice and verifies its bytes against the indexed source. These remain fixture estimates, not provider billing. A full-index-dump token estimate is retained only as a diagnostic comparison.

Stage-0 bypasses are reported separately and never booked as non-negative savings. Activated-task economics alone feed the execution median, p25, and non-negative-rate gates.

For every task the harness also reports required-file recall, false positives, false negatives, exact critical-constraint preservation, recommended tests, estimated tokens, quality result, and explicit failure reasons. Constraint predicates normalize case, Unicode, whitespace, and punctuation without discarding words or polarity, so negation cannot pass through partial overlap.

## Release gate

The frozen release gate uses execution-inclusive savings as the primary metric and passes only when:

- the corpus has at least 30 tasks and four tasks in every category;
- critical-constraint preservation is 100%;
- critical false negatives are zero;
- required-file recall does not regress below the checked-in baseline; and
- median execution-inclusive net savings is positive for activated tasks;
- nearest-rank execution-inclusive p25 is non-negative; and
- at least 80% of activated tasks have non-negative execution-inclusive savings.

Task-level failures, bypasses, and the full execution-inclusive distribution remain visible. The v0.21.1 fixture passes with a +196.5-token activated-task median, +102.5-token p25, and 82.1% non-negative activated tasks. This deterministic gate does not by itself enable enforced routing; B6 promotion still requires a complete host-trace manifest and every paired-evaluation gate.

## Calibration and claim boundary

The report emits `taskCalibration` entries compatible with Task 1A. Each category has only four or five observations, so all calibration remains low-confidence and below the ten-observation activation threshold.

This harness proves repeatability against one synthetic local fixture and catches benchmark regressions. It does not prove universal agent output quality, exact billed-token reduction, or equivalent Codex and Claude behavior. Paired host runs on identical tasks, repository states, and acceptance checks remain separate release evidence.
