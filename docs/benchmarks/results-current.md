# Current Benchmark Results

Run from `plugins/tokengraph`:

```powershell
pnpm benchmark -- --json
```

The current deterministic `evidence-v1` corpus produces:

- Tasks: 30 across seven categories; every category has four or five observations.
- Exact core discovery plus setup: 1,929 estimated tokens total, or 64.3 amortized per task.
- Critical-constraint preservation: 100% under polarity-safe exact normalized predicates.
- Critical false negatives: 0.
- Required-file recall: 100% against the checked-in 0.85 baseline.
- Forbidden false positives: 0; missing expected-test recommendations: 0.
- Baseline: an already-minimal expert selection of recommended raw reads per task (not a full index dump).
- Execution-inclusive median after recommended first-file reads: -94.3 tokens; nearest-rank 25th percentile: -293.8; minimum: -537.8; 19 of 30 tasks are non-positive. This is the primary savings metric.
- Routing-lifecycle median: 5.7 tokens; nearest-rank 25th percentile: -291.8; minimum: -480.8; 15 of 30 tasks are non-positive.
- Frozen execution-inclusive release gate: fail (median must be positive).

Routing-lifecycle category results:

| Category | Median | Non-positive |
|---|---:|---:|
| Code routing | 53.2 | 2/5 |
| SQL/security | 249.2 | 0/5 |
| Debugging | -295.3 | 4/4 |
| Change risk | 20.7 | 2/4 |
| Compression | -319.3 | 4/4 |
| Memory/wiki | -233.3 | 3/4 |
| Release packaging | 191.7 | 0/4 |

The release gate now treats execution-inclusive savings as the primary eligibility metric and retains routing-lifecycle savings for continuity. The negative categories show that tiny, bounded raw inputs should bypass TokenGraph; use it where focused routing can avoid broader reads or preserve constraints.

Every category remains low-confidence and does not activate calibration. These are repeatable fixture estimates, not exact billed tokens, autonomous-agent patch-quality evidence, or universal Codex/Claude results.

The checked-in JSON-versus-tabular format experiment is negative: the tabular candidate did not improve token usage and quality simultaneously, so JSON remains the public default. See `docs/benchmarks/format-experiment.json`.
