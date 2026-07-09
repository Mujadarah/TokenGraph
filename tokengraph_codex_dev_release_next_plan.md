# TokenGraph Codex Prompt And Implementation Plan

Purpose: Feed this file to Codex to fix the current TokenGraph install architecture, remove redundant implemented plans, and continue the next development stages without breaking the existing local-first MCP plugin.

Repository: https://github.com/Mujadarah/TokenGraph
Primary target now: Codex app
Future compatibility target: Claude Code and other MCP-capable coding agents

## 0\. Non-negotiable instructions

1. Do not add personal local usernames or machine-specific paths to public docs.
2. Never write paths like C:\\Users\\rabia... in README, plugin README, docs, examples, tests, or generated release docs.
3. Use one of these neutral examples instead:

   * C:\\Users\\example\\Desktop\\TokenGraph
   * <USER\_HOME>\\Desktop\\TokenGraph
   * /home/example/TokenGraph
4. Keep TokenGraph local-first.
5. Do not add mandatory cloud services, API keys, hosted graph databases, embeddings services, or telemetry.
6. Do not rename existing MCP tools unless there is a compatibility shim.
7. Do not remove working tools.
8. Prefer additive changes with tests first.
9. Token savings are estimates, not exact measurements.
10. Compression must not reduce implementation quality. If compression would hide important information, preserve the raw reference or explicitly recommend a targeted raw read.
11. Treat raw files, raw SQL, raw logs, and full memory dumps as the final fallback, not the default context path.
12. Keep Codex behavior graph-first, wiki-first, memory-reviewed, and raw-context-last.
13. MCP output should remain compact and structured.
14. Every new MCP tool must be documented, covered by tests, included in smoke validation, and listed in plugin validation.
15. The normal user install path must not require pnpm install, pnpm build, or a TypeScript build step.

## 1\. Correct diagnosis

The repo already has a development/release separation, but it is incomplete for true one-click install.

Current intended design:

* plugins/tokengraph/ is the maintainer development source plugin.
* artifacts/tokengraph-<version>/ is the generated installable release plugin.
* artifacts/ is ignored by git.
* dist/ is ignored by git.
* .mcp.json launches node ./dist/index.js.
* The root marketplace currently points to ./plugins/tokengraph.

Problem:

If Codex installs TokenGraph from the root marketplace, it boots from the development source folder. That folder is only installable after maintainers run pnpm build. Since dist/ is ignored, a fresh GitHub checkout or Codex install can point the MCP server at a missing ./dist/index.js. This explains the failure where TokenGraph MCP tools are not exposed in Codex.

Do not solve this by creating folders literally named "Developer state" and "Release state". Use a clean repository convention instead.

Recommended architecture:

* plugins/tokengraph/ remains the development source plugin.
* release/tokengraph/ becomes the committed one-click installable user plugin.
* .agents/plugins/marketplace.json points to ./release/tokengraph for normal Codex install.
* package-plugin.mjs can still build ignored artifacts for local release testing, but it must also be able to update release/tokengraph.

This gives both workflows:

* Maintainers develop in plugins/tokengraph/.
* Users install from release/tokengraph/ with one click and get MCP tools immediately.

## 2\. Current repo state to assume

TokenGraph is already around v0.10.1 and already includes:

* Codex plugin metadata.
* Repo-local marketplace metadata.
* Local stdio MCP server in Node.js and TypeScript.
* Broad TokenGraph Codex skill.
* TypeScript and JavaScript indexing.
* React and Next.js graph detection.
* Relative and common alias import resolution.
* PostgreSQL and Supabase-style SQL migration parsing.
* SQL objects for tables, relations, policies, constraints, indexes, triggers, functions, views, enums, extensions, grants, materialized views, and migration history.
* Local JSON persistence under .tokengraph/.
* Index status and stale index detection.
* Index reset controls.
* Incremental indexing.
* Local config in .tokengraph/config.json.
* Token-saving profiles: conservative, balanced, aggressive.
* Profile-aware context planning.
* Local project wiki generation.
* Wiki freshness status.
* Context planner.
* SQL summarizer.
* Symbol explanation.
* Local memory storage.
* Read-only memory review.
* Mermaid and JSON project map export.
* Log, test, build, install, diff, and general output compression.
* Token savings estimates.
* Smoke tests.
* CLI smoke command.
* Plugin validation script.
* Fixture-backed regression tests.
* Release packaging that produces ignored artifacts.

Therefore, do not redo v0.8, v0.9, or v0.10 as if they are missing.

## 3\. Immediate Codex prompt

Use this exact prompt first:

You are working in the TokenGraph repository.

Goal: fix the Codex MCP tools not exposed problem by separating the maintainer development source plugin from the normal user one-click install plugin, then clean redundant implemented plan files, then continue the next missing TokenGraph stages.

Important facts:

* plugins/tokengraph/ is the development source plugin.
* .mcp.json launches node ./dist/index.js.
* dist/ is ignored by git.
* artifacts/ is ignored by git.
* pnpm package:plugin currently creates a compiled installable plugin under artifacts/.
* The root .agents/plugins/marketplace.json currently points to ./plugins/tokengraph.
* A normal Codex user should not need to run pnpm install or pnpm build.
* Public docs must not contain personal usernames or machine-specific profile paths.
* Use C:\\Users\\example\\Desktop\\TokenGraph or <USER\_HOME> examples only.

Implement the safest architecture:

1. Keep plugins/tokengraph/ as the maintainer source plugin.
2. Add a committed release/tokengraph/ installable plugin folder.
3. Make release/tokengraph/ contain only files needed for normal Codex install:

   * .codex-plugin/plugin.json
   * .mcp.json
   * dist/index.js
   * dist/server.js
   * skills/
   * README.md
   * package.json
   * LICENSE
4. Update .agents/plugins/marketplace.json so normal Codex installs point to ./release/tokengraph, not ./plugins/tokengraph.
5. Update package-plugin.mjs so it can write a committed release folder, preferably with a flag such as --release or --out-release.
6. Keep artifacts/ support for ignored local release testing.
7. Add validation that fails if the active marketplace target does not contain .codex-plugin/plugin.json, .mcp.json, dist/index.js, dist/server.js, skills/, README.md, package.json, and LICENSE.
8. Update README and plugins/tokengraph/README.md to clearly distinguish:

   * development install for maintainers
   * release install for normal users
9. Remove all personal local paths from docs, especially C:\\Users\\rabia\\Desktop\\TokenGraph.
10. Delete docs/plans files for releases already implemented: v0.8, v0.9, and v0.10 plan files.
11. Update ROADMAP.md so completed phases remain summarized there, and future work starts at the next missing release.
12. Run pnpm typecheck, pnpm build, pnpm test, pnpm smoke -- --root . --json, pnpm validate:plugin, and the release packaging command.
13. Verify that a fresh Codex install from the root marketplace loads TokenGraph MCP tools without building.

Do not implement future intelligence stages until the one-click install path is fixed and validated.

## 4\. Phase A: One-click release architecture

Version target: v0.10.2 or v0.11.0, depending on project versioning preference.

### A1. Create committed release folder

Add:

* release/tokengraph/.codex-plugin/plugin.json
* release/tokengraph/.mcp.json
* release/tokengraph/dist/index.js
* release/tokengraph/dist/server.js
* release/tokengraph/skills/
* release/tokengraph/README.md
* release/tokengraph/package.json
* release/tokengraph/LICENSE

The release folder must not include:

* src/
* tests/
* scripts/
* node\_modules/
* .tokengraph/
* local temp state
* docs/plans/
* artifacts/
* environment files

### A2. Update package script

Modify plugins/tokengraph/scripts/package-plugin.mjs so it supports:

* current ignored artifacts output
* committed release output at release/tokengraph/

Suggested behavior:

* pnpm package:plugin keeps creating artifacts/tokengraph-<version>/.
* pnpm package:plugin -- --release writes release/tokengraph/.
* pnpm package:plugin -- --out <directory> keeps custom output behavior.
* The release output should be deterministic.
* The script should fail if build output is missing.
* The script should copy LICENSE from repo root.
* The script should not copy source-only files.

### A3. Update root marketplace

Change .agents/plugins/marketplace.json so it points to the committed release plugin:

* name: tokengraph-release or personal if required by Codex
* displayName: TokenGraph Release or TokenGraph
* plugin source path: ./release/tokengraph
* installation: AVAILABLE
* authentication: ON\_INSTALL

Add a development marketplace only if needed, for maintainers. If adding one, place it somewhere clearly named, for example:

* .agents/plugins/marketplace.dev.json

Do not let normal user docs tell people to install from the source folder unless they are maintainers.

### A4. Update validation

Enhance plugins/tokengraph/scripts/validate-plugin.mjs to validate both:

1. Source plugin health for maintainers.
2. Release marketplace health for users.

Release validation must verify:

* root marketplace path resolves to release/tokengraph
* release/tokengraph/.codex-plugin/plugin.json exists
* release/tokengraph/.mcp.json exists
* release/tokengraph/dist/index.js exists
* release/tokengraph/dist/server.js exists
* release/tokengraph/skills exists and has at least one SKILL.md
* release/tokengraph/README.md exists
* release/tokengraph/package.json exists
* release/tokengraph/LICENSE exists
* release package version matches plugin manifest base version
* .mcp.json command points at ./dist/index.js relative to the release plugin root

### A5. Update docs

Root README must explain:

* Normal users install TokenGraph from the root marketplace, which points to release/tokengraph.
* Maintainers work in plugins/tokengraph.
* Maintainers must run pnpm install, pnpm build, tests, smoke, validation, and packaging.
* Users must not need to build.
* If MCP tools are missing, first check whether Codex installed the release plugin or the source plugin.

plugins/tokengraph/README.md must say:

* This is the development source plugin.
* It is not the normal one-click user install target unless dist/ has already been built.
* Use neutral example paths only.

release/tokengraph/README.md must say:

* This is the installable release plugin.
* It includes compiled MCP runtime.
* It is local-first.
* It stores project state under .tokengraph/ in the indexed workspace.
* It does not require OpenAI API key, cloud sync, embeddings service, or paid external API.

## 5\. Phase B: Remove redundant implemented plan files

Delete implemented plan files from docs/plans after confirming ROADMAP.md summarizes the completed work.

Delete at least:

* docs/plans/2026-07-06-tokengraph-v0.8.md
* docs/plans/2026-07-07-tokengraph-v0.9.md
* docs/plans/2026-07-07-tokengraph-v0.10.md

Do not keep redundant plan files for releases already implemented.

If historical planning is needed later, keep it outside the main repo or use a changelog, but do not leave obsolete implementation plans in docs/plans where Codex may treat them as active work.

## 6\. Phase C: Specialized Codex skills

Current issue: only one broad TokenGraph skill exists.

Add focused skill folders:

* plugins/tokengraph/skills/graph-context-retrieval/SKILL.md
* plugins/tokengraph/skills/root-cause-debugger/SKILL.md
* plugins/tokengraph/skills/architecture-consistency-checker/SKILL.md
* plugins/tokengraph/skills/context-compression/SKILL.md
* plugins/tokengraph/skills/regression-detector/SKILL.md
* plugins/tokengraph/skills/token-budget-optimizer/SKILL.md
* plugins/tokengraph/skills/memory-curator/SKILL.md
* plugins/tokengraph/skills/release-packaging-auditor/SKILL.md

The existing broad tokengraph skill can remain as fallback.

Each skill must:

* Be focused.
* Tell Codex when to use it.
* Tell Codex which TokenGraph MCP tools to call.
* Tell Codex when to avoid raw reads.
* Tell Codex to mark hypotheses clearly.
* Tell Codex not to pretend tools were used when MCP tools are unavailable.

Validation must ensure every required skill folder exists and every SKILL.md has frontmatter with name and description.

## 7\. Phase D: Architecture rules

Add local architecture rule storage:

* .tokengraph/rules.json

Add types for architecture rules:

* forbidden imports
* required imports
* dependency direction
* naming convention
* required tests
* security rule
* RLS rule
* tenant isolation rule
* audit logging rule
* release packaging rule

Add MCP tools:

* tokengraph\_list\_rules
* tokengraph\_add\_rule
* tokengraph\_update\_rule
* tokengraph\_delete\_rule
* tokengraph\_check\_architecture

Architecture checking should initially support:

* forbidden import violations
* dependency direction warnings
* missing test warnings for selected modules
* security-sensitive SQL warnings for RLS, grants, auth, audit, tenant isolation
* marketplace target sanity check: normal marketplace must not point to source folder unless explicitly marked development-only

## 8\. Phase E: Root cause debugger

Add MCP tool:

* tokengraph\_trace\_failure

Input:

* root
* kind: test | build | runtime | install | log
* text
* task optional
* profile optional

Output:

* compressedOutput
* detectedPaths
* detectedSymbols
* detectedTests
* relatedFiles
* relatedImports
* relatedSql
* relatedMemories
* hypotheses
* recommendedFirstReads
* recommendedCommands
* confidence
* tokenEstimate

Rules:

* Compress output first.
* Preserve exact failing test names.
* Preserve exact error messages.
* Preserve stack trace file paths and line numbers.
* Use graph traversal, not only lexical matching.
* Hypotheses must be labeled as hypotheses unless proven.
* Include confidence and evidence.
* Recommend targeted first reads, not broad raw reads.

## 9\. Phase F: Regression detector

Add MCP tool:

* tokengraph\_assess\_change\_risk

Input:

* root
* changedFiles
* diffSummary optional
* task optional
* profile optional

Output:

* riskScore
* riskLevel
* affectedFiles
* affectedRoutes
* affectedTests
* affectedSql
* affectedRules
* affectedMemories
* recommendedTests
* manualReviewWarnings
* tokenEstimate

Risk scoring should consider:

* inbound import count
* outbound dependency breadth
* route exposure
* tests linked to changed files
* SQL policy involvement
* auth involvement
* tenant isolation involvement
* audit logging involvement
* migration involvement
* architecture rule violations
* known bug memories
* fragile module memories

## 10\. Phase G: Memory lifecycle and real memory

Current memory is useful but too simple. Add lifecycle metadata.

Extend MemoryEntry with:

* status: active | deprecated | deleted
* updatedAt
* lastUsedAt
* confirmedAt
* linkedFiles
* linkedSymbols
* linkedSqlObjects
* linkedRules
* confidence
* supersedes
* supersededBy
* source
* evidence

Add MCP tools:

* tokengraph\_update\_memory
* tokengraph\_delete\_memory
* tokengraph\_deprecate\_memory
* tokengraph\_confirm\_memory
* tokengraph\_find\_memory\_conflicts
* tokengraph\_link\_memory
* tokengraph\_recall\_memory

Rules:

* Delete should be soft delete by default.
* Deprecated memories should be excluded from normal planning.
* Deleted memories should not appear except in explicit audit mode.
* Conflicts should be surfaced, not automatically resolved.
* Memories should be linked to files, symbols, SQL objects, rules, tasks, and release decisions where possible.
* Important durable memories should require user approval or explicit instruction.
* Memory recall should prefer active, confirmed, recent, and linked memories.
* Memory must improve quality, not inject stale assumptions.

Borrow from mem0-style memory principles:

* Extract salient facts from work sessions.
* Consolidate repeated or related memories.
* Retrieve only relevant memories.
* Expire or deprecate stale memories.
* Support graph links between memories and project entities.

Borrow from Obsidian-style vault principles:

* Keep memory and wiki inspectable as local files.
* Prefer human-editable Markdown where useful.
* Use backlinks between wiki pages, modules, SQL objects, and decisions.
* Make the memory graph visible through compact exports.

## 11\. Phase H: Persistence and scale

Add schema versioning to all persisted local state:

* index.json
* memory.json
* config.json
* wiki manifest
* rules.json
* token events
* benchmark runs

Add safe migration behavior:

* migrate compatible old state
* quarantine corrupt state
* never silently destroy user memory
* allow reset index while preserving memory and config

Add optional SQLite backend later.

Keep JSON default until SQLite is proven necessary.

Add storage abstraction:

* JsonTokenGraphStore
* optional SqliteTokenGraphStore

Do not change MCP tool contracts when switching storage backend.

## 12\. Phase I: Benchmarks and proof

Add docs/benchmarks/:

* docs/benchmarks/methodology.md
* docs/benchmarks/results-current.md
* docs/benchmarks/fixtures.md

Add benchmark harness:

* code graph routing tasks
* SQL graph routing tasks
* memory recall tasks
* wiki orientation tasks
* log compression tasks
* root cause debugging tasks
* regression risk tasks
* architecture check tasks
* release packaging validation tasks

Metrics:

* files read
* raw lines read
* estimated input tokens
* estimated output tokens
* MCP tool calls
* time to useful patch scope
* false positive files
* false negative files
* tests recommended
* tests passed
* estimated tokens avoided
* whether task quality was preserved

Claims policy:

* Do not claim universal 95 percent token reduction.
* Report measured savings by task type.
* Separate savings from code graph, SQL graph, memory, wiki, and compression.
* Include failure cases.

## 13\. Phase J: Trust documentation

Add docs/trust/:

* docs/trust/privacy.md
* docs/trust/security.md
* docs/trust/permissions.md
* docs/trust/local-storage.md
* docs/trust/limitations.md
* docs/trust/release-install.md

Must state:

* TokenGraph is local-first.
* It stores project state under .tokengraph/ in the indexed workspace.
* It does not require an OpenAI API key.
* It does not require cloud sync.
* It does not require embeddings service.
* It respects .gitignore.
* It excludes secrets by default.
* It excludes dependency folders and build output by default.
* Users can delete indexes and memories.
* SQL indexing can be disabled.
* Memory can be disabled.
* Token savings are estimates.
* Memory can become stale.
* SQL parsing is not business understanding.
* TokenGraph does not replace code review.
* TokenGraph does not guarantee correctness.
* TokenGraph is a developer tool, not a clinical, legal, or regulated-domain decision system.

## 14\. Phase K: Multimodal and cross-agent future

Do this after the Codex one-click install path and core intelligence are stable.

Goal: make TokenGraph host-neutral through MCP while keeping Codex as the first target.

Add multimodal-safe MCP outputs:

* resource links for generated maps
* optional image content for graph diagrams only when host supports it
* structured JSON exports for all hosts
* Markdown diagram fallbacks
* no mandatory UI framework

Future host adapters:

* Codex app plugin package
* Claude Code MCP configuration guide
* generic MCP stdio configuration guide
* Cursor/Windsurf/other MCP host notes if stable and documented

Do not fork core logic per host. Keep one MCP server and host-specific packaging/docs.

## 15\. Quality-first compression strategy

TokenGraph must include token compression, but compression must preserve quality.

Existing tokengraph\_compress\_output should be kept and expanded.

Add or improve:

* prompt/context compression
* task intent compression
* memory deduplication
* wiki section references instead of repeated background
* diff compression
* SQL summary compression
* log compression
* test failure compression

Compression rules:

* Preserve exact error messages.
* Preserve exact test names.
* Preserve stack trace paths and line numbers.
* Preserve security warnings.
* Preserve migration identifiers.
* Preserve affected file paths.
* Preserve public API names.
* Preserve user constraints.
* Report omitted line count and estimated tokens avoided.
* Return a raw-read recommendation when confidence is low.
* Never hide information needed to safely implement or review a change.

Add MCP tool if needed:

* tokengraph\_compress\_context

Input:

* root
* task
* contentKind: prompt | memory | diff | sql | wiki | mixed
* text optional
* profile optional
* preserveRawReferences boolean optional

Output:

* compressedTask
* preservedConstraints
* referencedMemories
* referencedWikiPages
* recommendedFirstReads
* omissions
* confidence
* estimatedTokens

## 16\. Suggested version roadmap

v0.10.2 or v0.11: One-click release architecture and docs cleanup

* committed release/tokengraph
* root marketplace points to release plugin
* package script can update release folder
* validation for release target
* remove personal paths
* delete implemented docs/plans files

v0.12: Specialized skills and architecture rules

* focused skills
* architecture rule store
* architecture check MCP tool

v0.13: Root cause debugger and regression detector

* tokengraph\_trace\_failure
* tokengraph\_assess\_change\_risk
* graph traversal and risk scoring

v0.14: Memory lifecycle

* active/deprecated/deleted states
* update/delete/deprecate/confirm/conflict tools
* memory links to graph entities

v0.15: Persistence and scale

* schema versioning across all state
* safe migrations
* corrupt-state quarantine
* optional SQLite abstraction

v0.16: Benchmarks and trust docs

* repeatable benchmark harness
* public methodology and results
* privacy/security/limitations documentation

v0.17: Multimodal and cross-agent compatibility

* MCP resource links and diagram outputs
* host-neutral MCP docs
* Claude Code configuration guide
* generic MCP install guide

v1.0: Public release

* true one-click Codex install
* stable release package
* all core MCP tools documented
* honest benchmarks
* trust docs
* install tests on Windows, macOS, and Linux

## 17\. First acceptance checklist

The first pass is complete only when:

* .agents/plugins/marketplace.json points to an installable release plugin folder.
* release/tokengraph/dist/index.js exists in the repo.
* release/tokengraph/dist/server.js exists in the repo.
* A normal user can add the repo marketplace to Codex and get TokenGraph MCP tools without running pnpm build.
* plugins/tokengraph remains the source development plugin.
* README does not contain personal usernames.
* plugins/tokengraph/README.md does not contain personal usernames.
* docs/plans no longer contains implemented v0.8, v0.9, or v0.10 plans.
* ROADMAP.md reflects the current true next stage.
* Validator fails if the marketplace points to a missing or unbuilt plugin target.
* Smoke tests pass.
* Full tests pass.

## 18\. Final instruction to Codex

Start with Phase A only. Do not jump to root cause debugging, memory lifecycle, SQLite, benchmarks, or multimodal features until the one-click release install path is fixed, documented, validated, and tested.

After Phase A and Phase B pass, create a new active plan for the next phase only. Do not keep obsolete implementation plans after they are completed.

