# Fable/GPT independent review prompt

Copy the text below into the reviewing model and link it to the repository
branch `codex/stack-phase-3-native`.

---
Perform a read-only, adversarial spec and security review of TokenGraph branch
`codex/stack-phase-3-native`.

Read completely:

- `AGENTS.md`
- `docs/plans/tokengraph-external-handoff.md`
- `docs/plans/tokengraph plan.txt`
- `docs/plans/2026-08-09-native-lock-addon.md`
- `docs/superpowers/specs/2026-08-09-native-lock-addon-design.md`

Do not edit, stage, commit, reset, switch branches, clean, or touch another
worktree. Review the exact requested commit range and identify whether the
slice is safe to commit, safe only as a WIP branch, or safe to merge.

Prioritize:

1. Project mutation, migration, quarantine, repair, retention deletion, or
   quota cleanup before activation or outside the correct branded lock domain.
2. Same-domain nested deadlocks, swallowed durability failures, queue/cache
   leaks, release ordering, and incomplete error aggregation.
3. Exact eight-domain caller mapping, Git common-directory behavior,
   maintenance confirmation/capability separation, sorted acquisition/reverse
   release, and exact infrastructure accounting.
4. Permanent hook unactivation: no native addon, activation, persistence lock,
   mutating ledger API, project write, raw-root pointer, or trust fallback.
5. Exact host/plugin-data authority, non-overlap, BigInt/nanosecond identity,
   bounded no-follow reads, schema validation, concurrency, and fail-open Stop.
6. Exact recursive current-ledger decoding without legacy reconstruction,
   defaults, coercion, or deduplication.
7. Task authority only from a successful, nonconflicting structured result.
8. Positive installed-plugin-root coverage and complete external-runtime
   integrity/process-tree cleanup.
9. Tests that pass for the wrong reason, source-match safety behavior instead
   of executing it, hide timeouts, or omit real cross-process/platform proof.
10. Packaging/release/CI boundaries across Tasks 8-11.

Threat boundary:

- Supported processes are cooperative and use restrictive local host state.
- Actively racing same-account/admin final-syscall mutation and network
  filesystems are excluded.
- Every mismatch observed before the syscall must fail closed and preserve
  evidence.
- Device/inode are authoritative identity; stable reads use the complete
  BigInt tuple; post-publication omits only birthtime and ctime.

Do not approve from test totals alone. Trace every mutating control flow from
public entry to filesystem syscall and verify activation/lock ownership.
Distinguish source implementation, local verification, integration completion,
and Task 9/10 deferred gates.

Output:

1. APPROVE/CLEAN or REJECT.
2. Critical findings with exact paths/lines.
3. Important findings with exact paths/lines.
4. Minor findings.
5. Previous findings: addressed/not addressed.
6. Missing evidence and exact tests required.
7. Commit/push/merge safety classification.

Never recommend pushing incomplete work to main.

---
