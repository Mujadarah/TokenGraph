# TokenGraph on Cursor and Windsurf/Cascade

Cursor and Windsurf/Cascade both document MCP configuration for custom servers. TokenGraph should stay a single stdio MCP server with host-specific setup notes only.

Official references:

- Cursor MCP docs: https://cursor.com/docs/mcp.md
- Windsurf/Cascade MCP docs: https://docs.windsurf.com/windsurf/cascade/mcp
- Windsurf/Cascade plugin MCP docs: https://docs.windsurf.com/plugins/cascade/mcp
- MCP tool result content types: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Cursor

Project-scoped configuration goes in `.cursor/mcp.json`; global configuration goes in `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "tokengraph": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/release/tokengraph/dist/index.js"],
      "env": {}
    }
  }
}
```

Use Cursor settings to enable, disable, inspect, and debug the server. TokenGraph map exports remain usable without MCP Apps because they include structured JSON and Markdown fallbacks. Cursor hosts that support resources or images can use those features progressively; they are not required for TokenGraph correctness.

## Windsurf/Cascade

The current official Windsurf/Cascade docs describe adding MCPs from settings or by editing raw MCP config JSON. For a local stdio server, use the documented `mcpServers` shape:

```json
{
  "mcpServers": {
    "tokengraph": {
      "command": "node",
      "args": ["/path/to/release/tokengraph/dist/index.js"],
      "env": {}
    }
  }
}
```

After adding the server, refresh the MCP list in the host. Team or enterprise environments may require an admin to enable or whitelist MCP access.

## Host-Neutral Rule

Cursor, Windsurf, and other MCP hosts should consume the same TokenGraph tools:

- `tokengraph_index_status`
- `tokengraph_index_project`
- `tokengraph_project_map`
- `tokengraph_plan_context`
- `tokengraph_compress_context`
- `tokengraph_export_project_map`

Do not fork core behavior per host. Keep differences limited to config file location, approval model, transport fields, and documentation.
