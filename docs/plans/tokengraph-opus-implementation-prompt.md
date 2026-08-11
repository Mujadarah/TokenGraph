# Claude Opus implementation prompt

Copy the text below into Claude and link it to the repository branch
`codex/stack-phase-3-native`.

---
Continue the interrupted TokenGraph implementation on branch
`codex/stack-phase-3-native`.

Read completely before editing:

- `AGENTS.md`
- `docs/plans/tokengraph-external-handoff.md`
- `docs/plans/tokengraph plan.txt`
- `docs/plans/2026-08-09-native-lock-addon.md`
- `docs/superpowers/specs/2026-08-09-native-lock-addon-design.md`

First inspect `git status`, `git log`, and the handoff commit. Do not reset or
rewrite the current Task 7 Option C files. Do not use another worktree's dirty
changes. Do not push to main.

Execution order:

1. Independently audit the current Option C hook checkpoint against the final
   plan and design. Add behavioral RED tests for any real gap, then implement
   the minimum GREEN fix.
2. Run focused hook, task-ledger, MCP external-runtime, preactivation,
   typecheck, approved aggregate, build, inventory/privacy, and diff gates.
3. Obtain an independent spec/security review. Fix every Critical/Important
   finding before calling the hook slice complete.
4. In a separate commit, resolve all non-hook Task 7 findings listed in the
   handoff: mutation-capable reads, exact infrastructure accounting, locked
   retention deletion, and missing mapping/order/accounting tests.
5. Repair the valid setup request in the benchmark model and regenerate its
   checked-in evidence. Shorten the paired-host test-only root prefix so the
   intended verifier failure is actually exercised.
6. Run the final Task 7 commands from the plan. Record Task 9 smoke and Task 10
   release-validation dependencies honestly; do not call them green.
7. Complete native-lock Tasks 8-11 with strict TDD and independent review.
8. Resume `docs/plans/tokengraph plan.txt` through Phase 10.
9. Only after every phase and final gate passes: integrate local main, clean
   only proven-stale branches/worktrees, push origin/main, and verify equality.

Hard constraints:

- Hooks remain permanently unactivated and project-read-only.
- No production environment activation, fallback, or test seam.
- `hooks/hooks.json` remains byte-identical.
- Stable identities use BigInt/nanoseconds. Post-publication omission is
  limited to birthtime and ctime exactly as documented.
- Never weaken identity, attestation, lock, atomicity, privacy, or process-tree
  checks to pass tests.
- Never hand-edit generated release output.
- Use conventional commits and narrow diffs.

At each checkpoint report exact HEAD, dirty files, valid RED evidence, GREEN
commands/totals, open review findings, deferred dependencies, and commit SHA.
If the plan and implementation conflict, stop and write a decision-complete
architecture note rather than inventing a weaker fallback.

---
