# TokenGraph on Codex

TokenGraph ships as a Codex plugin with focused skills and a local stdio MCP server. The committed release plugin is self-contained and requires Node.js 22 or newer, but no dependency installation or API key.

Official references:

- https://developers.openai.com/codex/plugins
- https://developers.openai.com/codex/plugins/build
- https://developers.openai.com/codex/mcp

## Install from GitHub

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
codex plugin list --json
```

The marketplace resolves `tokengraph@tokengraph` to `release/tokengraph/`. Start a new Codex task after installing or updating the plugin.

## Configure workspace trust

TokenGraph must receive a trusted project root from the host. If Codex supplies MCP Roots, no environment variable is necessary. Otherwise, set `TOKENGRAPH_WORKSPACE_ROOT` before starting Codex:

```powershell
$env:TOKENGRAPH_WORKSPACE_ROOT=(Get-Location).Path
codex
```

```bash
TOKENGRAPH_WORKSPACE_ROOT="$PWD" codex
```

For Codex Desktop, the task must receive MCP Roots or the app process must inherit `TOKENGRAPH_WORKSPACE_ROOT`. A root argument passed by a tool caller is never treated as authority.

Call `tokengraph_setup_status` first. A `blocked` result includes the missing or unsafe trust reason and recovery commands without reading project files. A `ready` result identifies the trusted source and root.

## Install an extracted release bundle

Extract `tokengraph-0.19.0.zip`, then add the extracted bundle root:

```powershell
codex plugin marketplace add C:\path\to\tokengraph-0.19.0
codex plugin add tokengraph@tokengraph
```

Do not add the nested `tokengraph/` plugin directory as the marketplace root.

## Migrate from v0.18

v0.18 used `tokengraph@personal`. Verify the new marketplace and install first, then remove the old marketplace if it contains no other plugins:

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
codex plugin list --json
codex plugin marketplace remove personal
```

## Verify

1. Confirm `codex plugin list --json` shows `tokengraph@tokengraph`, enabled, with its source under `release/tokengraph` or the extracted bundle.
2. Start a new task.
3. Ask: `Use TokenGraph to check setup, index this project, and plan compact context.`
4. Confirm setup is ready before trusting any project map or index.

Project tools remain constrained to the trusted workspace, and filesystem roots and home directories are refused.
