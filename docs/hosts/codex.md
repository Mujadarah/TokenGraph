# TokenGraph on Codex

TokenGraph ships as a Codex plugin with focused skills and a local stdio MCP server. The committed release plugin is self-contained and requires Node.js 22 or newer, but no dependency installation or API key.

Official references:

- https://developers.openai.com/codex/plugins
- https://developers.openai.com/codex/plugins/build
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/hooks

## Install from GitHub

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
codex plugin list --json
```

The marketplace resolves `tokengraph@tokengraph` to `release/tokengraph/`. Start a new Codex task after installing or updating the plugin.

## Configure workspace trust

TokenGraph must receive a trusted project root from the host. Codex request metadata now names the active project and thread on every tool call; TokenGraph accepts it only when it matches the reviewed `SessionStart` or `UserPromptSubmit` attestation for that thread. The attestation bridge is keyed by the host's `CODEX_THREAD_ID`, while MCP calls carry that same identity in request metadata. One installed plugin can therefore follow multiple simultaneous tasks into separate repositories without a global workspace variable. MCP Roots remain supported.

If hooks are disabled or untrusted and Codex does not supply MCP Roots, set `TOKENGRAPH_WORKSPACE_ROOT` before starting Codex as a compatibility fallback:

```powershell
$env:TOKENGRAPH_WORKSPACE_ROOT=(Get-Location).Path
codex
```

```bash
TOKENGRAPH_WORKSPACE_ROOT="$PWD" codex
```

The session attestation is scoped to the installed plugin root and the exact task id, expires after 24 hours unless refreshed by a prompt, and is removed on `SessionEnd`. A root argument passed by a tool caller is never treated as authority. Active graph, memory, config, wiki, and repository records live under each project's `.tokengraph/` directory. Legacy `.git/tokengraph/` JSON records are copied once with workspace data winning conflicts and the old files retained as a backup.

Call `tokengraph_setup` first. A `blocked` result includes the missing or unsafe trust reason and recovery commands without reading project files. A `ready` result identifies the trusted source and root.

## Lifecycle hook trust and control

Codex auto-discovers TokenGraph's `hooks/hooks.json`, but installing or enabling a plugin does not trust its hooks. Review and trust the current definition before expecting automatic workspace attestation, PostToolUse task tracking, or Stop completion checks. Codex supplies `PLUGIN_ROOT`/`PLUGIN_DATA` and the Claude-compatible aliases used by the shared adapter.

The workspace bridge stores only plugin/session hashes, trusted root, schema/version, and timestamp in the operating-system temporary directory for up to 24 hours. The task lifecycle pointer separately stores only a session hash, task id, trusted root, turn id, schema/version, and timestamp in plugin data for up to 30 days. Neither stores prompts, transcripts, or tool payloads. On a normal Stop the hook can request one exact pause-or-complete report call or the exact canonical footer. Its retry continuation fails open with a warning rather than looping.

To disable hooks globally, set this in Codex `config.toml` and restart the task:

```toml
[features]
hooks = false
```

When the hook is disabled, untrusted, missing state, or the turn ends through an interrupt or API failure, call `tokengraph_task_report` explicitly. Those abnormal endings are not completion claims.

For planning, call `tokengraph_prepare_context` and retain its compact task id and plan. A direct query, compression, recall, or analysis call may omit `taskId`; it auto-starts the ledger and returns the task id. Reuse that exact id. After ready setup, omit `root` when host resolution is stable or pass only setup's trusted root. End completed and verified work with compact `tokengraph_task_report({ taskId })`; use verbose mode only for diagnostics and `pause` for unfinished work.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent that omits `taskId`; Stop remains allowed for the paused task.

## Install an extracted release bundle

Extract `tokengraph-0.23.1.zip`, then add the extracted bundle root:

```powershell
codex plugin marketplace add C:\path\to\tokengraph-0.23.1
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
