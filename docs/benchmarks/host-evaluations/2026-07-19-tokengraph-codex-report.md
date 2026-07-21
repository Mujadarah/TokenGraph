# TokenGraph Real-Host Paired Evaluation

This report records the first reviewed schema-v2 real-host evaluation for the
R4 routing contract. It is intentionally separate from deterministic fixture
economics.

## Scope

- Task: implement the frozen `expectedBenefit` enum contract.
- Base repository commit: `11129c2b262e5bdd282c153e9940a0c7d3620262`.
- Plugin evidence commit: `2f2076df7a310efb546d824293464a99b4ec1861`.
- Host: Codex CLI `0.145.0-alpha.27` with model `gpt-5.6-sol`, high reasoning.
- Repeats: five counterbalanced ON/OFF pairs in the `code` category.
- Acceptance: focused routing and retrieval tests plus TypeScript typecheck.

All ten host turns completed, all ten acceptance commands passed, and every
trace contains exact host-reported usage. Raw event streams remain local and
are not checked in.

## Exact host usage

| Metric | Value |
|---|---:|
| Total input tokens | 18,029,573 |
| Cached input tokens | 17,122,816 |
| Output tokens | 154,673 |
| Reasoning output tokens | 66,904 |
| ON total tokens | 8,500,992 |
| OFF total tokens | 9,683,254 |
| Paired execution-inclusive savings estimate | +236,452.4 |
| Paired interval | -425,846.6 to +1,032,365.6 |

The paired interval crosses zero, so these five pairs do not establish token
superiority despite positive median execution-inclusive savings.

## Router and promotion decision

| Gate | Result |
|---|---|
| Reviewed real-host evidence | Pass |
| Quality non-inferiority | Pass |
| Stage 0 faster than activation | Pass |
| Execution median | Pass |
| Minimum category samples | Fail: 5 of 10 required |
| Token superiority | Fail |
| Resource limit | Fail |
| Router rates | Fail: no bounded-task denominator |
| Execution p25 | Fail: -557,686 |
| Non-negative activated rate | Fail: 0.60 |

The false-bypass rate is 0 across five beneficial observations. The
false-activation rate is unavailable because this single-task protocol has no
bounded-task observation. Median Stage 0 routing latency is approximately
0.077 ms versus 2,155.5 ms for activation.

Promotion is **disabled**. The recorded failure is
`router-shadow-sample-incomplete`, and routing enforcement remains off. This
one-repository, one-category evaluation does not satisfy multi-repository B6
validation.
