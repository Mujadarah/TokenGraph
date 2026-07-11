# TokenGraph on Codex

TokenGraph's primary package target is a Codex plugin: one plugin directory, one `.codex-plugin/plugin.json`, one `.mcp.json`, focused skills under `skills/`, and the same bundled MCP server used by every host.

Official references:

- OpenAI Codex plugin build guidance: https://developers.openai.com/codex/plugins/build
- OpenAI Codex plugin usage guidance: https://developers.openai.com/codex/plugins
- OpenAI Codex MCP guidance: https://developers.openai.com/codex/mcp
- MCP tool result content types: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Repository Marketplace Install

The root marketplace points Codex at the committed release package:

```json
{
  "name": "tokengraph",
  "source": {
    "source": "local",
    "path": "./release/tokengraph"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  }
}
```

Install from the Codex plugin directory after restarting Codex or refreshing the marketplace source. The release package includes the bundled MCP runtime, skills, manifest, license, and package metadata.

## Runtime Behavior

- Codex launches the plugin-provided MCP server from the installed plugin package.
- TokenGraph tools accept `root`, but it is always constrained to a trusted workspace. Codex clients that do not answer MCP Roots must forward `TOKENGRAPH_WORKSPACE_ROOT` in the server configuration, for example:

```toml
[mcp_servers.tokengraph]
env_vars = ["TOKENGRAPH_WORKSPACE_ROOT"]
```

Never use a caller-supplied `root` as the trust boundary. Filesystem roots and home directories are rejected.
- Tool responses include `structuredContent` and a serialized text block for compatibility.
- Project map exports include structured JSON or Mermaid text, resource-link metadata, and Markdown fallbacks.
- TokenGraph does not require a UI framework. If a future Codex surface supports richer rendering, keep it as progressive enhancement over the same MCP tools.

## Do Not Fork

Do not create a separate Codex-only TokenGraph server. Codex packaging should stay in the manifest, marketplace, release folder, and docs while core behavior remains in `plugins/tokengraph/src`.
