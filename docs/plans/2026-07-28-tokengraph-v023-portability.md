# TokenGraph v0.23 portability tracker

Status: complete

This tracker supersedes the v0.21/v0.22 assumption that B7 activation must be
coupled to routing promotion. Those historical evaluation records remain
valid evidence for routing; they are not a runtime prerequisite for local
polyglot parsing.

## Workspace and host contract

- [x] Resolve Codex `x-codex-turn-metadata` on each MCP request.
- [x] Corroborate the advertised project root and thread id with the trusted
  lifecycle-hook attestation.
- [x] Keep request context isolated with `AsyncLocalStorage`; never select a
  workspace through process-global mutable state.
- [x] Preserve Claude Code, explicit environment, Codex session-attestation,
  MCP Roots, and non-plugin working-directory fallbacks.
- [x] Keep caller-supplied roots confined beneath the request's trusted root.

## Per-project persistence

- [x] Store active state below `<workspace>/.tokengraph/`, including repository
  records under `<workspace>/.tokengraph/repository/`.
- [x] Stop using `.git/tokengraph/` as an active store.
- [x] Migrate valid legacy JSON records once, with active workspace data taking
  precedence on conflicts.
- [x] Write a migration manifest and retain the legacy directory as a backup;
  do not delete user state automatically.

## B7 parser activation

- [x] Default `parser.polyglotEnabled` to `true` in the project config.
- [x] Expose the setting through `tokengraph_update_config`.
- [x] Keep an explicit `false` project kill switch.
- [x] Decouple parser activation from B6 routing-promotion evidence.
- [x] Keep routing shadow-only while its independent promotion gates fail.

## Evidence contract

The implementation is covered by request-metadata and concurrent-workspace MCP
tests, legacy-store migration tests, config/kill-switch tests, and full source
and release verification. Release output is generated from source; the
committed `release/tokengraph/` directory is never edited by hand.
