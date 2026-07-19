# TokenGraph Roadmap v4 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Keep each phase on a dependent `codex/` branch and use the full verification gate before every commit that changes source.

**Goal:** Deliver the frozen TokenGraph v4 architecture and one verified v0.21.0 release without sacrificing determinism, trust boundaries, or honest economics.

**Architecture:** Preserve the eight-tool core and 42-tool compatibility surface. Add routing, canonical artifacts, scoped durable stores, bounded indexing, retrieval, runner capture, memory, and evaluation as layered modules over existing task ledgers, persistence, and compact response contracts.

**Tech Stack:** TypeScript 5.9.3, Node >=22, pnpm 10.14.0, Vitest, esbuild, MCP SDK, JSON durable stores, pure-TS BM25, and web-tree-sitter WASM for B7.

## Global constraints

- All tracked text is ASCII and LF-normalized.
- SQLite and model-based compression remain deferred.
- No network, telemetry, API keys, raw prompts, transcripts, or unredacted captures enter the package.
- The default surface stays eight MCP tools; the full surface stays 42 tools.
- Keep package version 0.20.0 through development; the final release branch is now
  preparing 0.21.0.
- Regenerate `release/tokengraph` after every source change.

## Phase branches and tasks

### Task 0: Freeze implementation documents

**Branch:** `codex/tokengraph-v4-a1-hygiene`

**Files:**
- Create: `docs/superpowers/specs/2026-07-15-tokengraph-roadmap-v4-design.md`
- Create: `docs/superpowers/plans/2026-07-15-tokengraph-roadmap-v4.md`

- [x] Add the self-contained design and this checklist.
- [x] Run the ASCII scan over both files.
- [x] Commit `docs: freeze TokenGraph roadmap v4 specification`.
- [x] Commit `docs: add TokenGraph roadmap v4 implementation plan`.

### Task 1: Track A1 repository hygiene

**Files:**
- Create: `.gitattributes`
- Modify: `plugins/tokengraph/package.json`, `CHANGELOG.md`, `ROADMAP.md`

- [x] Add `* text=auto eol=lf`, run `git add --renormalize .`, and verify no tracked CRLF remains outside release dist.
- [x] Add `engines.node = ">=22"` and `packageManager = "pnpm@10.14.0"` without adding maintainer-only fields to the release whitelist.
- [x] Add condensed 0.17.0, 0.18.0, and 0.19.0 changelog entries and the pre-tag history note.
- [x] Move v0.19 above v0.20 in `ROADMAP.md`.
- [x] Run the complete project gate and commit `chore: harden repository release inputs`.
- [x] After merge, delete remote `copilot/delete-v0170-release` and protect `main` with required `verify` status and pull requests.

### Task 2: Track A2 reproducible releases

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: v0.20.0 GitHub release notes through the GitHub API

- [x] Add a `v*` tag workflow with Node 22, pnpm 10.14.0, frozen install, all verification steps, release packaging, SHA-256, and draft release upload.
- [x] Keep the existing v0.20.0 ZIP and append the LF-normalization provenance note.
- [x] Add a workflow syntax/metadata test and validate the final workflow in CI.
- [x] Commit `ci: build release assets from tags`.

### Task 3: Track A3 core correctness

**Files:**
- Modify: `plugins/tokengraph/src/core/sqlParser.ts`, `architectureRules.ts`, `memoryStore.ts`, `persistence.ts`, `config.ts`, `knowledgeReviewQueue.ts`, `storage.ts`
- Test: existing focused test files plus new regression cases

- [x] Write and run failing tests for quoted `)` defaults, persisted catastrophic patterns, concurrent memory/rule/index/config writes, list-path expiry, and shared slug validation.
- [x] Implement quote-aware matching, bounded rule validation, `withFileLock` coverage, lazy expiry, and one exported slug constant.
- [x] Run focused tests, then the complete gate, and commit `fix: harden shared persistence correctness`.

### Task 4: Track A4 economics

**Files:**
- Modify: `plugins/tokengraph/src/core/taskEstimator.ts`, `types.ts`, `planner.ts`, `regressionRisk.ts`, `contextCompressor.ts`, benchmark scripts/tests/docs

- [x] Add failing tests proving negative event totals survive and execution-inclusive values lead the footer.
- [ ] Replace the ambiguous baseline label with explicit recommended-raw-read and full-index-dump metrics; retain both only where needed for diagnostics. Correction (2026-07-16 audit): only the benchmark harness gained a diagnostic full-index-dump field; the live tool response fields in `planner.ts`, `regressionRisk.ts`, and `contextCompressor.ts` were never relabeled and still report unlabeled full-index-dump savings. Tracked as audit task R2.1.
- [x] Generate checked-in benchmark results and make CI fail when the generated docs drift.
- [x] Commit `fix: report execution-inclusive token economics` after the full gate.

### Task 5: Track A5 surface polish

**Files:**
- Modify: `compactResponses.ts`, `hooks.ts`, `server.ts`, `build.mjs`, `fileScanner.ts`, `projectIndexer.ts`, `README.md`, trust docs
- Test: compact response, scanner, and MCP smoke tests

- [x] Add failing mode-envelope and unsupported-language-count tests.
- [x] Implement the compact mode field and exclusion summary; add hook-data-location trust/privacy documentation.
- [ ] Correction (2026-07-16 audit): the `hooks.ts` dataRoot inline comment, the `build.mjs` cross-reference comment, the README language-coverage sentence, and the `security.md` trust-source precedence documentation (including the process-cwd fallback) were not delivered. Tracked as audit tasks R2.2-R2.4.
- [x] Commit `docs: clarify runtime surfaces and indexing limits` after the full gate.

### Task 6: B1 routing and canonical artifacts

**Files:**
- Create: `routingAdvisor.ts`, `artifact.ts`, `canonical.ts`
- Modify: `toolContracts.ts`, `server.ts`, `config.ts`, task ledger, skills, benchmark harness

- [x] Add failing Stage 0/Stage 1, shadow, force override, kill switch, host fallback, and stable-artifact tests.
- [x] Implement `RoutingDecision`, `StableArtifact`, `ArtifactEnvelope`, canonical LF/path/key ordering, SHA-256 hashing, and execution-inclusive category reporting.
- [x] Add `knownArtifacts` and `routingOverride` to every task-aware schema while preserving tool counts.
- [x] Commit `feat: add shadow routing and stable artifacts` after the full gate.

### Task 7: B2 foundations and storage contracts

**Files:**
- Create: identity, migration, quota, injection, and repository-store modules
- Modify: storage/persistence/config and all durable-store schemas

- [x] Add failing two-worktree, swapped-repository, symlink, permissions, quota, purge, quarantine, and interrupted-migration tests.
- [x] Implement common-git-directory repository storage, worktree-local state, `.git/info/exclude`, schema metadata, backups, read-only newer-schema behavior, and injection omission.
- [x] Commit `feat: add scoped durable context storage` after the full gate.

### Task 8: B2 indexing

**Files:**
- Create: bounded parser worker and `SymbolChunk` modules
- Modify: `fileScanner.ts`, `projectIndexer.ts`, `types.ts`, package dependencies, build/package scripts

- [x] Pin TypeScript 5.9.3 as a bundled production dependency.
- [x] Add failing generics/decorators/template-literal, tsconfig-data, pathological-file, timeout, and degraded-finding tests.
- [x] Implement bounded AST parsing, parserVersion, source-free chunks, exact boundaries, and labeled regex fallback.
- [x] Commit `feat: add bounded symbol indexing` after the full gate.

### Task 9: B2 retrieval and delta delivery

**Files:**
- Create: capsules, BM25, slice extraction, read-policy, and delivery modules
- Modify: `query_context` schema/handler, skills, task ledger, compact responses

- [x] Add failing capsule snapshot, BM25 ranking, exact slice, evidence sufficiency, read-policy, artifact re-fetch, and host-context-loss tests.
- [x] Implement 20-80 token deterministic capsules, L0-L4 escalation, one-read/three-read policy, hash-validated slices, and resend-by-default delta delivery.
- [x] Commit `feat: add hierarchical context retrieval` after the full gate.

### Task 10: B4 CLI runner

**Files:**
- Create: CLI entrypoint and runner/capture modules
- Modify: package bin/build/package scripts, `query_context`, skills/docs, benchmark fixtures

- [x] Add failing argv, timeout, cancellation, signal, ANSI, redaction, stdout/stderr, binary/interactive, retention, and targeted-query tests.
- [x] Implement `tokengraph run -- ...`, redacted bounded captures, compact reports, run manifests, cleanup, purge, and run query mode.
- [x] Commit `feat: add pre-model command output capture` after the full gate.

### Task 11: B3 memory core and vault retention

**Files:**
- Create: preferences, project brief, outcome, vault, compaction, and retention modules
- Modify: memory store, task ledger, knowledge queue, recall/composer, persistence, skills

- [x] Add failing scope, brief-budget, verified/proposed outcome, stale/superseded, vault byte-stability, backlinks, archive, and memory-budget tests.
- [x] Implement five-layer retrieval, adaptive briefs, repository preferences, verified runner observations, review proposals, deterministic Obsidian projection, compaction, and injection-safe composition.
- [x] Commit `feat: add scoped cross-thread memory` after the full gate.

### Task 12: B6 paired evaluation

**Files:**
- Create: paired-run manifest/schema, evaluator, statistics, and fixtures
- Modify: benchmark scripts, docs, router promotion configuration

- [x] Add failing manifest, counterbalance, retained-failure, paired-bootstrap, minimum-category, quality-margin, and token-superiority tests.
- [x] Implement host-trace import and manifest-driven evaluation without network access; report router shadow decisions and promotion readiness.
- [x] Do not enable enforced routing until every Section 7 gate passes.
- [x] Commit `feat: add reproducible paired evaluation` after the full gate.

### Task 13: B5 format experiment

**Files:**
- Create: format experiment harness and result artifact
- Modify: response-format config, compact serializers, benchmark/docs

- [x] Add failing token-and-quality comparison tests for JSON and compact tabular output.
- [x] Keep JSON default unless both gates improve; record a negative experiment without changing the default when it does not.
- [x] Commit `test: evaluate response format economics` after the full gate.

### Task 14: B7 polyglot

**Files:**
- Create: WASM parser loader, language adapters, grammar manifest, and language fixtures
- Modify: package/build/validator scripts and index contracts

- [x] Pin and package `web-tree-sitter@0.26.11` and official Python v0.25.0, Go v0.25.0, Rust v0.24.2, and Java v0.23.5 grammars.
- [x] Add failing per-language golden, malformed-input, resource-limit, and no-workspace-execution tests.
- [x] Implement language adapters behind the existing evidence/capsule contracts and assert all WASM assets are present in the release.
- [x] Commit `feat: add gated polyglot indexing` only while B6 remains green.

### Task 15: v0.21.0 final release

**Files:**
- Modify all version surfaces, `CHANGELOG.md`, `ROADMAP.md`, benchmark claims, release metadata

- [x] Bump every version surface to 0.21.0 and regenerate normal/release packages.
- [x] Run the complete gate plus direct release smoke and ZIP-aware contents/checksum validation.
- [ ] Create tag `v0.21.0`, verify the CI draft release asset against a local tag rebuild, then publish the release. Not authorized after the frozen execution-inclusive gate failed.
- [ ] Commit `release: publish TokenGraph v0.21.0`. The existing published tag remains immutable; remediation is tracked in `2026-07-15-tokengraph-audit-remediation.md`.

Historical evidence: the tag workflow and published ZIP checks above describe the
immutable v0.21.0 publication. The first remediation pass kept that tag unchanged: its
fresh fixture run had 320 passing tests but failed the execution-inclusive eligibility gate
with a median of -92.5 tokens, so no corrective tag was created at that point.
Update (2026-07-16): after the user authorized a corrective release and the accounting
fixes landed, v0.21.1 was tagged at the final remediation commit with a passing gate
(+196.5-token activated-task median). Its CI-built draft release still awaits manual
publication; until then the latest published release remains v0.21.0.

## Required verification command set

Run from `plugins/tokengraph` for every source-changing phase:

```text
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin -- --json
pnpm package:plugin -- --release --json
```

Then verify the ASCII scan, `git diff --exit-code -- release/tokengraph`, direct release smoke, and ZIP contents. Do not claim a phase complete without fresh output from every command.
