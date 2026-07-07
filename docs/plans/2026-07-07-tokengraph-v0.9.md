# TokenGraph v0.9 Local Project Wiki Implementation Plan

Goal: activate the dormant `wikiGenerationEnabled` config flag by adding a local project wiki generated from the persisted TokenGraph index and memory store.

Scope:

- Build deterministic Markdown wiki pages from `ProjectIndex` and `MemoryEntry` records only.
- Persist pages under `.tokengraph/wiki/` with a `manifest.json` that records the index fingerprint.
- Add wiki status for missing, fresh, and stale generated pages.
- Add MCP tools `tokengraph_generate_wiki` and `tokengraph_show_wiki_page`.
- Auto-refresh the wiki after successful indexing only when `wikiGenerationEnabled` is true.
- Keep explicit wiki generation available regardless of `wikiGenerationEnabled`.
- Clear derived wiki state with index resets while preserving memory and config.
- Update docs, skill guidance, smoke coverage, validator checks, and release metadata for `0.9.0`.

Constraints:

- Wiki page bodies must be deterministic for the same index.
- Page bodies must not include raw source contents or memory bodies.
- Page bodies may include indexed file paths, file kinds, routes, exported symbol names, SQL object names/details already present in the SQL graph, and memory titles/types/tags.
- Keep v0.10+ work out of this release.

Verification:

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm smoke -- --root . --json`
- `pnpm validate:plugin`
