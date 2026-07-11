# TokenGraph on Claude Code

Claude Code can install TokenGraph from the repository marketplace and launch its local stdio MCP server without a hand-written project config. The Claude-specific manifest keeps host transport details separate from the shared TokenGraph server.

Official references:

- Claude Code MCP guide: https://code.claude.com/docs/en/mcp
- MCP tool result content types: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Marketplace installation

From Claude Code, add the repository's `.claude-plugin/marketplace.json` as a marketplace source and install the `tokengraph` plugin. The marketplace entry points to the committed `release/tokengraph/` folder, which contains the self-contained `dist/index.js` runtime and does not require an npm install in the plugin cache.

The plugin manifest points to `.mcp.claude.json`. That config launches `${CLAUDE_PLUGIN_ROOT}/dist/index.js` and forwards `${CLAUDE_PROJECT_DIR}` as `TOKENGRAPH_WORKSPACE_ROOT`.

## Usage Notes

- Approve the marketplace-installed server when Claude Code prompts for plugin or MCP trust.
- Claude Code supplies `CLAUDE_PROJECT_DIR` to plugin-provided MCP servers; TokenGraph uses it as the trusted project root.
- A TokenGraph `root` argument may select only a path inside `CLAUDE_PROJECT_DIR`.
- Use `tokengraph_index_status`, `tokengraph_index_project`, `tokengraph_plan_context`, and `tokengraph_compress_context` before broad raw file reads.
- Map exports return structured JSON or Mermaid text plus Markdown fallbacks. Image output is not required.

## Compatibility Boundary

Claude-specific files should only configure transport and host policy. Do not add Claude-only parsing, indexing, memory, compression, or map-export logic.
