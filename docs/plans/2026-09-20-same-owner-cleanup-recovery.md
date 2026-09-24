# Same-owner lock cleanup recovery decision

Status: decided on 2026-09-20.

## Problem

The v2 lock protocol must close its compatibility-directory handle before it
can remove that directory on Windows. If the subsequent bounded directory
removal fails, the journal correctly remains in barrier-only `cleanup`, but
the journal owner PID is still alive. Dead-owner recovery therefore refuses a
later attempt from the same process and can strand that domain until restart.

Keeping the directory handle open through removal is not portable and would
contradict the native Windows contract. Marking the live owner dead or making
all live cleanup journals recoverable would weaken ownership validation.

## Decision

After a cleanup failure, the owning runtime retains one private in-memory
receipt keyed by the canonical native anchor. The receipt contains only the
exact journal owner tuple: PID, nonce, relative legacy name, and key hash.

On a later acquisition of the same native anchor, that same runtime may resume
the active journal without a dead-owner finding only when every receipt field
matches the validated journal. Existing generation, predecessor, directory,
lease, nonce, payload, identity, and empty-barrier checks still apply. Recovery
must reach neutral `idle` before the new callback runs.

The receipt is cleared after neutral `idle` is validated or when it does not
match the journal. It is never written to disk, exposed through configuration
or environment state, shared with another runtime object, or accepted as a
production test seam. A different runtime in the same PID receives no recovery
authority. Process death discards the receipt and continues to use the
existing conservative dead-owner recovery path.

## Consequences

- Windows keeps the required handle-release-before-remove ordering.
- Persistent cleanup failure remains visible to the caller and preserves the
  journal and filesystem residue.
- A transient cleanup failure no longer makes the live process unusable for
  that lock domain.
- Foreign, replaced, or merely live journals remain fail-closed.

The regression test is authored with the implementation but is intentionally
left for GitHub-hosted verification under the current integration instruction.
