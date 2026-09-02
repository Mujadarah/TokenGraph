# Phase 5 directory durability boundary

Date: 2026-09-02
Status: DECIDED for the Phase 5 implementation

## Conflict

The transactional-generation plan requires each generation and manifest
publication to be durable. TokenGraph flushes each newly written file before
closing it and, on POSIX, also opens and synchronizes the containing directory
after file creation, rename, and removal.

Node.js does not provide a portable Windows guarantee for opening and
synchronizing a directory handle. Supported Windows filesystems may return
`EINVAL`, `EPERM`, `EACCES`, `EBADF`, or `ENOTSUP` for that directory-only
operation even though the regular-file flush and same-directory atomic rename
succeeded. Treating those documented platform failures as fatal after rename
cannot roll publication back: the manifest namespace is already committed.
Retrying or deleting the selected generation would instead violate atomicity.

## Decision

TokenGraph keeps the following boundary:

1. Generation and manifest-temporary file contents are always flushed through
   their regular-file handles before close.
2. Manifest publication remains a same-directory atomic rename with bounded
   retry before the namespace commit.
3. POSIX directory synchronization is mandatory; every directory-sync error is
   surfaced.
4. Windows attempts the same directory synchronization. Only the known
   unsupported directory-handle errors listed above are accepted after the
   regular-file flush. Every other error is surfaced.
5. Once rename succeeds, the selected generation is retained on every later
   flush, verification, or cleanup failure because the manifest may reference
   it.
6. TokenGraph claims atomic publication on supported local Windows filesystems,
   but does not claim that Node can independently prove namespace persistence
   across abrupt power loss when Windows rejects directory synchronization.

This is a durability limitation, not permission to write in place, delete the
old manifest first, select an arbitrary generation, or weaken identity and
content validation. Network filesystems remain outside the guaranteed local
filesystem boundary.

## Consequences

- The trust limitations must disclose the Windows namespace-durability
  residual.
- A future Node or native API that provides a supported Windows directory-flush
  primitive may remove this residual, but it requires a new decision note and
  failure-injection evidence.
- Execution verification remains required before merge; this decision is not
  test evidence.
