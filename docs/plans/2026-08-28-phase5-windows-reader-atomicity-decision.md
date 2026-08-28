# Phase 5 Windows reader atomicity decision

Date: 2026-08-28
Status: STOPPED pending approval of the revised active-index read protocol

## Observed boundary

The Phase 5 plan requires a validated immutable candidate followed by an
atomic replacement of the active index. On Windows, a reader that keeps an
open handle to `index.json` prevents the replacement:

```text
fs.promises.rename(tempPath, indexPath)
EPERM: operation not permitted
```

This was reproduced locally with Node 22 using an ordinary read handle. The
existing `writeJsonAtomic` path fails at the same rename. A candidate file in
the same directory does not change Windows sharing semantics for the active
file.

The failure is not safe to solve by writing in place, deleting the active file
first, retrying forever, or ignoring the error. Those choices would weaken
atomicity or create a missing or partially written active index.

## Decision

Phase 5 must use immutable generation files and a short manifest pointer. The
pointer is the only object that is replaced during promotion. A generation is
never modified after its durable write and validation.

The new protocol is:

1. Scan and validate one complete candidate generation, including the source
   scan signature, intended-file count, terminal exclusions, content-set hash,
   repository identity, root, and fingerprint.
2. Write the generation to a unique same-directory file named
   `.index-generation-<uuid>.json`, flush it, close it, reread it, and validate
   it again. Never replace or mutate an existing generation.
3. Write a unique same-directory manifest temporary containing only the exact
   active generation filename, its generation id, and its content hash. Flush,
   close, reread, and validate the manifest temporary.
4. Atomically replace `.index-manifest.json` with the validated manifest
   temporary. Readers never keep the manifest handle open after resolving the
   generation filename, so the pointer replacement has a bounded retry window.
5. Open and validate the named immutable generation. If the pointer is absent,
   malformed, points outside the state directory, or names a missing or
   mismatched generation, retry a bounded number of times and then fail closed
   as a stale or unsafe index. Never select an arbitrary newest file.
6. Retain the canonical `index.json` path as the legacy compatibility
   fallback. A new reader uses the manifest when present and falls back to a
   validated schema-v4 `index.json` only when no manifest exists. A legacy
   reader therefore continues to see the last successfully published v4
   index; it is never given a pointer object or a partial generation.
7. Once a schema-v5 manifest has been published, a v5-aware writer never
   overwrites `index.json`. Legacy `index.json` remains immutable compatibility
   evidence until an explicit retention cleanup removes it under the existing
   maintenance lock. A v5-aware reader treats a stale legacy copy as fallback
   only when the manifest cannot be read and reports the degraded state.
8. Candidate and abandoned-generation accounting remains cache accounting.
   Cleanup may remove only exact, validated generation names under the
   workspace-state lock; it must preserve the active generation named by the
   manifest and all legacy evidence.

## Required reader and writer invariants

- The manifest contains an exact single-segment generation filename, a UUID
  generation id, and a SHA-256 content hash. No path traversal, symlink, or
  reparse entry is accepted.
- The generation filename, parsed generation id, content hash, root, repository
  identity, schema, and fingerprint must agree before the generation is used.
- A reader retries only after a pointer/generation race and only within a
  fixed small deadline. It never retries an identity, schema, or integrity
  failure indefinitely.
- A writer leaves the prior manifest and active generation untouched on every
  scan, quota, validation, flush, replacement, or identity failure.
- A failed promotion removes only the writer-owned manifest temporary and
  unreferenced candidate generation after identity checks. Cleanup failure is
  surfaced and never converted into success.
- Readers holding a generation handle remain valid while a later generation is
  published. No active generation file is replaced or deleted while it is
  referenced by the current manifest.
- The existing workspace-state lease and journal protect promotion and cleanup;
  the manifest does not become an alternate lock or authority.

## Required RED/GREEN coverage before implementation resumes

The Phase 5 tests must be revised to prove:

- v5 generation metadata and terminal exclusions;
- manifest and generation durable-write validation;
- crash before manifest replacement preserves the old manifest and generation;
- malformed, foreign, missing, or tampered manifest/generation fails closed;
- bounded reader retry during a pointer race;
- concurrent promotions leave one complete manifest-selected generation;
- an open reader of an old generation remains readable while a new generation
  is published on Windows;
- safe schema-v4 `index.json` load and first full v5 rebuild;
- future-schema refusal and repository/worktree identity changes;
- cache accounting and purge of abandoned unreferenced generations without
  removing the active generation or legacy evidence;
- every existing Phase 1A scan race still preserves the prior publication.

The direct active-file open-reader test is retained as the proving RED boundary
and must not be weakened or skipped on Windows. Its GREEN replacement is the
manifest protocol above, not a weaker active-file rename.

## Stop condition

Do not implement, merge, package, or publish Phase 5 until this protocol is
approved as the replacement for direct `index.json` promotion. The current
Phase 5 branch contains only RED tests and this decision note; it is not
merge-ready.
