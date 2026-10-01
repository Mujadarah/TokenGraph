# Phase 7 Doctor read boundary

Status: decided for source implementation; execution evidence is deferred by
the maintainer.

Doctor has exactly two independent read authorities: the installed plugin root
and, only after host trust succeeds, the resolved workspace root. Neither root
authorizes its parent, a linked target, or a Git common directory outside the
root.

- Every diagnostic file read is bounded and descriptor-verified. The reader
  rejects symbolic links and junctions, compares BigInt device/inode and
  nanosecond timestamps before and after the read, and validates directory
  identity around every entry read.
- Source-layout release comparison is available only when both the source
  plugin and generated release are inside the already trusted workspace. A
  blocked workspace never grants access to a sibling release directory.
- A linked-worktree `.git` marker is reported as unavailable. Doctor does not
  follow it to a common directory. A nested directory without its own `.git`
  directory does not inherit identity from a parent repository.
- Index freshness reuses the production scanner rules and configured parser
  limits through the same bounded diagnostic reader, so ignore files, source
  files, and configuration-signature files cannot be swapped to outside paths.
- Missing or malformed subsystem data degrades that subsystem with a stable
  recommendation code. Only a read-boundary violation blocks workspace state
  access; one unavailable subsystem does not erase safe diagnostics from the
  others.
- Doctor never activates native locking, takes a persistence lock, creates a
  directory, migrates or quarantines data, refreshes an index, breaks a lease,
  or writes telemetry.

Required deferred contracts cover root and nested junction refusal, bounded
parser/index reads, strict production decoders, unavailable linked Git domains,
partial physical-byte omission, missing-index degradation, strict CLI options,
and the full-surface MCP read-only annotation. No RED or GREEN execution is
claimed by this note.
