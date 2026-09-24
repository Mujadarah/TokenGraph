# Task 9 contained native source verification decision

**Status:** Decided
**Date:** 2026-08-13
**Scope:** Task 9 Step 6 of `docs/plans/2026-08-09-native-lock-addon.md`

## Context

Task 9 Step 6 originally invoked `native-lock-addon.test.ts`,
`native-lock-packaging.test.ts`, and `storage-lock-process.test.ts` in one raw
Vitest command. Task 8 subsequently made the process suite dependent on the
owned external-runtime manifest created by `scripts/run-tests.mjs`. This is a
containment boundary: the manifest binds the fresh production build, private
native asset snapshot, process evidence roots, and cleanup identities.

The exact original command now produces the intended boundary failure:
addon/packaging run, while `storage-lock-process.test.ts` refuses during
collection with `Native lock test harness manifest is unavailable.` Running
the process suite without that manifest would require weakening
`tests/support/externalRuntime.ts` or introducing another environment-selected
runtime path. Both are prohibited.

Task 9 must also prove that the committed current-target source asset is used,
not a freshly compiled harness default. `scripts/run-tests.mjs` already accepts
an exact, confined current-target source-asset path for tests only. Contract
tests prove that the production provider does not read that variable and the
probe remains excluded from release output.

## Decision

Keep the owned-manifest requirement unchanged and split Task 9 Step 6 into two
verification boundaries:

1. Run addon and packaging tests directly with
   `TOKENGRAPH_NATIVE_CURRENT_ASSET` set to the exact committed current-target
   source asset. These tests do not import the external-runtime manifest and
   therefore exercise the source loader and validator directly.
2. Run `storage-lock-process.test.ts` only through `pnpm test:activated`, with
   the same exact source-asset path. The runner validates and snapshots those
   bytes into its owned external runtime before any child executes.

On the Windows verification host the exact source asset is
`assets/native-lock/win32-x64/tokengraph-lock.win32-x64.node`. Other supported
hosts select the one exact current-target record from the six-target table.

This test-only selection does not activate production, add a fallback, or
change the production loader. Hooks remain unactivated and project-read-only.

## Rejected alternatives

- **Allow raw process-suite execution without a manifest.** Rejected because
  it loses build, asset, containment, and cleanup identity binding.
- **Let the production provider consume a current-asset environment
  variable.** Rejected because it creates a production test seam and fallback.
- **Use the harness's fresh native build for Step 6.** Rejected because it does
  not prove the committed source asset consumed by Task 10.
- **Treat the process test as optional after six-target CI.** Rejected because
  Task 9 explicitly requires the committed current-target source asset to pass
  the local process integration gate.

## Plan amendment

Replace the combined raw Vitest command in Task 9 Step 6 with:

```powershell
$env:TOKENGRAPH_NATIVE_CURRENT_ASSET = (Resolve-Path "assets/native-lock/win32-x64/tokengraph-lock.win32-x64.node").Path
pnpm vitest run tests/native-lock-addon.test.ts tests/native-lock-packaging.test.ts --reporter=verbose
pnpm test:activated tests/storage-lock-process.test.ts --reporter=verbose
Remove-Item Env:\TOKENGRAPH_NATIVE_CURRENT_ASSET
```

The preceding `pnpm native:validate -- --assets assets/native-lock
--load-current` command is unchanged.

## Consequences and required evidence

- The raw process-suite refusal remains a positive containment assertion, not
  a test failure to suppress.
- Task 9 evidence must record the exact source asset path class, the direct
  addon/packaging totals, the contained process totals, and successful
  process-tree cleanup.
- `native-lock-workflow.test.ts` continues to prohibit the current-asset test
  variable from the production provider and release probe.
- Task 10 and Task 11 continue to use the ordinary full wrappers and committed
  packaged assets; this amendment applies only to the Task 9 source-asset gate.
