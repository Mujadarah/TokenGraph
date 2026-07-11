# TokenGraph Improvements Design

## Goal

Remediate every finding in `C:/Users/rabia/Desktop/tokengraph-improvement-plan.md`, retain TokenGraph's local-first distribution model, and publish the completed work as GitHub releases and tags.

## Delivery model

The work is delivered in five sequential feature branches and pull requests, matching the supplied phase boundaries:

1. `codex/tokengraph-phase1-security` fixes C1 and C2.
2. `codex/tokengraph-phase2-indexing` fixes M1, M2, H3, and H4.
3. `codex/tokengraph-phase3-sql-scanning` fixes H1 and M4-M7.
4. `codex/tokengraph-phase4-hygiene` fixes H2, H5, M8, M9, and L1-L6.
5. `codex/tokengraph-phase5-packaging` delivers M3, Claude Code support, CI, repository guidance, license clarity, release archives, tags, and GitHub Releases.

Each branch starts from the prior merged phase, uses conventional commits, and must pass typecheck, test, build, plugin validation, smoke validation, and a non-ASCII scan of changed files. The final phase increments the plugin and manifest version to `0.18.0`, updates the generated release bundle, attaches a zipped bundle to the `v0.18.0` GitHub Release, and publishes the tag.

## Security boundary

`workspaceRoot` will derive a single trusted host workspace from a host-provided value, never from an MCP tool argument. Claude Code supplies `CLAUDE_PROJECT_DIR`; Codex uses a workspace root returned through MCP Roots when its client supports that capability, or an explicitly forwarded `TOKENGRAPH_WORKSPACE_ROOT` environment variable. If a plugin-root launch provides neither trusted source, root-based operations fail closed with setup guidance. Every requested `root` must resolve inside that trusted workspace. The server rejects home directories and filesystem roots as workspace roots, rejects non-existent paths, and gives a clear error before any index or state write begins.

Codex keeps its native `.mcp.json` shape and documents the optional `env_vars` forwarding needed by older clients that do not implement MCP Roots. Claude Code receives a dedicated `.mcp.claude.json` that invokes the bundled runtime through `${CLAUDE_PLUGIN_ROOT}` and passes `${CLAUDE_PROJECT_DIR}`. Tests exercise a plugin-root launch with an outside root and verify that no external `.tokengraph` state is created.

Architecture rules continue to use JavaScript regular expressions, but all candidate patterns are validated before persistence. The validator runs compilation and a representative worst-case probe in a worker with a bounded timeout. Add and update reject unsafe patterns; the existing matcher treats stored patterns as already validated and retains literal fallback only for malformed legacy data.

## Indexing and persistence

Index updates acquire a per-resolved-project queue around the entire scan, load, incremental-diff, and save sequence. Memory lifecycle operations perform their read-modify-write steps inside the existing per-file queue. When an incremental pass finds semantic content unchanged, it persists the new index metadata and scan signature, restoring the fast freshness path.

The scanner records symlink exclusions, applies `.gitignore` rules at every traversed directory with subtree-relative matching, canonicalizes line endings before hashing, and computes symbol end lines using balanced declaration state. Route generation only emits pages and API routes, never layouts, so the wiki lists each route once.

## SQL, context, and memory fidelity

The SQL statement scanner returns parse diagnostics when it ends inside a quoted or comment state; migration parsing carries those diagnostics into the persisted SQL graph and tool responses. Unquoted PostgreSQL identifiers normalize to lower case while quoted names preserve case, and quoted multiword column names remain intact.

Token estimates use a script-aware heuristic for CJK and emoji-rich text. Compressor limits use UTF-8 byte counts. Conflict detection measures overlap in titles, bodies, and tags rather than granting a matching memory type one overlap point. Repeated memory recall remains idempotent by only refreshing stale usage timestamps.

## Honesty and release packaging

Tools that can cause `ensureProject` to write an index advertise `readOnlyHint: false`. The plugin README is generated or validated against the registered tool list, preventing tool-documentation drift. Plugin validation scans every release-bound file for personal Windows paths.

The release packager copies only the self-contained `dist/index.js` runtime, never compiled modules that require unavailable dependencies. The validator reads tool-registration evidence from that bundle and asserts the omitted files are absent. The release manifest, Codex config, Claude manifest/config, skills, generated README, package metadata, and license are the complete portable package.

## Host and infrastructure support

The source and generated release receive a Claude manifest and launcher configuration. Root-level `.claude-plugin/marketplace.json` exposes the release package as a Claude Code marketplace. Skills use host-neutral copy and include an explicit `when to use` frontmatter line. Host documentation describes marketplace installation for Codex and Claude Code.

GitHub Actions runs on pushes and pull requests with pinned actions, locked pnpm installation, typecheck, tests, build, validator, non-ASCII scan, release regeneration/diff verification, and strict Claude plugin validation. Root `AGENTS.md` and `CLAUDE.md` document architecture, generated-release rules, commands, and conventional commits. README and package metadata explicitly link to the proprietary source-available license.

## Verification

Every behavior change starts with a focused failing Vitest regression test, then receives the smallest production change needed to pass. Package changes additionally run artifact inspection and a direct newline-delimited JSON-RPC probe of the generated bundle. Final publication is gated on successful local checks, a clean regenerated release diff, an installed-cache MCP probe, remote GitHub commit verification, and an uploaded ZIP asset matching the generated release folder.
