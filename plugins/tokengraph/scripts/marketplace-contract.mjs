export const CODEX_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
export const CLAUDE_MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

export function buildCodexMarketplace(pluginPath) {
  return {
    name: "tokengraph",
    interface: { displayName: "TokenGraph" },
    plugins: [{
      name: "tokengraph",
      source: { source: "local", path: pluginPath },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools"
    }]
  };
}

export function buildClaudeMarketplace(version, pluginPath) {
  return {
    name: "tokengraph",
    owner: { name: "Mujadarah" },
    metadata: {
      description: "Local-first project context routing for Codex and Claude Code."
    },
    plugins: [{
      name: "tokengraph",
      source: pluginPath,
      version,
      description: "Route coding agents through compact local code, SQL, memory, wiki, and log context.",
      category: "Developer Tools",
      tags: ["mcp", "code-intelligence", "local-first", "context"]
    }]
  };
}

export function marketplaceBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
