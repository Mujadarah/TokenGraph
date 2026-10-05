# TokenGraph external handoff

Snapshot: 2026-08-11

GitHub branch: `codex/stack-phase-3-native`

Status: WIP; not merge-ready; do not merge or push to `main`

This document is the cloud handoff for continuing the implementation and audit
of `docs/plans/tokengraph plan.txt`. Refresh `git status` and `git log` after
checkout because later commits may supersede this snapshot.

## Start here

Read these files completely before editing:

1. `AGENTS.md`
2. `docs/plans/tokengraph plan.txt`
3. `docs/plans/2026-08-09-native-lock-addon.md`
4. `docs/superpowers/specs/2026-08-09-native-lock-addon-design.md`

Do not weaken an identity, activation, atomicity, privacy, or compatibility
boundary merely to make a test pass. Do not hand-edit `release/tokengraph/`.

## Completed Phase 3 work

Native-lock Tasks 1-6 are implemented and independently reviewed. Task 6's
final evidence included 75/75 focused tests, 30 repetitions (2,250/2,250), a
676-pass full suite with five expected skips, typecheck, build, smoke, plugin
validation, and independent spec and quality approval.

Do not reimplement Tasks 1-6. Verify them only when a later change can regress
their behavior.

Task 7 has committed:

- the real-current-target native test harness;
- Windows Job Object and POSIX process-group containment;
- fixed no-build preactivation checks;
- branded eight-domain persistence locks;
- CLI literal confirmation and process-local MCP activation;
- maintenance locking and infrastructure preservation;
- the approved permanently-unactivated hook design.

Key recent commits:

```text
0e7b243 test(tokengraph): run locks against real native addon
d15d7e2 test(tokengraph): prove ambiguous posix containment
978cca3 refactor(tokengraph): enforce lock maintenance domains
0f1fcae docs(tokengraph): define unactivated hook boundary
ed5b166 docs(tokengraph): harden unactivated hook state
bd20a95 docs(tokengraph): qualify hook mutation boundary
be91435 docs(tokengraph): account for NTFS metadata tunneling
4c0d9ae chore(tokengraph): checkpoint task 7 hook hardening
```

Commit `4c0d9ae` is explicitly a WIP cloud-review checkpoint, not an approval or
merge-readiness claim.

## Current Option C hook slice

The handoff commit contains the current implementation in:

```text
plugins/tokengraph/src/core/hostWorkspace.ts
plugins/tokengraph/src/core/taskLedger.ts
plugins/tokengraph/src/hooks.ts
plugins/tokengraph/tests/hooks.test.ts
plugins/tokengraph/tests/mcp-smoke.test.ts
plugins/tokengraph/tests/support/externalRuntime.ts
plugins/tokengraph/tests/task-ledger.test.ts
```

The controlling boundary is:

- Hook processes are permanently unactivated.
- Hooks never load the native addon, acquire persistence locks, call mutating
  ledger APIs, or mutate project state.
- `hooks/hooks.json` remains byte-identical.
- Host attestation is the only project-root authority.
- Project ledgers are inspected through a bounded, stable, no-follow,
  current-schema-only reader.
- The only hook write is a root-free schema-v2 advisory pointer in an
  identity-bound host/plugin-data sessions directory.
- Stop is read-only and fail-open on invalid or unstable state.
- Supported processes are cooperative and use restrictive local host-state
  directories. Actively racing same-account/admin mutation during the final
  path syscall and network filesystems are outside the stated threat model.
- Device and inode are authoritative object identity. Stable reads compare the
  complete BigInt/nanosecond tuple. Post-publication comparison retains
  `dev`, `ino`, `mode`, `nlink`, `size`, and `mtimeNs`, while omitting only
  `birthtimeNs` and `ctimeNs` because the namespace operation may change them.

Latest focused evidence before the handoff commit:

- hooks + task ledger + MCP: 137/137;
- approved Task 7 aggregate: 348 passed, three expected skips;
- preactivation: 3/3;
- typecheck and build passed;
- forbidden hook capability inventory had no matches;
- `hooks/hooks.json` matched HEAD;
- `git diff --check` passed.

Treat those numbers as evidence, not as a completion claim. Rerun them on the
cloud checkout.

## Open non-hook Task 7 findings

The independent review of the committed non-hook slice rejected Task 7.

### Mutation-capable reads before activation/domain ownership

Migration, quarantine, repair, or overwrite can still occur from nominal read
paths before activation or before acquiring the correct branded domain in:

```text
plugins/tokengraph/src/core/config.ts
plugins/tokengraph/src/core/architectureRules.ts
plugins/tokengraph/src/core/artifact.ts
plugins/tokengraph/src/core/knowledgeReviewQueue.ts
plugins/tokengraph/src/core/memoryStore.ts
plugins/tokengraph/src/core/persistence.ts
plugins/tokengraph/src/core/routingControl.ts
plugins/tokengraph/src/core/runner.ts
plugins/tokengraph/src/core/taskLedger.ts
```

Split pure reads from mutation-capable repair helpers. Repair and quarantine
must run after activation while owning the canonical domain. Use unlocked
helpers only inside a domain already owned by the caller.

### Exact infrastructure accounting

`plugins/tokengraph/src/core/storagePolicy.ts` excludes infrastructure by
basename. It must classify exact canonical infrastructure paths and live
journal-authorized provisional paths. It must not count live barrier/lease
infrastructure as user quota, and must not exclude ordinary user files that
reuse a reserved basename elsewhere.

### Retention deletion outside domain locks

`purgeRuns()` and `pruneTaskLedgers()` still delete persistent files without
the canonical domain lock. Route them through internal automatic maintenance
or one domain acquisition, with unlocked primitives inside the held lock.

### Missing regression coverage

- exact caller-to-domain assertions;
- observed sorted acquisition and reverse release;
- storage accounting while a live compatibility barrier exists.

## Full-test blockers owned by Task 7

1. The benchmark still models `tokengraph_setup` with `arguments: {}` even
   though the schema now requires `{ confirmNoLegacyProcesses: true }`. Fix the
   modeled request first, regenerate benchmark output and matching claims, then
   rerun benchmark and full tests. Do not simply bless the previous two-token
   difference.
2. The paired-host fixture hits Windows path pressure inside the nested test
   harness before reaching its intended verifier-provisioning failure. Shorten
   only the test fixture's root prefix. Do not weaken the expected assertion or
   change global Git configuration.

## Explicitly deferred gates

- Ordinary smoke cannot load production native assets until Task 9 commits all
  six supported target artifacts.
- Release plugin validation remains stale until Task 10 regenerates
  `release/tokengraph/**`.

These are dependencies, not green gates and not reasons to merge Task 7.

## Remaining work

1. Finish/review Task 7 and resolve every Critical/Important finding.
2. Task 8: killed-child maintenance and journal recovery integration.
3. Task 9: all six native artifacts, CI matrix, and default provider tests.
4. Task 10: source/package/release/archive parity and regenerated release.
5. Task 11: final Phase 3 review and integration readiness.
6. Resume the original plan's remaining phases through Phase 10.
7. Only when the entire plan is implemented and every final gate passes:
   integrate into local main, remove only proven-stale worktrees/branches, push
   `origin/main`, and verify local/remote equality.

## Git rules

- Preserve unrelated changes and all other worktrees.
- Use conventional commits with narrow diffs.
- Never force-push.
- Never push incomplete work to `main`.
- This WIP branch may be updated for external review, but it is not mergeable
  until the plan and final reviews say so.
