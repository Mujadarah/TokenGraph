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
- Execution-inclusive median after recommended first-file reads: -86.0 tokens; nearest-rank 25th percentile: -292.0; minimum: -536.0; 18 of 30 tasks are non-positive. This is the primary savings metric.
- Routing-lifecycle median: 20.0 tokens; nearest-rank 25th percentile: -290.0; minimum: -478.0; 15 of 30 tasks are non-positive.
- Deterministic routing-lifecycle release gate: pass.

Routing-lifecycle category results:

| Category | Median | Non-positive |
|---|---:|---:|
| Code routing | 68.0 | 2/5 |
| SQL/security | 264.0 | 0/5 |
| Debugging | -293.5 | 4/4 |
| Change risk | 22.5 | 2/4 |
| Compression | -317.5 | 4/4 |
| Memory/wiki | -230.5 | 3/4 |
| Release packaging | 206.0 | 0/4 |

The deterministic release gate still checks routing-lifecycle savings for continuity, while the execution-inclusive metric is the primary product metric and includes downstream recommended source reads. The negative categories show that tiny, bounded raw inputs should bypass TokenGraph; use it where focused routing can avoid broader reads or preserve constraints.

Every category remains low-confidence and does not activate calibration. These are repeatable fixture estimates, not exact billed tokens, autonomous-agent patch-quality evidence, or universal Codex/Claude results.

The checked-in JSON-versus-tabular format experiment is negative: the tabular candidate did not improve token usage and quality simultaneously, so JSON remains the public default. See `docs/benchmarks/format-experiment.json`.
