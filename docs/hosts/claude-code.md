# TokenGraph on Claude Code

TokenGraph ships a Claude Code marketplace, plugin manifest, focused skills, and the same local stdio MCP server used by Codex. The release is self-contained and requires Node.js 22 or newer.

Official references:

- https://code.claude.com/docs/en/discover-plugins
- https://code.claude.com/docs/en/plugin-marketplaces
- https://code.claude.com/docs/en/mcp

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

Extract `tokengraph-0.19.0.zip`, add the extracted bundle root, and install:

```text
/plugin marketplace add /path/to/tokengraph-0.19.0
/plugin install tokengraph@tokengraph
/reload-plugins
```

The bundle marketplace points at its nested `tokengraph/` plugin directory.

## Workspace trust and verification

Claude Code launches `${CLAUDE_PLUGIN_ROOT}/dist/index.js` and forwards `${CLAUDE_PROJECT_DIR}` as `TOKENGRAPH_WORKSPACE_ROOT`. TokenGraph accepts only the project directory and its descendants.

After installation:

1. Call `tokengraph_setup_status`; expect `ready` with source `CLAUDE_PROJECT_DIR`.
2. Call `tokengraph_index_status`.
3. Index or refresh the project when necessary.
4. Use `tokengraph_plan_context` before broad raw reads.

If plugin changes are not visible, run `/reload-plugins`. If setup is blocked, follow the diagnostic response rather than retrying arbitrary roots.
