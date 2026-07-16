# Changelog

## 0.21.1 - 2026-07-16

- Fixed routing shadow, kill-switch, force-bypass, promotion-evidence, and B7 activation semantics so advisory decisions cannot silently enforce or unlock later phases.
- Fixed repository/worktree identity refresh, branch-safe index reuse, task-ledger migration and artifact delivery, symlink-safe writes, untrusted-source filtering, and class-specific storage quotas and purge behavior.
- Wired bounded parser limits, worker isolation, exact hash-validated slices, task read-policy reassessment, saved-run selectors, retention, and the paired-routing evaluator into production paths.
- Replaced synthetic debugging/compression accounting with real bounded runner captures and made failed benchmark gates return a failing process status.
- Passed the frozen deterministic release gate with 100% constraint preservation and required-file recall, zero critical false negatives, a +196.5-token activated-task median, +102.5-token p25, and 82.1% non-negative activated tasks. Enforced routing still requires a separate complete passing B6 host evaluation.

## 0.21.0 - 2026-07-15

- Added shadow-first routing decisions, canonical stable artifacts, exact known-artifact suppression, and task-aware routing overrides.
- Added repository/worktree identity, common-git-directory storage foundations, quotas, purge, confinement, permissions, and injection filtering.
- Added bounded configuration parsing, pinned TypeScript 5.9.3, source-free SymbolChunk records, deterministic BM25 capsules, graph expansion, exact slices, and handshake-safe deltas.
- Added the bounded `tokengraph run -- <command> [args...]` CLI with redacted captures, timeouts, retention, and saved-run selectors.
- Added scoped memory briefs/outcomes, deterministic Obsidian projection, gated paired router evaluation, a negative JSON/tabular experiment, and pinned standalone Tree-sitter WASM grammars.
- The checked-in benchmark remains diagnostic and fails the frozen execution-inclusive release gate: routing-lifecycle median 5.7 tokens and execution-inclusive median -94.3 tokens; JSON remains the default response format and enforcement stays disabled.
- Correction note (2026-07-16): the benchmark figures in this entry were restated in place during the v0.21.1 remediation. The values published at the v0.21.0 tag were routing-lifecycle median 20.0 tokens and execution-inclusive median -86.0 tokens; the remediation recomputed the same corpus under corrected harness accounting as 5.7 and -94.3 tokens (19/30 non-positive). Both computations describe the same failing gate. Published entries are append-only from now on and are corrected only by dated notes like this one.

## 0.20.0 - 2026-07-13

- Added durable task ledgers and one canonical mandatory completion footer with uncertainty and quality status.
- Added cooperative cross-host PostToolUse and Stop hooks, packaged as `dist/hooks.js` plus `hooks/hooks.json`; hooks require user review/trust and cannot enforce abnormal stops.
- Reduced the default MCP surface to eight compact intent-level tools while preserving 42 tools on the full compatibility surface.
- Made JSON-only success results single-copy serialized JSON text, with project-map resource links retained as the documented exception.
- Added source-linked review-before-apply wiki and memory proposals with provenance, expiry, conflict review, and idempotent approval.
- Rejected Windows absolute knowledge-source paths consistently on every host operating system.
- Passed the deterministic routing-lifecycle evidence gate at 100% constraint preservation, zero critical false negatives, 100% recall, and median net estimated savings of 31.7 tokens. Its p25 is -270.3 and 15/30 tasks are non-positive; the execution-inclusive median is -133.8 with 20/30 non-positive. All categories remain low-confidence.

## 0.19.0 - 2026-07-12

- Added rootless setup diagnostics and explicit workspace trust recovery.
- Added shared Codex and Claude Code marketplace metadata and release-install guidance.
- Added deterministic standalone marketplace ZIP validation and repository hygiene cleanup.

## 0.18.0 - 2026-07-12

- Hardened trusted workspace confinement, symlink handling, and architecture-rule validation.
- Improved SQL and project scanning fidelity, nested ignore handling, and refreshed index signatures.
- Added self-contained release packaging and CI validation for both Codex and Claude Code.

## 0.17.0 - 2026-07-11

- Added host-neutral context compression, project-map exports, and quality-first evidence reporting.
- Added Codex-first host documentation plus generic MCP, Cursor, and Windsurf guidance.

Token figures are estimates rather than provider billing counts. TokenGraph remains local-first and requires no paid API.

Earlier pre-tag history from v0.1 through v0.16 is summarized in ROADMAP.md.
