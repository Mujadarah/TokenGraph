# TokenGraph Benchmark Methodology

TokenGraph's evidence benchmark is a deterministic regression harness against a checked-in fixture. It exercises the real indexer, planner, compressor, failure and risk analysis, graph/SQL/wiki retrieval, and memory review. It does not run an autonomous coding agent and is not universal proof of patch quality, host behavior, or billed-token reduction.

## Corpus and evidence isolation

`plugins/tokengraph/scripts/benchmark-corpus-v1.json` contains 30 task specifications across code routing, SQL/security, debugging, change risk, compression, memory/wiki, and release packaging. Each task declares public inputs plus evaluator-only critical constraints, required files, forbidden files, expected tests, and raw-read policy. Corpus validation requires at least 30 tasks and four tasks per category.

Independent task inputs, raw-baseline files, memories, and reproducible expected compact references live in `plugins/tokengraph/scripts/benchmark-evidence-v1.json`. Runtime flows do not derive their output or accounting from scoring labels. Anti-gaming tests mutate hidden labels and verify that core output and accounting do not change.

## Exact session and task lifecycle

One benchmark session measures the actual eight core `tools/list` definitions and one `tokengraph_setup` request/result exactly once, then amortizes that cost across all 30 tasks. Built-in raw-reader schemas are excluded because the comparison assumes the same host and they cancel on both sides.

Every task contains exactly one intent call and one `tokengraph_task_report` call. Planner tasks use `tokengraph_prepare_context`. Debugging and change-risk tasks use direct `tokengraph_analyze`; compression uses direct `tokengraph_compress`; memory/wiki uses one direct review-mode `tokengraph_recall`. Direct intents omit `taskId`, auto-start the ledger, and return the task id consumed by the report. Each JSON-RPC response contains exactly one serialized JSON `TextContent` item. The compact report contains `status`, `taskId`, `footer`, and `reportingStatus`; verbose report internals are not part of the default benchmark path.

## Accounting

The raw routing baseline uses only each task's independent listed files. Each file contributes one explicit built-in `read_file` JSON-RPC request and one single-`TextContent` result. The routing-lifecycle net is:

`raw file requests and results - core intent request/result - compact report request/result - amortized discovery/setup`

This release gate deliberately measures whether TokenGraph can replace broad initial acquisition with focused routing. It excludes downstream source reads recommended by `firstReads`, so it is not a total-execution savings claim.

The report therefore publishes a second execution-inclusive net. It subtracts the actual built-in request/result pairs for recommended `firstReads` when the task allows raw reads. This is still a fixture estimate—not provider billing—but it makes product overhead and negative tails visible.

For every task the harness also reports required-file recall, false positives, false negatives, exact critical-constraint preservation, recommended tests, estimated tokens, quality result, and explicit failure reasons. Constraint predicates normalize case, Unicode, whitespace, and punctuation without discarding words or polarity, so negation cannot pass through partial overlap.

## Release gate

The deterministic routing-lifecycle gate passes only when:

- the corpus has at least 30 tasks and four tasks in every category;
- critical-constraint preservation is 100%;
- critical false negatives are zero;
- required-file recall does not regress below the checked-in baseline; and
- median routing-lifecycle net savings is positive.

Task-level failures and both routing and execution-inclusive distributions remain visible even when the aggregate gate passes. The gate does not require the execution-inclusive median to be positive and must not be described as total task savings.

## Calibration and claim boundary

The report emits `taskCalibration` entries compatible with Task 1A. Each category has only four or five observations, so all calibration remains low-confidence and below the ten-observation activation threshold.

This harness proves repeatability against one synthetic local fixture and catches benchmark regressions. It does not prove universal agent output quality, exact billed-token reduction, or equivalent Codex and Claude behavior. Paired host runs on identical tasks, repository states, and acceptance checks remain separate release evidence.
