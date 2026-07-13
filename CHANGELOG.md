# Changelog

## 0.20.0 - 2026-07-13

- Added durable task ledgers and one canonical mandatory completion footer with uncertainty and quality status.
- Added cooperative cross-host PostToolUse and Stop hooks, packaged as `dist/hooks.js` plus `hooks/hooks.json`; hooks require user review/trust and cannot enforce abnormal stops.
- Reduced the default MCP surface to eight compact intent-level tools while preserving 42 tools on the full compatibility surface.
- Made JSON-only success results single-copy serialized JSON text, with project-map resource links retained as the documented exception.
- Added source-linked review-before-apply wiki and memory proposals with provenance, expiry, conflict review, and idempotent approval.
- Passed the deterministic evidence gate at 100% constraint preservation, zero critical false negatives, 100% recall, and median estimated net savings of 30.5 tokens. The p25 is -166 tokens, 11 tasks remain non-positive, and all categories remain low-confidence.

Token figures are estimates rather than provider billing counts. TokenGraph remains local-first and requires no paid API.
