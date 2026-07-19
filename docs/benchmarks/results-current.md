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
- Routing: 27 tasks activate TokenGraph and three bounded tasks bypass at Stage 0, including the exact file-and-line debugging task. Against independent fixture truth labels, false-bypass and false-activation rates are both 0/27 and 0/3 respectively. All 30 shadow observations and per-category coverage remain published in `results-current.json`. Bypasses are not booked as savings.
- Delta delivery: the default no-handshake assumption resends 6,288 estimated tokens and books zero delta savings. When the host explicitly confirms every prior `id@hash`, the same fixture delivers 846 tokens and measures 5,442 estimated tokens saved. The handshake scenario is reported separately and is not part of the release-gate savings.
- Primary execution-inclusive median: +182.5 tokens; nearest-rank 25th percentile: +91.5; 22 of 27 activated tasks are non-negative (81.5%).
- Frozen execution-inclusive release gate: pass.

Execution-inclusive category results (bypassed tasks remain visible at zero but are excluded from activated-task gates):

| Category | Median | Non-positive |
|---|---:|---:|
| Code routing | 40.5 | 2/5 (both bypassed) |
| SQL/security | 236.5 | 0/5 |
| Debugging | 962.5 | 0/4 |
| Change risk | 9.0 | 2/4 |
| Compression | 1035.5 | 0/4 |
| Memory/wiki | -210.0 | 3/4 |
| Release packaging | 178.5 | 0/4 |

The release gate treats execution-inclusive savings as the primary eligibility metric. Exact source slices are charged only when a fixture declares an unresolved post-lifecycle evidence gap; the normal corpus does not fabricate reads after its compact evidence is sufficient. Negative tails remain visible, especially in memory/wiki and change-risk tasks.

Every category remains low-confidence and does not activate calibration. These are repeatable fixture estimates, not exact billed tokens, autonomous-agent patch-quality evidence, or universal Codex/Claude results.

2026-07-19 accounting note: these current results were regenerated after the estimator began charging the category-qualified completion footer. This is a deterministic accounting update; it does not add host evaluation evidence or change the R4 routing-promotion state.

The checked-in JSON-versus-tabular format experiment is negative: the tabular candidate did not improve token usage and quality simultaneously, so JSON remains the public default. See `docs/benchmarks/format-experiment.json`.
