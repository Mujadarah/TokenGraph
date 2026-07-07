# TokenGraph v0.10 Release Packaging Implementation Plan

Goal: add a repeatable public release packaging workflow that produces an installable TokenGraph plugin folder with compiled output without committing `dist/` to the source repository.

Scope:

- Add a `pnpm package:plugin` command that creates an ignored release artifact directory.
- Package only the files needed for Codex plugin installation: `.codex-plugin/`, `.mcp.json`, `dist/`, `skills/`, `README.md`, `package.json`, and `LICENSE`.
- Generate a release-local `.agents/plugins/marketplace.json` whose `source.path` points at the packaged plugin folder.
- Keep source, tests, dependencies, local state, and generated artifacts out of the packaged plugin folder.
- Update package, manifest, server, smoke, validator, README, and roadmap metadata for `0.10.0`.
- Keep language support, SQLite persistence, and archive/registry publishing out of this release.

Official Codex grounding:

- The Codex manual says repo marketplaces can live at `$REPO_ROOT/.agents/plugins/marketplace.json`.
- The Codex manual says marketplace `source.path` points at a plugin folder using a `./`-prefixed path relative to the marketplace root.
- The Codex manual says plugin folders contain `.codex-plugin/plugin.json` and may bundle skills and MCP config.

Verification:

- `pnpm typecheck`
- `pnpm build`
- `pnpm vitest run tests/cli-smoke.test.ts`
- `pnpm test`
- `pnpm smoke -- --root . --json`
- `pnpm validate:plugin`
- `pnpm package:plugin -- --json`
