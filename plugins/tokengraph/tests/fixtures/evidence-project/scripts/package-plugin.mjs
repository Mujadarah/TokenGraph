export const releaseFiles = ["dist/index.js", ".codex-plugin/plugin.json", "README.md"];
export function packagePlugin() { return releaseFiles.slice().sort(); }
