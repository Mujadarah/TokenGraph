# TokenGraph Corrected Real-Host Paired Evaluation

This report records the reviewed schema-v3 real-host evaluation produced by
the corrected 2026-07-22 protocol. It is separate from deterministic fixture
economics and supersedes the 2026-07-19 schema-v2 run for promotion decisions.

## Scope

- Task: implement the frozen `expectedBenefit` enum contract.
- Base repository commit: `11129c2b262e5bdd282c153e9940a0c7d3620262`.
- Attested plugin: TokenGraph `0.21.1` at
  `934c5c1114668e4d5161f2314f67f593e294044d`.
- Host: Codex CLI `0.145.0-alpha.30` with model `gpt-5.6-sol`, high reasoning.
- Sandbox: approval policy `never`, elevated Windows sandbox, network disabled,
  least-privilege controller and dependency access.
- Repeats: five counterbalanced ON/OFF pairs in the `code` category.
- Acceptance: focused routing and retrieval tests plus TypeScript typecheck.

All ten host turns completed, all ten acceptance commands passed, and every
trace contains exact host-reported usage. Raw event streams remain local and
are not checked in.

## Exact host usage

| Metric | Value |
|---|---:|
| Total input tokens | 26,183,135 |
| Cached input tokens | 25,191,424 |
| Output tokens | 168,284 |
| Reasoning output tokens | 78,105 |
| ON total tokens | 11,057,367 |
| OFF total tokens | 15,294,052 |
| Paired execution-inclusive savings estimate | +847,337 |
| Paired interval | -244,224.4 to +2,199,729.6 |

The paired interval crosses zero, so these five pairs do not establish token
superiority. Pair savings were +3,208,981, -292,959, -52,798, +1,664,664,
and -291,203 tokens.

## Router and promotion decision

| Gate | Result |
|---|---|
| Reviewed schema-v3 real-host evidence | Pass |
| Quality non-inferiority | Pass |
| Stage 0 latency ceiling | Pass: 0.0175 ms median <= 5 ms ceiling |
| Stage 0 faster than activation | Pass: 1,713.6 ms activation median |
| Minimum category samples | Fail: 5 of 10 required |
| Token superiority | Fail: interval crosses zero |
| Resource limit | Fail |
| Router rates | Fail: no bounded-task denominator |
| Execution median | Fail: -52,798 |
| Execution p25 | Fail: -291,203 |
| Non-negative activated rate | Fail: 0.40 |

The false-bypass rate is 0 across five beneficial observations. The
false-activation rate is unavailable because this single-task protocol has no
bounded-task observation.

Promotion is **disabled**. The structural failure recorded by `pairedEval` is
`router-shadow-sample-incomplete`; the other failed gates independently keep
`enforcementEnabled` false. Routing therefore remains in shadow mode and B7
polyglot indexing remains inactive. This one-repository, one-category result
does not satisfy multi-repository B6 validation.
