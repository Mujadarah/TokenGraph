# TokenGraph v4 Audit Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair every P0/P1 audit finding end-to-end without changing or republishing v0.21.0.

**Architecture:** Route before any TokenGraph lifecycle state, persist repository-scoped records under the common git directory, and keep worktree ledgers/runs/caches isolated. Stable artifacts, bounded parsing, runner diagnostics, memory composition, and B6 promotion state are wired into the live server paths rather than remaining test-only helpers.

**Tech Stack:** TypeScript, Node.js 22+, pnpm 10.14.0, Vitest, web-tree-sitter 0.26.11, pinned WASM grammars, JSON durable stores with atomic writes and file locks.

## Global Constraints

- Keep package version `0.21.0`; leave the published tag and release immutable.
- Preserve exactly eight default MCP tools and the 42-tool compatibility surface.
- Do not publish a corrective release or create a new tag.
- Keep router enforcement disabled until every B6 gate passes.
- SQLite and model-based compression remain deferred.
- Regenerate `release/tokengraph` after every source change.

## Task 1: Routing and contracts

Modify `plugins/tokengraph/src/server.ts`, `src/core/routingAdvisor.ts`, `src/core/toolContracts.ts`, `src/core/types.ts`, and compact response helpers.

- Add failing integration tests proving bounded Stage 0 bypass happens before index refresh, memory lookup, planning, or ledger creation; discovery tasks activate; Stage 1 never refreshes an index; overrides and kill switch work; failures fail open; and category economics are reported.
- Return direct-host fallback envelopes for automatic bypass and `force-bypass`; honor `force-on`, stored mode, `TOKENGRAPH_ROUTING_MODE`, and persisted B6 promotion state.
- Wire `knownArtifacts` into exact `id@hash` suppression and add `EvidenceStatement`, `ArtifactEnvelope.deliveredArtifacts`, parser/resource-limit, saved-run-summary, and evaluation-manifest types.

## Task 2: Identity, storage, migrations, and configuration

Modify `src/core/repositoryIdentity.ts`, `persistence.ts`, `storage.ts`, `storagePolicy.ts`, `config.ts`, and `types.ts`.

- Persist repository identity in `<git-common-dir>/tokengraph/identity.json`; sanitize credential-bearing remotes; use common-directory storage for repository records and worktree-local storage for ledgers, delivery state, runs, and caches.
- Add `.git/info/exclude` initialization, 0700/0600 permissions, symlink-safe writes, quotas, purge, quarantine reasons, migration backups, newer-schema write refusal, and non-git `.tokengraph/repository/` fallback.
- Migrate flat configuration without value loss into nested routing/parser/storage/runner/memory/response-format settings, with the environment routing override taking precedence.
- Add tests for conflicting worktrees, swapped repositories, CRLF/LF hashes, secrets, symlinks, quotas, purge, interrupted migrations, old schemas, and migration value preservation.

## Task 3: Artifacts, retrieval, and query modes

Modify `src/core/artifact.ts`, `retrieval.ts`, `canonical.ts`, `persistence.ts`, and the query-context handler.

- Hash artifacts over schema, repository/source/parser fingerprints, normalized intent, retrieval configuration, memory/decision fingerprints, and canonical content.
- Persist and retrieve repository-scoped stable artifacts; return stable content plus volatile envelopes; resend unless exact `id@hash` is confirmed.
- Require run mode to use `runId` plus exactly one bounded selector and return only compact diagnostics for that exact run.
- Wire capsules, BM25, graph expansion, exact validated slices, L0-L4 escalation, read-policy state, and handshake-safe deltas into production context delivery.
- Add tests for invalidation, mismatch, scope, resend, ranking, exact slices, escalation, and exact run selection.

## Task 4: Bounded indexing and polyglot parsing

Modify `src/core/fileScanner.ts`, `projectIndexer.ts`, `symbolChunks.ts`, `polyglot.ts`, `configData.ts`, worker/build files, and grammar assets.

- Add Python, Go, Rust, and Java discovery and parse them with bundled `web-tree-sitter@0.26.11` and the pinned grammars without workspace execution.
- Use the bundled TypeScript parser by default; parse configuration in a bounded worker; degrade only affected files with evidence reasons.
- Extend source-free symbol chunks with locations, signatures, summaries, edges, provenance, hashes, and parser version; label regex fallback heuristic.
- Add per-language, malformed, CRLF/LF, pathological, cyclic, timeout, resource, degraded-file, asset-loading, and zero-execution tests.

## Task 5: Runner and saved-run lifecycle

Modify `src/core/runner.ts`, CLI handling, persistence, and runner contracts.

- Stream stdout/stderr into hard byte caps, strip ANSI, redact before writes, detect binary/interactive commands, forward cancellation/signals, and escalate timeout termination.
- Persist finite redacted captures; expose compact first-error/repeat/test/stack/location/exit/run-id diagnostics; query by exact run ID plus one selector; implement retention and purge.
- Add tests for exits, streams, ANSI, binary/interactive refusal, redaction, cancellation, ignored SIGTERM, retention, purge, exact queries, and noisy-log compression.

## Task 6: Memory and vault lifecycle

Modify `memoryCore.ts`, `memoryStore.ts`, `vaultProjection.ts`, `server.ts`, persistence, and hooks.

- Wire five-layer retrieval and adaptive 150-300 token project briefs (600 maximum) into activated context preparation.
- Scope preferences, distinguish verified outcomes from proposals, mark stale/superseded/archived records, and exclude non-current records.
- Persist deterministic Obsidian projections with backlinks, supersession, archives, compaction, byte budgets, and injection-safe composition.
- Add lifecycle tests for scoping, budgets, verification, staleness, supersession, archives, deterministic bytes, backlinks, compaction, and caps.

## Task 7: B6 evaluation and release eligibility

Modify `src/core/pairedEval.ts`, benchmark harnesses, promotion persistence, tests, changelog, roadmap, and checklist.

- Load a checked-in manifest and host-produced traces, counterbalance ON/OFF trials, retain failures/timeouts, and compute paired bootstrap intervals per task/category.
- Require minimum samples, quality non-inferiority, token superiority, resource compliance, router error rates below 10%, execution-inclusive median > 0, p25 >= 0, and at least 80% non-negative activated tasks.
- Persist promotion only when every gate passes; keep enforcement disabled otherwise. Keep JSON default unless B5 wins both token and quality gates.
- Mark the v0.21.0 gate failure honestly in local documentation without changing benchmark evidence or publishing.

## Verification

Run from `plugins/tokengraph` after every task and before handoff:

```text
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm smoke -- --root . --surface full --json
pnpm validate:plugin
pnpm package:plugin -- --json
pnpm package:plugin -- --release --json
```

Also verify ASCII/LF tracked text, clean generated-release diff, source/release/installed-runtime parity, B6 enforcement suppression on failed reports, and no tag/release/publication changes.
