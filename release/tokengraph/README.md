# TokenGraph Release Plugin

This folder is the installable TokenGraph 0.19.0 plugin for Codex and Claude Code users.

It includes the self-contained Node.js 22 MCP runtime at `dist/index.js`, host manifests, MCP configs, skills, package metadata, and license. It requires no dependency installation, TypeScript build, API key, cloud index, or embeddings service.

## Install

Recommended GitHub install for Codex:

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
```

For an extracted release ZIP, add the bundle directory that contains this `tokengraph/` folder, not this plugin folder itself:

```powershell
codex plugin marketplace add C:\path\to\tokengraph-0.19.0
codex plugin add tokengraph@tokengraph
```

Claude Code GitHub install:

```text
/plugin marketplace add Mujadarah/TokenGraph
/plugin install tokengraph@tokengraph
/reload-plugins
```

Claude launches through `${CLAUDE_PLUGIN_ROOT}` and forwards `${CLAUDE_PROJECT_DIR}`. Codex must provide MCP Roots or inherit `TOKENGRAPH_WORKSPACE_ROOT`. Call `tokengraph_setup_status` before project tools; it diagnoses setup without granting filesystem trust.

## Runtime

The MCP server starts with:

```text
node ./dist/index.js
```

The server is local-first. It indexes the selected workspace locally and stores project state under `.tokengraph/` in that workspace.

TokenGraph stores project state under `.tokengraph/` inside the trusted workspace. Token savings are estimates.

## Maintainers

Do not edit generated files in this release folder by hand. Make source changes in `plugins/tokengraph/`, then run:

```powershell
cd plugins/tokengraph
pnpm build
pnpm package:plugin -- --release
pnpm validate:plugin
```

Version: 0.19.0
