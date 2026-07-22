# ts-reset Real-host Paired Evaluation (2026-07-22)

## Scope

- Repository: `mattpocock/ts-reset` at `cfc8c1a992650eb17f75fef526dc9185c312dac2`.
- Task: repair contextual generic inference for the `Map` constructor.
- Category: `type-system`.
- Plugin: TokenGraph `0.22.0` at `5821e84a3ec66a719c49b3d770ecbf9ce26247e0`.
- Host: Codex CLI `0.145.0-alpha.30`, model `gpt-5.6-sol`, high reasoning.
- Protocol: five counterbalanced ON/OFF pairs under the attested elevated Windows sandbox, with network access disabled.
- Acceptance: a hidden, read-only TypeScript compiler verifier. All ten host turns and all ten acceptance checks passed.

Raw host transcripts remain private because they can contain machine-local paths and host metadata. The reviewed schema-v3 manifest contains normalized evidence and exact host-reported usage.

An initial preflight trace used an acceptance check that was coupled to the historical implementation's helper name. That preflight was stopped and excluded from the eligible manifest. The corrected verifier was proved RED on the pinned base and GREEN on the historical fix before the campaign restarted under a new evaluation ID.

## Exact host usage

| Metric | Value |
|---|---:|
| Input tokens | 8,829,105 |
| Cached input tokens | 8,312,064 |
| Output tokens | 102,813 |
| Reasoning output tokens | 47,350 |
| ON total tokens | 4,140,943 |
| OFF total tokens | 4,790,975 |
| ON tool calls | 159 |
| OFF tool calls | 174 |

Pair savings are OFF execution-inclusive tokens minus ON execution-inclusive tokens:

| Repeat | Order | OFF | ON | Savings |
|---:|---|---:|---:|---:|
| 1 | OFF first | 915,942 | 544,848 | +371,094 |
| 2 | ON first | 1,144,342 | 722,612 | +421,730 |
| 3 | ON first | 1,252,385 | 712,898 | +539,487 |
| 4 | ON first | 896,240 | 1,321,451 | -425,211 |
| 5 | ON first | 582,066 | 839,134 | -257,068 |

The mean execution-inclusive savings estimate is +130,006.4 tokens and its paired interval is -222,194.2 to +458,705.6. The median is +371,094, p25 is -257,068, and three of five activated pairs are non-negative.

## Promotion decision

Promotion and enforcement remain disabled.

Reviewed schema-v3 evidence, quality non-inferiority, the Stage 0 latency ceiling, activation-relative latency, and the execution median pass. Minimum category samples, token superiority, resource limits, router-rate completeness, execution p25, and the 80% non-negative activated threshold fail. The five beneficial routing observations have zero false bypasses, but there is no bounded-task denominator. The structural failure remains `router-shadow-sample-incomplete`.

This result expands eligible coverage to a second repository and a second category. It does not complete the three-repository B6 target by itself.
