---
name: memory-curator
description: Use when durable project decisions must be recalled, audited, compared with current evidence, or proposed for review.
---

# Memory Curator

## When not to use

Do not use for transient notes, personal memory, tiny current lookups, or mutation without explicit review.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_recall` with `mode: "review"` and `audit: true`; verify drift-prone claims with `tokengraph_query_context`. Propose reviewed changes with `tokengraph_propose_knowledge({ action: "propose", ... })`.

## Evidence required

Use privacy-safe fingerprints, targets, conflicts, and expiry. Path sources are rehashed on approval; ID-only and legacy sources remain unverifiable snapshots.

## Failure boundaries

Stale or expired proposals cannot apply. Do not approve without a canonical path source, apply an unreviewed payload, or claim `applicationStatus: "applied"` unless the returned application status is exactly applied.

## Completion criteria

Return recalled evidence and drift status, or the reviewed proposal/application result. Rejection applies nothing; a current result must identify its source confidence.
