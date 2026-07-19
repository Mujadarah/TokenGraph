# TokenGraph Roadmap v4 Design

Status: frozen implementation specification
Baseline: v0.20.0 at 9e67d56

## Authority and delivery

This document is the self-contained design for the v4 implementation. The v4
roadmap is normative. Earlier roadmap material is used only for mechanics that
v4 explicitly inherits. The implementation is delivered as dependent phase
branches, with one PR per phase or sub-phase, conventional commits, ASCII-only
tracked text, and a regenerated release/tokengraph after every source change.

No intermediate release is published. The package remains 0.20.0 during the
implementation and is released as 0.21.0 only after B6 gates pass, B5 has a
recorded result, and B7 is complete.

## Track A stabilization

Phase A1 adds .gitattributes with LF normalization, pins Node >=22 and
pnpm@10.14.0, backfills changelog entries, and restores ascending roadmap
ordering. After the A1 PR merges, the stale GitHub branch is deleted and main
is protected with required PRs and the verify check.

Phase A2 builds tagged release assets in CI from the tag with Node 22 and pnpm
10.14.0, writes a ZIP checksum, and uploads a draft release. The existing
v0.20.0 release keeps its immutable asset and receives a note explaining that
the asset predates LF normalization.

Phase A3 fixes quote-aware CREATE TABLE scanning, validates persisted
architecture-rule patterns before matching, uses cross-process locks for all
shared stores, expires proposals during listing, and centralizes the wiki slug
validator.

Phase A4 preserves negative event savings, reports execution-inclusive savings
first, labels the baseline as recommended raw reads, and makes benchmark output
reproducible from a checked-in result artifact.

Phase A5 makes compact mode envelopes carry their mode, documents hook data
location in the trust docs, comments the registerTool patch scope, and reports
unsupported-language exclusions. Correction (2026-07-16 audit): the dist
permission cross-reference comment, the README language-coverage sentence, and
the security.md process-cwd trust-fallback documentation were not delivered in
this phase; they are tracked as audit tasks R2.2-R2.4.

## Contracts C1-C7

### C1: identity and scope

Every durable record carries repositoryId, repositoryFingerprint, workspaceId,
worktreeId, branch, and headCommit; remoteIdentity is advisory. repositoryId
is persisted and is never derived solely from a remote URL. Repository-scoped
data is stored below the git common directory in `tokengraph/`; task ledgers,
delivery state, runs, and caches remain in each worktree's `.tokengraph/`.
Non-git workspaces use `.tokengraph/repository/` for both scopes.

Reviewed decisions are repository-scoped unless explicitly branch-specific.
Preferences are repository-scoped unless the caller opts into global scope.
Task outcomes are worktree, branch, and commit scoped. File-linked records are
stale when their file fingerprint changes, and branch-specific conclusions are
never silently applied to another branch.

### C2: canonical artifacts

Stable artifacts use lexicographically ordered object keys, documented semantic
array ordering, workspace-relative forward-slash paths, LF text, and an
explicit omitted-versus-null policy. Undefined values, timestamps, random
ids, absolute paths, host ids, and latency are excluded.

Artifact hashes cover artifactSchemaVersion, repository and source
fingerprints, parser version, normalized intent, retrieval configuration,
memory/decision fingerprints, and content. SHA-256 is calculated over the
canonical bytes. Any semantic change increments artifactSchemaVersion.

### C3: storage and untrusted prose

Initialization appends `.tokengraph/` to `.git/info/exclude`; tracked .gitignore
files are never edited silently. New state uses 0700 directories and 0600 files
where supported, rejects symlink-following writes, applies per-class quotas,
retains raw runs for a finite period, and exposes purge of runs, caches,
archives, or all derived state. Reviewed decisions and preferences are never
implicitly purged. Redaction is best effort and documented honestly.

Instruction-like repository prose is omitted from capsules, briefs, recalled
memories, and vault pages by default. Explicit verbatim requests place text
only in `untrustedSourceText`. User constraints, reviewed decisions, derived
facts, and untrusted text remain separate classes.

### C4: bounded parsing

AST indexing uses configurable file-size, total-byte, symbol, node, per-file
timeout, whole-index timeout, recursion-depth, graph-depth, generated-file,
tsconfig-chain, and alias limits. Parsing runs in a bounded worker. A limit
excludes or degrades only the affected file, preserving a reason and heuristic
evidence class; one pathological file never fails the full index.

### C5: durable schemas

Every durable store carries schemaVersion, generatorVersion, parserVersion when
relevant, createdAt, updatedAt, and repositoryId. Corrupt state is quarantined
with a reason. Derived indexes, capsules, caches, and vault projections are
rebuildable. Destructive durable migrations back up first. Older binaries refuse
writes to newer schemas and never downgrade or delete state.

### C6: delta delivery

Task-aware calls accept `knownArtifacts?: string[]`. An artifact is referenced
instead of returned only when the exact id@hash is confirmed by the caller.
Without confirmation, required evidence is resent. `tokengraph_query_context`
adds artifact-by-hash retrieval without adding a public tool. Skills teach
agents to echo knownArtifacts. Benchmarks report no-handshake savings by
default and handshake savings separately.

### C7: router rollout

Routing begins in shadow mode with `enforced: false`, recording decision, stage,
reason, expectedOverheadTokens, and measured outcome. Promotion requires the
router gates. A global routing mode/kill switch supports shadow, enforced,
always-activate, and always-advisory behavior. Every task supports
`routingOverride: auto | force-on | force-bypass`. TokenGraph failures and
timeouts fail open to direct host operation while workspace trust remains fail
closed.

## Track B architecture

### B1 routing and artifacts

Stage 0 uses only task text, explicit paths, prompt shape, category guess, and
cached status. Stage 1 reads the existing index without refreshing it. Obvious
bounded tasks bypass before ledger creation; discovery tasks activate. Responses
use a stable content-hashed artifact plus a volatile task envelope and report
category-level economics.

### B2 context engine

The bundled pinned TypeScript parser is the default; project TypeScript is an
explicit opt-in and tsconfig is parsed as data. Regex fallback is labeled
heuristic. Source-free SymbolChunks contain locations, signatures, summaries,
edges, provenance, hashes, and parser version. Deterministic file/symbol
capsules are 20-80 tokens. Exact slices are read on demand with hash validation
and bounded disposable caching. One pure-TS BM25 scorer ranks all retrieval.
L0-L4 escalation, evidenceSufficiency, readNext, and the one-read/three-read
policy are mandatory.

### B4 runner

`tokengraph run -- <command> [args...]` executes with argv-safe spawning,
timeouts, cancellation, signal forwarding, output caps, ANSI removal,
stdout/stderr separation, exit codes, binary/interactive detection, and
redaction before writes. Raw redacted captures are worktree-scoped and finite.
The model sees only first-error, repeat counts, tests, stack frames, locations,
exit code, and run id. Saved runs are queried by test, file, or error class.

### B3 memory

Five layers are indexed facts, capsules, reviewed decisions, task outcomes, and
preferences. Project briefs are created after activation with a 150-300 token
adaptive budget and a 600-token maximum, and are empty when nothing material
exists. Runner/hooks/filesystem observations become verified outcomes;
agent-only claims become review proposals. Preferences are repository-scoped
by default. The vault is a deterministic Obsidian-compatible projection, never
the authority. Stale, superseded, and archived records are labeled and never
presented as current truth.

### B6, B5, and B7

B6 records a complete run manifest, counterbalances ON/OFF trials, retains
failures and timeouts, compares paired tasks, bootstraps confidence intervals,
and tests quality non-inferiority separately from token superiority. B5 keeps
JSON as default unless a format experiment wins both token and quality gates.
B7 is unlocked only after B6 and uses self-contained WASM Tree-sitter parsers
for Python, Go, Rust, and Java with no workspace code execution.

## Public interfaces

The default MCP surface remains exactly eight tools and the compatibility
surface remains 42. Task-aware schemas gain `knownArtifacts` and
`routingOverride`. Query context gains artifact and saved-run modes. Core types
include RoutingDecision, RepositoryIdentity, StableArtifact, ArtifactEnvelope,
EvidenceStatement, parser/resource limits, storage quotas, and paired-run
manifests. Configuration migration preserves all existing flat values while
adding nested routing, parser, storage, runner, memory, and response-format
settings. `TOKENGRAPH_ROUTING_MODE` overrides stored routing mode.

## Quality gates

Every phase runs typecheck, tests, build, smoke, plugin validation, normal and
release packaging, ASCII scanning, and a clean generated-release diff. The
final release requires router false-bypass and false-activation rates below
10%, execution-inclusive median > 0, p25 >= 0, at least 80% non-negative
activated tasks, full critical-constraint preservation, required-file recall,
resource bounds, and no network access.
