# Release Install

TokenGraph provides two installable release paths:

1. The GitHub repository marketplaces point at the committed `release/tokengraph/` plugin.
2. The GitHub release ZIP extracts to a standalone marketplace root containing both host catalogs and a nested `tokengraph/` plugin.

Both paths include the bundled runtime and require no `pnpm install`, TypeScript build, OpenAI API key, Anthropic API key, cloud sync, or embeddings service.

The release plugin does require Node.js 22 or newer. Codex must supply MCP Roots or inherit `TOKENGRAPH_WORKSPACE_ROOT`; Claude Code forwards `CLAUDE_PROJECT_DIR`. Call `tokengraph_setup_status` to verify the trust boundary before indexing.

If tools are missing, confirm the plugin is installed and enabled, then start a new Codex task or run `/reload-plugins` in Claude Code. If setup is blocked, follow the diagnostic recovery steps. Never work around the boundary by trusting an arbitrary caller-provided path.
