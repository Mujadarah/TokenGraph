# TokenGraph

TokenGraph is a local-first Codex plugin that helps coding agents spend less context on raw repository exploration. It builds a compact local map of a project, then routes Codex through focused code, SQL, wiki, memory, and log summaries before any broad file reading.

The project is designed for developers who want faster, more disciplined agent work on real codebases without sending repository indexes to paid or external services.

## Why TokenGraph

Large coding sessions often waste tokens by repeatedly reading files, logs, migrations, and generated output. TokenGraph gives Codex a local context router:

- Index the current workspace into a compact code graph.
- Summarize project structure before raw reads.
- Plan the smallest useful patch scope for a task.
- Surface relevant SQL tables, policies, constraints, enums, extensions, grants, indexes, triggers, functions, views, materialized views, and migration history.
- Store deliberate project decisions as local memory.
- Generate compact local wiki pages for orientation questions.
- Compress long test, build, install, diff, and log output.
- Detect stale indexes before Codex trusts cached context.

## Current Version

TokenGraph is currently at `0.10.1`.

Highlights:

- Local stdio MCP server in Node.js and TypeScript.
- Codex plugin metadata and TokenGraph skill.
- Project indexing for TypeScript, JavaScript, React, Next.js, PostgreSQL, and Supabase-style SQL migrations.
- Resolved local import edges for relative imports and common `@/` or `~/` aliases.
- Better React and Next.js route/component extraction, including `pages/**` routes and component line hints.
- Root `.gitignore` support during scanning.
- Project fingerprints and index freshness status.
- Incremental indexing for compatible persisted indexes, with `fullReindex` available when a complete rebuild is needed.
- Local config in `.tokengraph/config.json`.
- Token-saving profiles: `conservative`, `balanced`, and `aggressive`.
- Profile-aware planner budgets for files, SQL objects, memories, first reads, raw-read warnings, and estimated compact-context tokens.
- Local project wiki pages under `.tokengraph/wiki/` for overview, structure, routes, database, and recorded decisions.
- Wiki staleness status based on the persisted index fingerprint recorded in `.tokengraph/wiki/manifest.json`.
- `wikiGenerationEnabled` auto-refresh on successful indexing, while explicit wiki generation remains available regardless of the flag.
- Index-only reset that preserves memory and config while clearing derived wiki state.
- Context planner for focused first reads with line hints, tests, SQL objects, and ranked memories.
- Symbol explanation with inbound and outbound import references.
- Broader PostgreSQL parser coverage for constraints, enums, extensions, grants, and materialized views.
- Supabase RLS policy summaries with command, roles, `using`, and `with check` clauses.
- Ordered SQL object history across migration files.
- JSON-RPC stdio smoke tests for the built MCP entry point.
- Self-contained bundled MCP entry point so installed plugin caches do not need a `node_modules` install step.
- CLI smoke command for validating the built MCP server outside Codex.
- Release packaging that produces an installable plugin folder without committing `dist/`.
- Fixture-backed scanner and planner regression projects.
- Local plugin validator.
- Read-only memory review so Codex can inspect local project memories before relying on them.
- Mermaid or JSON project map export for compact visual graph review without raw source content.

## Repository Layout

```text
.
|-- .agents/plugins/marketplace.json
|-- docs/plans/
|-- docs/superpowers/specs/
`-- plugins/tokengraph/
    |-- .codex-plugin/plugin.json
    |-- .mcp.json
    |-- skills/tokengraph/SKILL.md
    |-- src/
    |-- tests/
    `-- scripts/validate-plugin.mjs
```

## Local Development

```powershell
cd plugins/tokengraph
pnpm install
pnpm build
pnpm test
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin
```

The MCP server entry point is `plugins/tokengraph/dist/index.js`, built from `plugins/tokengraph/src/index.ts`.

`pnpm build` runs TypeScript and bundles the MCP entry point into a self-contained `plugins/tokengraph/dist/index.js`. That lets Codex launch the installed plugin cache without running `pnpm install` inside the cache.

`pnpm smoke -- --root <project>` starts the built stdio MCP server with `<project>` as its workspace, lists the TokenGraph tools, and calls the project map, planner, token-savings, memory review, export, and wiki tools. Run `pnpm build` first so `dist/index.js` is current.

`pnpm package:plugin` creates an ignored release artifact under `artifacts/`. The artifact contains a compiled plugin folder plus a release-local `.agents/plugins/marketplace.json`, so public source releases do not need to commit `plugins/tokengraph/dist/`.

## Local Project Wiki

TokenGraph can generate a deterministic local wiki from already-indexed data. It never re-reads raw source for wiki page bodies and only includes paths, file kinds, routes, symbol names, SQL object names/details already in the SQL graph, and memory titles/types/tags.

Wiki files live under `.tokengraph/wiki/`:

- `.tokengraph/wiki/manifest.json` records the wiki schema, generation time, index fingerprint, and page files.
- `.tokengraph/wiki/overview.md` summarizes frameworks, file kinds, and top-level directories.
- `.tokengraph/wiki/structure.md` groups indexed files by top-level directory and lists exported symbols.
- `.tokengraph/wiki/routes.md` lists detected routes when routes exist.
- `.tokengraph/wiki/database.md` lists SQL tables, policies, materialized views, and migration history when SQL exists.
- `.tokengraph/wiki/decisions.md` lists recorded memory titles, types, and tags when memories exist.

`tokengraph_generate_wiki` explicitly builds the wiki from the persisted index. `tokengraph_show_wiki_page` reads one page and returns `wikiStatus` as `missing`, `fresh`, or `stale`. A wiki is fresh only when its manifest fingerprint matches the persisted index fingerprint. The `wikiGenerationEnabled` config flag controls automatic wiki refresh after successful indexing; explicit generation is always available.

## Codex Plugin Use

After building the plugin, add this repository as a local marketplace root if needed:

```powershell
codex plugin marketplace add C:\Users\example\Desktop\TokenGraph
```

Then install `tokengraph` from that marketplace and start a new Codex thread so the skill and MCP tools are loaded.

When iterating on this local plugin, rebuild it and restart Codex or start a fresh thread so the updated skill, manifest, and MCP server are loaded.

For release artifact testing, run:

```powershell
cd plugins/tokengraph
pnpm build
pnpm package:plugin
codex plugin marketplace add C:\Users\example\Desktop\TokenGraph\artifacts
```

The generated marketplace points at `./tokengraph-<version>` relative to the artifact root.

## Troubleshooting

- Missing MCP tools: confirm the plugin is installed/enabled, run `pnpm build`, run `pnpm smoke -- --root . --json`, then restart Codex or open a fresh thread.
- Stale indexes: call `tokengraph_index_status`; if stale, call `tokengraph_index_project`. Pass `fullReindex: true` only when you need a complete rebuild.
- Stale wiki pages: call `tokengraph_show_wiki_page`; if `wikiStatus` is `missing` or `stale`, call `tokengraph_generate_wiki`.
- Plugin build failures: run `pnpm typecheck`, then `pnpm build`; fix TypeScript errors before running `pnpm validate:plugin`.
- Marketplace not visible: confirm `.agents/plugins/marketplace.json` exists and that `source.path` points to `./plugins/tokengraph` relative to the repository root.
- Release package missing built files: run `pnpm build` before `pnpm package:plugin`; the package command requires `dist/index.js` and `dist/server.js`.

## MCP Tool Surface

TokenGraph exposes these MCP tools:

- `tokengraph_index_project`
- `tokengraph_index_status`
- `tokengraph_reset_project`
- `tokengraph_get_config`
- `tokengraph_set_profile`
- `tokengraph_update_config`
- `tokengraph_project_map`
- `tokengraph_generate_wiki`
- `tokengraph_show_wiki_page`
- `tokengraph_plan_context`
- `tokengraph_search_graph`
- `tokengraph_explain_symbol`
- `tokengraph_summarize_sql`
- `tokengraph_compress_output`
- `tokengraph_remember_decision`
- `tokengraph_review_memories`
- `tokengraph_export_project_map`
- `tokengraph_show_token_savings`

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned releases.

## Privacy

TokenGraph is local-first. Project indexes, generated wiki pages, config, and memories are stored under `.tokengraph/` in the indexed workspace. TokenGraph does not require an OpenAI API key, cloud sync, embeddings service, or paid external API.

## License

TokenGraph is proprietary source-available software. It is public for transparency, evaluation, and presentation, but it is not open source. See [LICENSE](LICENSE).
