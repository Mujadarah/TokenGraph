# Phase 5: Release packaging, Claude Code support, and CI

## Goal

Slim the installable release to the runnable bundle, add first-class Claude Code marketplace metadata, make host-facing language neutral, and add reproducible CI and release artifacts.

## Verification gates

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm smoke -- --root . --json`
- `pnpm validate:plugin`
- rebuild `release/tokengraph` and verify only the bundled runtime is shipped
- verify Claude marketplace and MCP manifests parse and use host-root variables
- verify the committed release is reproducible after packaging

## Tasks

1. [x] Update packaging and validation so release output contains only `dist/index.js` and the installable metadata/skills.
2. [x] Add Claude Code plugin and marketplace manifests, neutralize host-specific descriptions, and add skill `when_to_use` metadata.
3. [x] Update host/repository/license documentation and ignore local Claude/TypeScript/package-manager state.
4. [x] Add CI for frozen installs, tests, package validation, ASCII checks, release reproducibility, and optional strict Claude validation.
5. [ ] Rebuild and verify the release, package the v0.17.0 artifact, commit, push, and open the dependent PR.
