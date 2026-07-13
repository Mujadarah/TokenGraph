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
- Routing-lifecycle median: 31.7 tokens; nearest-rank 25th percentile: -270.3; minimum: -457.3; 15 of 30 tasks are non-positive.
- Execution-inclusive median after recommended first-file reads: -133.8 tokens; nearest-rank 25th percentile: -457.3; minimum: -522.3; 20 of 30 tasks are non-positive.
- Deterministic routing-lifecycle release gate: pass.

Routing-lifecycle category results:

| Category | Median | Non-positive |
|---|---:|---:|
| Code routing | 79.7 | 2/5 |
| SQL/security | 275.7 | 0/5 |
| Debugging | -271.8 | 4/4 |
| Change risk | 41.7 | 2/4 |
| Compression | -303.8 | 4/4 |
| Memory/wiki | -209.8 | 3/4 |
| Release packaging | 217.7 | 0/4 |

The routing gate excludes downstream recommended source reads and is not a total-execution savings claim. The execution-inclusive metric exposes that cost separately. The negative categories show that tiny, bounded raw inputs should bypass TokenGraph; use it where focused routing can avoid broader reads or preserve constraints.

Every category remains low-confidence and does not activate calibration. These are repeatable fixture estimates, not exact billed tokens, autonomous-agent patch-quality evidence, or universal Codex/Claude results.
