# TokenGraph Release Plugin

This folder is the installable TokenGraph plugin for normal Codex users.

It includes the compiled MCP runtime under `dist/`, the plugin manifest, MCP config, skills, package metadata, and license. A normal user install from the repository marketplace should not require `pnpm install`, `pnpm build`, TypeScript, or a local dependency install inside this folder.

## Install

Add the repository root as a Codex marketplace source:

```powershell
codex plugin marketplace add C:\path\to\TokenGraph
```

Then install `tokengraph` from that marketplace and start a new Codex thread. The root marketplace points to `./release/tokengraph`.

## Runtime

The MCP server starts with:

```text
node ./dist/index.js
```

The server is local-first. It indexes the selected workspace locally and stores project state under `.tokengraph/` in that workspace.

TokenGraph does not require an OpenAI API key, cloud sync, an embeddings service, telemetry, or a paid external API. Token savings are estimates.

## Maintainers

Do not edit generated files in this release folder by hand. Make source changes in `plugins/tokengraph/`, then run:

```powershell
cd plugins/tokengraph
pnpm build
pnpm package:plugin -- --release
pnpm validate:plugin
```

Version: 0.17.0
