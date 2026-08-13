# Release Install

TokenGraph provides two installable release paths:

1. The GitHub repository marketplaces point at the committed `release/tokengraph/` plugin.
2. The GitHub release ZIP extracts to a standalone marketplace root containing both host catalogs and a nested `tokengraph/` plugin.

Both paths include the bundled runtime and require no `pnpm install`, TypeScript build, OpenAI API key, Anthropic API key, cloud sync, or embeddings service.

Both install paths include exactly six prebuilt native lock addons for Windows x64/arm64, glibc Linux x64/arm64, and macOS x64/arm64. Runtime loading needs no compiler, download, package installation, network lookup, sidecar, or JavaScript fallback. Linux requires kernel 4.18 and glibc 2.28 or newer; musl and unlisted targets fail closed.

Before activating the native-lock runtime, stop every v0.23.1 TokenGraph MCP and CLI process. Start v2, then activate that MCP server only through `tokengraph_setup({ confirmNoLegacyProcesses: true })`; each lock-taking CLI invocation separately requires `--confirm-no-legacy-processes`. If an old runtime starts later, stop it and restart or reactivate v2 before any further lock-taking operation. Mixed-runtime concurrency is unsupported. Doctor reports activation, target, ABI, integrity, and availability as read-only status but never grants activation.

Managed hooks remain permanently unactivated and project-read-only. Host attestation and plugin-data state authorize only strict lifecycle reads for the matching workspace; they do not grant native-lock activation.

The plugin (v0.20 and later) also includes `dist/hooks.js` and auto-discovered `hooks/hooks.json`. Review and trust the commands before enabling them. Hook disablement and abnormal stops are documented limitations, not successful completion evidence.

The release plugin does require Node.js 22 or newer. Codex must supply MCP Roots or inherit `TOKENGRAPH_WORKSPACE_ROOT`; Claude Code forwards `CLAUDE_PROJECT_DIR`. Call `tokengraph_setup` to verify the trust boundary before indexing.

If tools are missing, confirm the plugin is installed and enabled, then start a new Codex task or run `/reload-plugins` in Claude Code. If setup is blocked, follow the diagnostic recovery steps. Never work around the boundary by trusting an arbitrary caller-provided path.
