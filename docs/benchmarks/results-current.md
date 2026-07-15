# Current Benchmark Results

Run from `plugins/tokengraph`:

```powershell
pnpm benchmark -- --json
```

The current deterministic `evidence-v1` corpus produces:

- Tasks: 30 across seven categories; every category has four or five observations.
- Exact core discovery plus setup: 2,354 estimated tokens total, or 78.5 amortized per task.
- Critical-constraint preservation: 100% under polarity-safe exact normalized predicates.
- Critical false negatives: 0.
- Required-file recall: 100% against the checked-in 0.85 baseline.
- Forbidden false positives: 0; missing expected-test recommendations: 0.
- Baseline: category-appropriate acquisition. Code, SQL, risk, memory, and release tasks use an already-minimal expert selection of raw reads; debugging and compression use the real noisy command output captured by the runner.
- Routing: 28 tasks activate TokenGraph and two narrowly bounded code lookups bypass at Stage 0. Bypasses are not booked as savings.
- Primary execution-inclusive median: +196.5 tokens; nearest-rank 25th percentile: +102.5; 23 of 28 activated tasks are non-negative (82.1%).
- Frozen execution-inclusive release gate: pass.

Execution-inclusive category results (bypassed tasks remain visible at zero but are excluded from activated-task gates):

| Category | Median | Non-positive |
|---|---:|---:|
| Code routing | 53.5 | 2/5 (both bypassed) |
| SQL/security | 249.5 | 0/5 |
| Debugging | 975.5 | 0/4 |
| Change risk | 20.0 | 2/4 |
| Compression | 1050.5 | 0/4 |
| Memory/wiki | -194.0 | 3/4 |
| Release packaging | 191.5 | 0/4 |

The release gate treats execution-inclusive savings as the primary eligibility metric. Exact source slices are charged only when a fixture declares an unresolved post-lifecycle evidence gap; the normal corpus does not fabricate reads after its compact evidence is sufficient. Negative tails remain visible, especially in memory/wiki and change-risk tasks.

Every category remains low-confidence and does not activate calibration. These are repeatable fixture estimates, not exact billed tokens, autonomous-agent patch-quality evidence, or universal Codex/Claude results.

The checked-in JSON-versus-tabular format experiment is negative: the tabular candidate did not improve token usage and quality simultaneously, so JSON remains the public default. See `docs/benchmarks/format-experiment.json`.
