# Phase 3 Canonical History Boundary Decision

**Date:** 2026-08-13

**Status:** Accepted

**Scope:** Task 11 Step 1 of `docs/plans/2026-08-09-native-lock-addon.md`

## Context

Task 11 asks for this topology check:

```text
git merge-base --is-ancestor codex/stack-phase-2 HEAD
```

The Phase 3 continuation handoff explicitly selected
`origin/codex/stack-phase-3-native` as canonical. That branch is stacked on the
squashed external handoff snapshot `91ab073f0ef6c21cefd548fc3ba5034b5cdfecc2`,
whose parent is `af29092d791021f6ce9f26f4eb12e532f55e188a`.
The local `codex/stack-phase-2` branch instead retains the original unsquashed
lineage at `370ce185be258f1b6be26906f80b68aeab8df126`.

At Task 11 HEAD `ce25e23a094fc1141c3e8c949ee084f53226a735`,
the literal ancestry command exits 1 and the merge base is `af29092`. The
Phase 2 tree, the handoff parent tree, and the handoff snapshot tree are all
different. Tree equality is therefore not an honest substitute for ancestry.
Blindly merging the local Phase 2 lineage would replay already-squashed work
and violate the canonical-branch instruction.

## Decision

1. Keep `origin/codex/stack-phase-3-native` and its descendant commits as the
   sole canonical Phase 3 history.
2. Record the literal `codex/stack-phase-2` ancestry command as an expected
   topology failure caused by the approved squash boundary. Do not report it
   as passing and do not rewrite, merge, or force-push history to make it pass.
3. Replace only the topology assertion in Task 11 Step 1 with these canonical
   provenance checks:
   - `91ab073` is an ancestor of the reviewed Phase 3 HEAD;
   - the local canonical branch and
     `origin/codex/stack-phase-3-native` are equal at each pushed checkpoint;
   - the reviewed scope is inspected from `91ab073...HEAD` and from the exact
     prior accepted Task boundary;
   - the full Phase 3 native, TypeScript, package, and regression gates verify
     behavior inherited through the squashed snapshot.
4. Preserve the local unsquashed Phase 2 branch as historical evidence only.
   Do not cherry-pick or merge it into the canonical Phase 3 stack.
5. Final integration into `main` remains forbidden until every later required
   phase and final gate passes. At that point integration must use the
   canonical stack and an explicit current-main audit, never a blind merge of
   the two Phase 2/Phase 3 histories.

## Consequences

- Task 11 will report the failed literal ancestry command and this decision
  note together. It will not claim that the original topology requirement is
  green.
- Functional verification remains mandatory and is not replaced by this
  history decision.
- The rejected Node-only implementation remains outside the canonical stack.
- No release, tag, publication, or `main` update is authorized by this note.
