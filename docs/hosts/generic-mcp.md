# Generic MCP Stdio Hosts

TokenGraph is a host-neutral MCP stdio server. Any MCP client that can start a local command and send JSON-RPC requests can use the same server bundle that Codex uses.

Official reference:

- MCP tools specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Server Command

```json
{
  "mcpServers": {
    "tokengraph": {
      "command": "node",
      "args": ["/path/to/tokengraph/dist/index.js"],
      "env": {}
    }
  }
}
```

Use the committed release package for distributable installs:

```text
release/tokengraph/dist/index.js
```

## Required Call Flow

1. Start the process with stdio connected.
2. Send `initialize`.
3. Send `notifications/initialized`.
4. Call `tools/list`.
5. Call TokenGraph tools with `root` set to the target workspace when the server process is not started from that workspace.

## Output Contract

- Every tool returns text content containing serialized JSON.
- Tools also return structured JSON in `structuredContent`.
- `tokengraph_export_project_map` returns `content`, `resourceLinks`, and `markdownFallback`.
- `tokengraph_compress_context` returns preserved constraints, referenced memories, wiki references, recommended first reads, omissions, confidence, and estimated tokens.
- Optional image content should only be added by a future host-aware enhancement when the host explicitly supports it; text, JSON, and Markdown must remain sufficient.

## Security Notes

TokenGraph is local-first. It reads the target workspace and writes `.tokengraph/` state under that workspace. Review host approval prompts and keep MCP command paths pinned to trusted local packages.
