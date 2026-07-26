# TokenGraph Host Workspace Bridge Implementation Plan

**Goal:** Let an installed TokenGraph Codex plugin discover the current task workspace automatically without a global `TOKENGRAPH_WORKSPACE_ROOT`, while preserving root confinement across concurrent tasks.

**Design:** Codex lifecycle hooks attest the host-generated `cwd` under a record keyed by the host-generated session id and the installed plugin root. The MCP process receives `CODEX_THREAD_ID`, loads only the matching non-expired attestation, and treats that root as a host-provided workspace boundary. Explicit environment roots and MCP Roots remain supported. Missing, corrupt, expired, or mismatched attestations fail closed.

## Task 1: Prove the missing behavior

- Extend `plugins/tokengraph/tests/hooks.test.ts` with real hook-process tests for SessionStart/UserPromptSubmit attestation and SessionEnd cleanup.
- Extend `plugins/tokengraph/tests/mcp-smoke.test.ts` with an installed-plugin-root test that uses a hook-created attestation and a different-session rejection test.
- Run the focused tests and retain the expected failures before production edits.

## Task 2: Implement the bridge

- Add `plugins/tokengraph/src/core/hostWorkspace.ts` for canonical, privacy-minimal, session-keyed attestation persistence.
- Extend `plugins/tokengraph/src/hooks.ts` with SessionStart/UserPromptSubmit writes and SessionEnd removal.
- Extend `plugins/tokengraph/hooks/hooks.json` with those lifecycle events.
- Forward `CODEX_THREAD_ID` in `plugins/tokengraph/.mcp.json`.
- Extend `plugins/tokengraph/src/server.ts` workspace resolution with the matching Codex session attestation.
- Run the focused tests until green, then refactor without widening trust.

## Task 3: Package and document the patch

- Update the patch release version contracts and append the changelog.
- Update host/setup documentation so the automatic session bridge is primary and the environment variable is a compatibility fallback.
- Regenerate `release/tokengraph/` only through `pnpm package:plugin -- --release`.

## Task 4: Verify and publish

- Run typecheck, full tests, build, core/full smoke, plugin validation, release generation, release smoke, and package validation.
- Validate the plugin with the Codex plugin-creator validator.
- Push the conventional-commit branch, open a PR, and verify CI.
- Install only the verified packaged marketplace release, confirm its registered source/cache identity, and require a new task for live MCP pickup.
