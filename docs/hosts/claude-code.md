# TokenGraph on Claude Code

TokenGraph ships a Claude Code marketplace, plugin manifest, focused skills, and the same local stdio MCP server used by Codex. The release is self-contained and requires Node.js 22 or newer.

Official references:

- https://code.claude.com/docs/en/discover-plugins
- https://code.claude.com/docs/en/plugin-marketplaces
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/hooks

## Install from GitHub

Run inside Claude Code:

```text
/plugin marketplace add Mujadarah/TokenGraph
/plugin install tokengraph@tokengraph
/reload-plugins
```

Or use the non-interactive CLI:

```bash
claude plugin marketplace add Mujadarah/TokenGraph
claude plugin install tokengraph@tokengraph
```

## Install an extracted release bundle

Extract `tokengraph-0.21.1.zip`, add the extracted bundle root, and install:

```text
/plugin marketplace add /path/to/tokengraph-0.21.1
/plugin install tokengraph@tokengraph
/reload-plugins
```

The bundle marketplace points at its nested `tokengraph/` plugin directory.

## Workspace trust and verification

Claude Code launches `${CLAUDE_PLUGIN_ROOT}/dist/index.js` and forwards `${CLAUDE_PROJECT_DIR}` as `TOKENGRAPH_WORKSPACE_ROOT`. TokenGraph accepts only the project directory and its descendants.

After installation:

1. Call `tokengraph_setup`; expect a ready trusted workspace from `CLAUDE_PROJECT_DIR`.
2. For planning, call `tokengraph_prepare_context` and retain its compact task id and plan. For direct query, compression, recall, or analysis, omit `taskId` on the first intent; it starts the task and returns the id.
3. Reuse the exact task id. After ready setup, omit `root` when host resolution is stable or pass only setup's trusted root.
4. End completed and verified work with compact `tokengraph_task_report({ taskId })`. Use verbose mode only for diagnostics and `pause` for unfinished work.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent that omits `taskId`; Stop remains allowed for the paused task.

If plugin changes are not visible, run `/reload-plugins`. If setup is blocked, follow the diagnostic response rather than retrying arbitrary roots.

## Lifecycle hook inspection and control

Claude Code auto-discovers `hooks/hooks.json`. Use `/hooks` to confirm TokenGraph's PostToolUse and Stop commands and their plugin source. The shared Node adapter uses `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` and has no shell, jq, or Python dependency.

The hook stores only a session hash, task id, trusted root, turn id, schema/version, and timestamp in plugin data for up to 30 days. It never reads the transcript or stores prompts and tool payloads. Normal Stop may request one exact report call or the exact canonical footer; when `stop_hook_active` is already true it warns and allows the stop to avoid a loop.

To temporarily disable all Claude Code hooks, set `"disableAllHooks": true` in the applicable settings file. Claude Code does not support disabling just one configured hook; disable the TokenGraph plugin if only its bundled hook must be removed. When hooks are disabled or unavailable, call `tokengraph_task_report` explicitly. User interrupts, StopFailure, and API failures are outside completion enforcement and must not be reported as completed work.
