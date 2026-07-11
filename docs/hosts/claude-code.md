# TokenGraph on Claude Code

Claude Code can connect to TokenGraph as a local stdio MCP server. Use this guide for direct MCP configuration; keep the TokenGraph core server shared with Codex and other hosts.

Official references:

- Claude Code MCP guide: https://code.claude.com/docs/en/mcp
- MCP tool result content types: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Project Configuration

For a project-scoped setup, add `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "tokengraph": {
      "command": "node",
      "args": ["./release/tokengraph/dist/index.js"],
      "env": {}
    }
  }
}
```

If TokenGraph is installed outside the current repository, use that release package's absolute `dist/index.js` path or a host-supported variable. Keep secrets out of the file; TokenGraph itself does not require API keys.

## Usage Notes

- Approve the project-scoped server when Claude Code prompts for `.mcp.json` trust.
- Claude Code supplies `CLAUDE_PROJECT_DIR` to plugin-provided MCP servers; TokenGraph uses it as the trusted project root.
- A TokenGraph `root` argument may select only a path inside `CLAUDE_PROJECT_DIR`.
- Use `tokengraph_index_status`, `tokengraph_index_project`, `tokengraph_plan_context`, and `tokengraph_compress_context` before broad raw file reads.
- Map exports return structured JSON or Mermaid text plus Markdown fallbacks. Image output is not required.

## Compatibility Boundary

Claude-specific files should only configure transport and host policy. Do not add Claude-only parsing, indexing, memory, compression, or map-export logic.
