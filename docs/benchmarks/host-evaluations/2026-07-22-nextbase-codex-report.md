# Nextbase Real-host Paired Evaluation (2026-07-22)

## Scope

- Repository: `imbhargav5/nextbase-nextjs-supabase-starter` at `d1e7923957b9a9aa996c3bb8c7aaca9938db3b11`.
- Task: preserve the field name and existing fallback when a fielded `ValidationError` has an empty message.
- Category: `frontend`.
- Plugin: TokenGraph `0.22.0` at `5821e84a3ec66a719c49b3d770ecbf9ce26247e0`.
- Host: Codex CLI `0.145.0-alpha.30`, model `gpt-5.6-sol`, high reasoning.
- Protocol: five counterbalanced ON/OFF pairs under the attested elevated Windows sandbox, with network access disabled.
- Acceptance: a hidden, read-only source and test verifier. All ten host turns and all ten acceptance checks passed.

Raw host transcripts remain private because they can contain machine-local paths and host metadata. The reviewed schema-v3 manifest contains normalized evidence and exact host-reported usage.

Two preflight attempts were excluded from eligible evidence. The first exposed a Windows long-path worktree setup requirement; the second ended before task execution when the host was temporarily unavailable. The corrected long-path preflight was proved independently, host availability was rechecked, and the complete campaign restarted under a fresh evaluation ID.

## Exact host usage

| Metric | Value |
|---|---:|
| Input tokens | 7,598,457 |
| Cached input tokens | 7,063,040 |
| Output tokens | 73,109 |
| Reasoning output tokens | 31,404 |
| ON total tokens | 4,090,125 |
| OFF total tokens | 3,581,441 |
| ON tool calls | 99 |
| OFF tool calls | 116 |

Pair savings are OFF execution-inclusive tokens minus ON execution-inclusive tokens:

| Repeat | Order | OFF | ON | Savings |
|---:|---|---:|---:|---:|
| 1 | OFF first | 529,962 | 1,174,177 | -644,215 |
| 2 | OFF first | 1,104,442 | 788,779 | +315,663 |
| 3 | OFF first | 601,309 | 812,756 | -211,447 |
| 4 | OFF first | 695,757 | 653,558 | +42,199 |
| 5 | ON first | 649,971 | 660,855 | -10,884 |

The mean execution-inclusive savings estimate is -101,736.8 tokens and its paired interval is -384,554.2 to +155,548.2. The median is -10,884, p25 is -211,447, and two of five activated pairs are non-negative.

## Promotion decision

Promotion and enforcement remain disabled.

Reviewed schema-v3 evidence, quality non-inferiority, the Stage 0 latency ceiling, and activation-relative latency pass. Minimum category samples, token superiority, resource limits, router-rate completeness, execution median, execution p25, and the 80% non-negative activated threshold fail. The five beneficial routing observations have zero false bypasses, but there is no bounded-task denominator. The structural failure remains `router-shadow-sample-incomplete`.

This result completes the frozen three-repository B6 coverage target, but the frozen promotion gates do not all pass. Routing stays in shadow mode and B7 polyglot indexing remains dark.
