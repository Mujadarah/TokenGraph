# TokenGraph repository guidance

TokenGraph is a local-first MCP plugin. The TypeScript source, tests, scripts, and skills live under `plugins/tokengraph/`; `release/tokengraph/` is generated installable output and must never be edited by hand.

Common checks from `plugins/tokengraph/`:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin -- --release
```

Keep the MCP server host-neutral. Codex uses `.mcp.json`; Claude Code uses `.mcp.claude.json` with `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR`. Preserve the trusted workspace boundary and local-only storage model when changing tools.

Use conventional commits (`fix(scope): ...`, `feat(scope): ...`, `docs(scope): ...`, `chore(scope): ...`). Update source and regenerate the release bundle together.
