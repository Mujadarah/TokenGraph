# Phase 12 Windows full-gate timeout disposition (2026-09-23)

## Scope and decision

This note records the local Windows Phase 12 gate at commit
`2b8f0a70ccadfce08786632b8842a123b14f6731`. It does not change the
native-lock or process-tree contract. Keep the 900,000 ms contained-test limit
and all post-exit drain checks unchanged. The Windows full test gate is **not
verified** by this run; do not mark the draft PR release-ready on its basis.

The Linux GitHub CI result is separate evidence, not a claim that the Windows
run passed. No timeout increase, containment bypass, test skip, or release
approval is made here.

## Observed evidence

- `pnpm typecheck` passed locally.
- `pnpm test -- --reporter=dot` passed the 9 preactivation tests. The activated
  suite continued printing pass/skip markers, but the Windows job supervisor
  reached its 900,000 ms limit before Vitest produced final totals.
- The preserved supervisor status was `forced-failure`, `errorCode: TIMEOUT`,
  `activeProcesses: 0`. This proves a bounded forced stop, not a test pass or
  the cause of the delay. Its control specification and harness are retained
  only in the local OS temporary directory; do not publish their inherited
  environment or machine-local paths.
- The local command used Node.js 25.6.1. CI pins Node.js 22. The Windows
  activated Vitest configuration runs files serially; neither observation
  alone proves why the 15-minute limit was exceeded.
- [CI at the same commit](https://github.com/Mujadarah/TokenGraph/actions/runs/35861224101)
  passed on Linux with 9 preactivation tests and 940 activated tests passed,
  13 skipped, 0 failed across 38 activated files. Its build, smoke, plugin
  validation, non-ASCII policy, and committed-release reproducibility steps
  also passed.
- Local build, plugin validation, release regeneration, byte-exact 36-file
  ZIP/release parity, and extracted core/full MCP smoke passed separately.
  The first local core smoke after the interrupted suite timed out after
  preparation refreshed the workspace; later core and full runs passed with
  the unchanged default timeout. Do not erase the first result from the
  checkpoint.

## Boundary and next evidence

The current decision is to preserve the failed Windows gate honestly and keep
PR #54 draft. A future Windows gate should use the supported Node.js 22
toolchain and capture per-file timing or a named slow case while retaining the
same containment and child-drain checks. If it still exceeds the bound,
diagnose the specific workload before proposing a suite scheduling or timeout
change. Such a change needs its own reviewed decision and regression evidence;
it must never silently turn a forced stop into success.

The remaining release-readiness gates are independent: real Claude Code
lifecycle evidence (the local CLI is currently logged out), live Linux Plugin
Eval with retained verifier artifacts, current six-target native evidence,
and actual publication-only signature, attestation, and public-download
checks. No merge, tag, publication, managed-runtime installation, or PR
ready-for-review transition follows from this note.
