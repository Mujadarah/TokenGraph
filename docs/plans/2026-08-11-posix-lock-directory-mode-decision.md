# POSIX persistence-lock directory mode: architecture decision required

Date: 2026-08-11
Status: BLOCKED, decision required before Task 7 can be called complete
Raised by: independent audit of the Phase 3 native-lock Task 7 slice

## Summary

On POSIX hosts, persistence-lock acquisition refuses any canonical domain
directory that is not mode 0700 and owned by the current uid. Several
directories that TokenGraph must lock are created mode 0755 in normal operation,
by Git, by ordinary user tooling, and by TokenGraph's own confined-path writer.
Those domains therefore cannot be locked at all on Linux or macOS.

Windows skips the mode and uid checks entirely, so the existing Windows evidence
for Tasks 1-6 and the Task 7 checkpoint cannot detect this class of failure.

This is a boundary-defining decision, not a test defect, so no fallback was
invented and no check was relaxed. Implementation stops here pending a decision.

## Evidence

Reproduced on Linux x64, glibc 2.34, umask 0022, with the real native addon
built from `native/lock-addon` at Rust 1.97.1.

Full activated suite at the handoff tree plus the esbuild build fix:
27 files, 723 tests, 692 passed, 21 failed, 10 skipped. Twenty of the twenty-one
failures are this single cause. Ten report it verbatim:

```text
FileLockError: The persistence lock directory is unsafe or has changed identity.
Serialized Error: { code: 'UNSAFE_LOCK_DIRECTORY' }
```

The remaining ten fail downstream of it, including three assertions that expect
a specific domain error and instead observe the lock error, one 15-second
timeout in `serializes purge with a writer and refuses unexplained legacy
barriers`, and one CLI purge invocation that exits nonzero.

### Mechanism

1. `lockDomain.ts` maps domains directly onto data directories:
   `workspace-state` is `<root>/.tokengraph`, `tasks` is
   `<root>/.tokengraph/tasks`, and `git-info` is
   `<git-common-dir>/info`.

2. `fileLockLease.ts` `productionIo.ensureDirectory` walks the path, then:

```text
const stats = await lstat(path, { bigint: true });
if (!restrictive(stats, true)) fail("UNSAFE_LOCK_DIRECTORY");
if (process.platform !== "win32") await chmod(path, 0o700);
```

   `restrictive` requires `(mode & 0o077) === 0` and `stats.uid === getuid()`
   on non-Windows. The validation runs BEFORE the chmod, so a pre-existing
   0755 directory is rejected and never tightened. The chmod only ever helps a
   directory this function itself just created.

3. Directories reach 0755 through three independent, ordinary routes:
   - Git creates `.git/info` mode 0755. Verified 755 in this repository. The
     `git-info` domain can therefore never be locked on POSIX in any normal
     clone.
   - `storage.ts:273` creates intermediate confined directories with
     `mkdir(candidate, { recursive: false })` and no mode, yielding 0755 under
     the default umask. TokenGraph can thus create a directory that its own
     lock layer will later refuse.
   - Any user, editor, archive extraction, or CI checkout that materializes
     `.tokengraph` before the first lock acquisition.

4. On Windows the entire mode and uid branch is skipped, so all of the above
   passes there. This explains why the handoff's Windows evidence, including
   the 348-pass Task 7 aggregate, did not surface it.

## Why this is a decision and not a fix

The plan requires restrictive modes for lock state and simultaneously requires
locking directories that are project state, not host state:

- "Preserve symlink/junction refusal, canonical lock keys, restrictive modes,
  and per-path serialization."
- "Supported processes are cooperative and use restrictive local host-state
  directories."

`.tokengraph` and `.git/info` are project state inside the user's repository.
Requiring 0700 on project state changes the product's POSIX contract, and any
of the candidate resolutions below alters either a security boundary or a
user-visible filesystem side effect. Choosing silently would either weaken a
lock check or mutate permissions inside the user's Git directory, both of which
the hard constraints forbid without an explicit decision.

## Options

### Option A: adopt and tighten a directory the caller owns

Reorder to chmod 0700 first, then validate identity and mode, when the
directory exists and is owned by the current uid and is not a link or reparse
point.

- Pro: unblocks all twenty failures with a small diff; keeps the 0700 end state;
  matches the apparent intent that TokenGraph owns `.tokengraph`.
- Con: TokenGraph silently changes permissions on directories it did not create,
  including `.git/info`, which is inside the user's Git directory. Group-readable
  and shared-CI checkouts change behavior. A 0700 `.git/info` may surprise other
  Git tooling running as a different account.
- Risk: converts a fail-closed refusal into an automatic mutation. Requires an
  explicit statement that permission tightening of project state is authorized.

### Option B: require restrictive modes only for host state, not project state

Keep the strict 0700 and uid requirement for host-state directories such as the
OS-temporary attestation tree and plugin-data sessions. For in-project domain
roots, drop the mode requirement and keep type, link, reparse, ownership, and
identity checks.

- Pro: honors the plan's actual wording, which scopes restrictive modes to local
  host state; no permission mutation inside the user's repository; `.git/info`
  works untouched.
- Con: project lock files become group and world readable when the repository is.
  Under the stated cooperative same-account threat model this leaks only lock
  metadata (pid, nonce, timestamps), not project content, but it must be stated
  and accepted in the trust documentation.
- Risk: reads as relaxing a check. It is only defensible if the threat model
  explicitly excludes same-host other-account observers for lock metadata, which
  the current documents do not say clearly.

### Option C: relocate lock infrastructure out of project state

Keep domain semantics but place anchor, journal, and lease files under a
restrictive host-state directory keyed by canonical workspace identity, leaving
project directories unlocked and unmodified.

- Pro: fully consistent 0700 host-state boundary; no project permission change;
  removes `.git/info` from the lock surface entirely.
- Con: largest change. Cross-process mutual exclusion stops being colocated with
  the data it guards, so a workspace reached by two different canonical paths
  (bind mount, differing symlink route, container path) must still map to one
  key. Interacts with Task 7's exact infrastructure accounting, the compatibility
  barrier, and Task 8 crash recovery. Almost certainly re-opens Tasks 6-8.
- Risk: schedule and regression surface.

## Recommendation

Option A restricted to `.tokengraph` and its descendants, combined with Option B
for `git-info` only, is the smallest change that is defensible on both axes:
TokenGraph owns `.tokengraph`, so tightening it is legitimate; it does not own
`.git`, so it should validate but never chmod there. This needs an explicit
decision because it introduces a documented, deliberate asymmetry between
domains.

Whichever option is chosen, `storage.ts:273` must create confined directories
with mode 0700 so TokenGraph stops producing directories its own lock layer
rejects.

## Required regression coverage once decided

1. A pre-existing 0755 domain directory owned by the current uid, for every one
   of the eight domains, asserting the decided outcome exactly.
2. `git-info` acquisition in a real Git repository whose `.git/info` is 0755,
   asserting the decided outcome and asserting whether the mode is preserved.
3. A directory owned by another uid, asserting fail-closed in all options.
4. A symlinked or reparse-point domain root, asserting continued refusal and
   preserved evidence.
5. Confined-path creation asserting mode 0700 on every intermediate directory.
6. A POSIX assertion that the mode branch is exercised at all, so this class of
   defect cannot again be masked by Windows-only evidence.

## Status of the twenty failures

They are pre-existing at the handoff commit `91ab073` on POSIX and are not
caused by the two commits made in this session. They are not evidence that the
Task 7 non-hook slice is otherwise correct; the remaining audit findings for
mutation-capable reads, exact infrastructure accounting, and locked retention
deletion are still open and independent of this decision.
