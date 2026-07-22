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
- Exact implementation evidence: four edit/debug tasks perform one hash-validated source slice each, charging four targeted-read calls and 711 estimated tokens in total.
- Primary execution-inclusive median: +174.5 tokens; nearest-rank 25th percentile: +40.5; 22 of 27 activated tasks are non-negative (81.5%).
- Frozen execution-inclusive release gate: pass.

Execution-inclusive category results (bypassed tasks remain visible at zero but are excluded from activated-task gates):

| Category | Median | Non-positive |
|---|---:|---:|
| Code routing | 40.5 | 2/5 (both bypassed) |
| SQL/security | 236.5 | 0/5 |
| Debugging | 797.5 | 0/4 |
| Change risk | 9.0 | 2/4 |
| Compression | 1035.5 | 0/4 |
| Memory/wiki | -210.0 | 3/4 |
| Release packaging | 178.5 | 0/4 |

The release gate treats execution-inclusive savings as the primary eligibility metric. Exact source slices are charged only for the four checked-in tasks whose natural implementation outcome requires a hash-bound source span; other tasks do not fabricate reads after compact evidence is sufficient. Negative tails remain visible, especially in memory/wiki and change-risk tasks.

## Real-host paired evaluation

The corrected 2026-07-22 evaluation contains five counterbalanced ON/OFF pairs
for one implementation task in one repository and one category. All ten Codex
host turns and acceptance commands passed. The reviewed schema-v3 manifest
uses exact host-reported usage from `gpt-5.6-sol` on Codex CLI
`0.145.0-alpha.30`: 26,183,135 input tokens, including 25,191,424 cached input
tokens, and 168,284 output tokens. These values are not combined with the
fixture estimates above.

The ON conditions used 11,057,367 total tokens and OFF used 15,294,052. The
paired execution-inclusive savings estimate is +847,337 tokens, but the paired
interval crosses zero (-244,224.4 to +2,199,729.6), the median is -52,798, p25
is -291,203, and only two of five activated pairs are non-negative. Median
Stage 0 routing latency is approximately 0.0175 ms, within the frozen 5 ms
ceiling and faster than the 1,713.6 ms activation median.

Promotion remains disabled. Reviewed schema-v3 evidence, quality
non-inferiority, and both latency checks pass. Minimum samples, token
superiority, resource limits, router rates, execution median, execution p25,
and the 80% non-negative activated threshold fail. Five beneficial
observations produce a zero false-bypass rate, but the protocol contains no
bounded-task denominator and only five of the required ten category samples.
The structural failure is `router-shadow-sample-incomplete`; enforcement stays
off and B7 remains inactive. This one-repository result does not satisfy
multi-repository B6 validation. See the checked
`docs/benchmarks/host-evaluations/2026-07-22-tokengraph-codex-manifest.json`
and `docs/benchmarks/host-evaluations/2026-07-22-tokengraph-codex-report.md`.

The second eligible repository campaign evaluated `mattpocock/ts-reset` at a
pinned commit. Its five counterbalanced pairs also completed all ten host turns
and acceptance checks. ON used 4,140,943 total tokens and OFF used 4,790,975.
The paired execution-inclusive savings estimate is +130,006.4 tokens with an
interval of -222,194.2 to +458,705.6; the median is +371,094, p25 is -257,068,
and three of five activated pairs are non-negative. Median Stage 0 latency was
approximately 0.0389 ms and false bypasses were 0/5.

Promotion remains disabled for this result too. It passes reviewed schema-v3
evidence, quality non-inferiority, routing latency, and execution median, but
fails minimum samples, token superiority, resources, complete router rates,
execution p25, and the 80% non-negative threshold. This individual category
contains five of the required ten samples and no bounded-task denominator; the
aggregate multi-repository decision follows the third report below. See the checked
`docs/benchmarks/host-evaluations/2026-07-22-ts-reset-codex-manifest.json` and
`docs/benchmarks/host-evaluations/2026-07-22-ts-reset-codex-report.md`.

The third eligible campaign evaluated
`imbhargav5/nextbase-nextjs-supabase-starter` at a pinned commit. Its five
counterbalanced pairs completed all ten host turns and acceptance checks. ON
used 4,090,125 total tokens and OFF used 3,581,441. The paired
execution-inclusive savings estimate is -101,736.8 tokens with an interval of
-384,554.2 to +155,548.2; the median is -10,884, p25 is -211,447, and two of
five activated pairs are non-negative. Median Stage 0 latency was approximately
0.0209 ms and false bypasses were 0/5.

Promotion remains disabled for this result. It passes reviewed schema-v3
evidence, quality non-inferiority, and routing latency, but fails minimum
samples, token superiority, resources, complete router rates, execution median,
execution p25, and the 80% non-negative threshold. See the checked
`docs/benchmarks/host-evaluations/2026-07-22-nextbase-codex-manifest.json` and
`docs/benchmarks/host-evaluations/2026-07-22-nextbase-codex-report.md`.

The multi-repository B6 coverage target is now met: three repositories, three
categories, fifteen pairs, thirty accepted traces, and no retained failure in
the eligible manifests. The frozen promotion gates still do not all pass, so
routing remains in shadow mode and B7 polyglot indexing remains dark.

Every category remains low-confidence and does not activate calibration. These are repeatable fixture estimates, not exact billed tokens, autonomous-agent patch-quality evidence, or universal Codex/Claude results.

2026-07-19 accounting note: these current results were regenerated after the estimator began charging the category-qualified completion footer. This is a deterministic accounting update; it does not add host evaluation evidence or change the R4 routing-promotion state.

2026-07-19 R4 accounting note: the corpus now charges four exact source slices on edit/debug tasks and treats the explicit file-and-line debugging task as a Stage-0 bypass. The execution-inclusive median moved from +183.5 to +174.5 estimated tokens and p25 from +91.5 to +40.5; 22 of 27 activated tasks remain non-negative. These are deterministic fixture estimates, not real-host promotion evidence.

The checked-in JSON-versus-tabular format experiment is negative: the tabular candidate did not improve token usage and quality simultaneously, so JSON remains the public default. See `docs/benchmarks/format-experiment.json`.
