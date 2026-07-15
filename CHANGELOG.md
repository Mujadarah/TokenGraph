# Changelog

## 0.21.0 - 2026-07-15

- Added shadow-first routing decisions, canonical stable artifacts, exact known-artifact suppression, and task-aware routing overrides.
- Added repository/worktree identity, common-git-directory storage foundations, quotas, purge, confinement, permissions, and injection filtering.
- Added bounded configuration parsing, pinned TypeScript 5.9.3, source-free SymbolChunk records, deterministic BM25 capsules, graph expansion, exact slices, and handshake-safe deltas.
- Added the bounded `tokengraph run -- <command> [args...]` CLI with redacted captures, timeouts, retention, and saved-run selectors.
- Added scoped memory briefs/outcomes, deterministic Obsidian projection, gated paired router evaluation, a negative JSON/tabular experiment, and pinned standalone Tree-sitter WASM grammars.
- The checked-in benchmark remains diagnostic and fails the frozen execution-inclusive release gate: routing-lifecycle median 5.7 tokens and execution-inclusive median -94.3 tokens; JSON remains the default response format and enforcement stays disabled.

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
