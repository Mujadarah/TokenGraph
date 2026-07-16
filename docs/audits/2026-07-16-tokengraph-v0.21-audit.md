# TokenGraph Implementation Audit - v0.21.x against the Frozen Plans

- Repo: https://github.com/Mujadarah/TokenGraph
- Audited: 2026-07-16, main @ 194e93a (= tag v0.21.1)
- Baseline: 9e67d56 (v0.20.0, the freeze point)
- Specs audited against: tokengraph-fix-spec.md (Track A) and
  tokengraph-roadmap-v4-final.md (Track B, contracts C1-C7, gates section 7)
- Method: full git-history review; three parallel deep audits (Track A
  compliance; Track B/contract compliance; release and benchmark evidence)
  with every acceptance criterion checked in code, tests, workflows, and
  live GitHub state - never trusted from commit messages or docs claims;
  plus direct probes: release-asset download and byte-comparison, live
  MCP protocol probes of the released server, GitHub API checks of branch
  protection and release workflow runs.

## Executive verdict

In roughly 48 hours, PRs #9-#29 delivered a genuinely large fraction of
the frozen plan, with real tests behind most contracts - this is an
unusually faithful execution for the amount of surface involved. The two
headline outcomes are real: releases are now CI-built from tags and
byte-reproducible (verified: the v0.21.0 asset SHA matches its checksum
AND byte-matches the committed release at the tag - the v0.20.0 failure
mode is fixed), and the benchmark's execution-inclusive gate flipped from
median -133.8 (v0.20.0) through an honestly-disclosed failing -86.0
(v0.21.0) to a passing +196.5 / p25 +102.5 / 82.1% non-negative
(v0.21.1), traceable to real harness changes, not asserted numbers.

But "implemented as specified" is not yet true. The audit found three
process-integrity violations (a release published despite failing its own
frozen gate; a silent retroactive rewrite of that release's CHANGELOG
numbers; internal plan docs marking two never-implemented tasks as done),
and the items that were skipped are disproportionately the plan's
safety-and-honesty guards: evidence classes are declared but never
attached to any capsule statement, task outcomes are not branch-scoped at
recall, no skill teaches the knownArtifacts handshake (so delta delivery
can never engage in practice), and the live tool responses still expose
the same unlabeled inflated "tokens avoided" figures the fix spec was
written to eliminate (Task 4.1 - marked done in the repo's internal plan,
actually untouched). The passing gate itself rests on synthetic fixture
evidence with the downstream-read charge structurally disabled on the
real corpus, and no real host paired evaluation (B6) has ever run. The
code correctly refuses to promote the router or enable polyglot without
that evidence - the runtime gating is honest even where the release
process was not.

Bottom line: implementation ~80-85% complete by item count and high
quality where it exists (grade B), process fidelity C-, evidence for the
value claim: not yet sufficient for enforcement - by the project's own
(correct) runtime admission.

## Scoreboard

| Area | Status |
|------|--------|
| Track A Phases 1-3 (hygiene, CI releases, correctness/locks) | IMPLEMENTED - every item verified, several better than spec |
| Track A Phase 4 (economics honesty) + A-1/A-2 | PARTIAL - benchmark/docs side done; live tool responses (Task 4.1) untouched |
| Track A Phase 5 (polish) | PARTIAL - 5.1 done; 5.2/5.4/5.5 half-done; 5.6 missing |
| C1 identity/scoping | PARTIAL - identities real incl. common-dir anchoring and swapped-repo detection; outcomes not branch-filtered at recall; no real worktree test |
| C2 canonical hashing | PARTIAL - serializer, include/exclude, CRLF-vs-LF test real; omitted-vs-null undocumented |
| C3 storage security | PARTIAL - exclude/perms/symlink/quotas/purge/injection-omission real and hostile-fixture tested; trust docs overclaim redaction; no encryption-readiness note |
| C4 parser limits | IMPLEMENTED - bounded worker, all caps, degraded findings, timing-asserted tests |
| C5 migrations | IMPLEMENTED - versioning, quarantine, backup, newer-version refusal |
| C6 delta delivery | PARTIAL - handshake + resend-by-default + re-fetch mode correct in code; zero skills teach it (structurally inert) |
| C7 router rollout | IMPLEMENTED - shadow default, kill switch, force flags, fail-open, tamper-resistant promotion |
| B1 economics/bypass | PARTIAL - two-stage router + artifact/envelope split real; category footer reporting never surfaced |
| B2 context engine | PARTIAL - bundled TS worker (9.5MB, real compiler API, no workspace execution), SymbolChunks without source bodies, read-policy state machine, canonical BM25 all real; evidenceClass never populated; no recency/task-type weighting |
| B4 CLI runner | IMPLEMENTED - argv-safe, redact-before-write, caps, retention, planted-secret test |
| B3 memory/vault | PARTIAL - layers, scoped preferences, adaptive brief, deterministic vault real; runner-to-verified-outcome pipeline disconnected |
| B5 format experiment | IMPLEMENTED - honestly recorded NEGATIVE result; not shipped as default |
| B6 paired evaluation | PLUMBING IMPLEMENTED - manifests, counterbalancing, CIs, per-category n, promotion clearing; NO real host evaluation exists; checked-in pass is synthetic fixture evidence |
| B7 polyglot | DEVIATED - runtime-gated correctly (dark until validated promotion) but coded and shipped before B6 had any real evidence; WASM grammars (no native deps - good) |
| Tool surface | 8 core / 42 full - unchanged; all new capability added as modes/fields (verified by live probe) |

## The numbers story (verified)

| Release | Execution-inclusive median | Gate | Notes |
|---------|---------------------------|------|-------|
| v0.20.0 | -133.8 | FAIL (pre-gate era) | baseline at freeze |
| v0.21.0 | -86.0 (later silently restated as -94.3) | FAIL - disclosed in its own CHANGELOG, released anyway | non-conforming release |
| v0.21.1 | +196.5, p25 +102.5, 82.1% non-negative | PASS (7.2 thresholds) | synthetic fixture evidence; real B6 pending |

Caveats that keep this from being a proven value claim yet:
1. The evidence is the checked-in 30-task fixture corpus (28 activated, 2
   bypassed), not a real-host paired run; pairedEval.ts has never consumed
   real traces.
2. The downstream-read charge fires only when a task sets
   requiresExactSlice - and 0 of 30 corpus tasks set it. The
   "execution-inclusive" label is disclosed but measures less execution
   than the v0.21.0-era methodology did. The genuine improvement came from
   real runner captures replacing synthetic debugging/compression
   baselines - that part is legitimate.
3. Section 7.1 router rates (false-bypass/false-activation) are not
   published anywhere; my live probe misrouted an explicit file-and-line
   task to activation (stage 0, reason "context-discovery") while a
   no-paths discovery question bypassed at stage 1 - anecdotal, but
   exactly the metric 7.1 exists to quantify. Shadow mode means no user
   harm today.
4. Bypasses are correctly not booked as savings, and
   primarySavingsMetric: "execution-inclusive" is explicit in the JSON.
   Claims policy is otherwise followed.

## Process-integrity findings

1. [HIGH] Non-conforming release: v0.21.0 was tagged and published
   (2026-07-15) while its own CHANGELOG admitted the frozen
   execution-inclusive gate failed. The roadmap's Definition of Done
   requires gates passing before release. The gate predicates were added
   to the harness only in v0.21.1.
2. [HIGH] History rewrite: the v0.21.1 remediation commit silently
   changed the already-published v0.21.0 CHANGELOG entry's numbers
   (routing 20.0 -> 5.7; execution-inclusive -86.0 -> -94.3) with no
   annotation that history was recomputed. An honesty-first project must
   not edit published claims silently.
3. [HIGH] False completeness claims in internal docs:
   docs/superpowers/plans/2026-07-15-tokengraph-roadmap-v4.md marks Task
   4.1 (baseline relabeling in planner/regressionRisk/contextCompressor)
   done - git history proves those files untouched since before v0.20.0;
   the design spec claims the process-cwd fallback was documented (Task
   5.6) - docs/trust/security.md is unchanged since pre-v0.17. The same
   plan doc still says "no corrective tag or publication is created"
   even though v0.21.1 was tagged.
4. [MED] v0.21.1 is tagged but its CI-built release is stuck as an
   UNPUBLISHED DRAFT (github-actions author). The latest published
   release remains v0.21.0 - the failing-gate build, whose ZIP also
   predates the bundled TypeScript worker. Marketplace-from-git users get
   v0.21.1; ZIP users get v0.21.0.
5. [LOW] The v0.21.0 release body contains literal escaped \n sequences
   (workflow templating bug); the checksum asset embeds the CI runner's
   absolute path (breaks sha256sum -c and violates the no-machine-paths
   rule); no TZ=UTC pin backs the zip-timestamp determinism fix; 10 stale
   merged codex/* branches accumulated (the named branch from Task 1.5
   was properly deleted).

## What was verified working (highlights)

- Reproducibility: v0.21.0 asset byte-matches the committed release at
  its tag; SHA matches the published checksum; release workflow's three
  real bugs were fixed before tagging; CI and release badges green.
- Branch protection is ON (verified via API: required check "verify");
  all 21 post-freeze first-parent commits are genuine PR merges.
- Live server probe (released dist): 8 core tools unchanged; setup
  returns the full C1 repositoryIdentity block with sane non-git
  fallbacks; prepare_context accepts knownArtifacts and routingOverride;
  routing block present with enforced: false (shadow default);
  TOKENGRAPH_ROUTING_MODE kill switch exists.
- Core correctness fixes all landed with tests: SQL quote-aware scan,
  stored-rule ReDoS revalidation (placed at the actual attack surface -
  better than spec), cross-process locks on every writeJsonAtomic call
  site, expiry in list path, shared slug constant, negative savings
  unfloored (verified by simulation: likely -35 on a losing event).
- Benchmark figures are regression-locked stricter than spec
  (toBeCloseTo(...,6) against the checked-in artifact).
- The B5 format experiment recorded a negative result and did NOT ship -
  exactly the honesty the plan demanded.

## Remediation tasks (Codex-ready)

### R1 - Truth and release hygiene (do first, small)
- R1.1 Publish the v0.21.1 draft release (or re-run the workflow) so the
  latest published asset is the passing-gate build with the TS worker.
  Acceptance: releases/latest returns v0.21.1; asset SHA matches its
  checksum file.
- R1.2 Append a dated correction note to the v0.21.0 CHANGELOG entry
  explaining the number restatement (20.0/-86.0 vs 5.7/-94.3) and why;
  never edit published entries silently again (add this rule to
  AGENTS.md). Acceptance: note present; AGENTS.md rule added.
- R1.3 Fix the false claims: update the internal plan/spec docs to mark
  Task 4.1 and Task 5.6 NOT done (or do them - see R2), and correct the
  stale "no corrective tag is created" paragraph. Acceptance: internal
  docs match verifiable repo state.
- R1.4 Update docs/trust/limitations.md (still says negative median and
  old gate name) and release-install.md/limitations.md "v0.20" hook
  scoping. Acceptance: no doc contradicts results-current.json.
- R1.5 Fix release workflow cosmetics: render real newlines in release
  bodies; write the checksum file with a bare filename; export TZ=UTC in
  the packaging steps. Acceptance: next tag's release body clean;
  sha256sum -c works; explicit TZ pin present.
- R1.6 Delete the 10 stale merged codex/* branches. Acceptance: only
  main remains.

### R2 - Close the Track A gaps
- R2.1 (Task 4.1, the real one) Label or re-baseline the live "tokens
  avoided" fields in planner.ts:313-329, regressionRisk.ts:~280,
  contextCompressor.ts:~200 (e.g. avoidedVsFullIndexDump) and update
  consumers/tests. Acceptance: no unlabeled savings field in any live
  tool response schema.
- R2.2 (5.6) Document the full trust-source precedence including the
  process-cwd fallback in docs/trust/security.md and soften README's
  "stays blocked" phrasing. Acceptance: security.md lists all sources in
  order.
- R2.3 (5.2/5.4 code halves) Add the dataRoot() inline comment in
  hooks.ts and the build.mjs cross-reference comment. Acceptance:
  comments present.
- R2.4 (5.5) Add the language-coverage sentence to README.md itself.
  Acceptance: README states TS/JS/SQL/MD indexing coverage (plus WASM
  polyglot status).

### R3 - Wire the disconnected safety features (Track B)
- R3.1 Populate evidenceClass/confidence/source on every capsule and
  brief statement (EvidenceStatement exists in types.ts, unused); editing
  recommendations must carry exact/derived only. Acceptance: hostile and
  golden fixtures assert the fields on every statement.
- R3.2 Add branch/worktreeId to TaskOutcome and filter recall by current
  branch (repository-scoped decisions unaffected); add a real
  git-worktree integration test per C1 acceptance. Acceptance: the C1
  two-worktree fixture passes.
- R3.3 Teach knownArtifacts in the tokengraph and
  graph-context-retrieval SKILL.md files (echo hashes from prior
  responses; explain resend-by-default). Acceptance: skill text present;
  delta savings measured under both assumptions in the benchmark.
- R3.4 Wire runner completions into verified task outcomes (B3.2):
  executeRun results (exit code, command) become observed/verified facts
  on the active task. Acceptance: runner fixture yields verified facts;
  agent-only claims remain proposals.
- R3.5 Surface category-level reporting in the task footer (B1.4) -
  render the per-category basis instead of keeping it internal.
  Acceptance: footer includes category breakdown; benchmark asserts
  schema.
- R3.6 Add recency + task-type weighting to retrieval scoring or narrow
  the documented claim. Acceptance: code matches the documented signal
  set.
- R3.7 Add the redaction best-effort disclaimer + raw-capture location +
  disable-capture guidance to security.md/privacy.md; add the
  encryption-readiness sentence. Acceptance: C3 doc requirements met.

### R4 - Make the evidence real
- R4.1 Publish 7.1 router metrics (false-bypass/false-activation rates,
  stage-0 latency vs activation) from shadow logs into
  results-current.md/json; investigate the misroute pattern my probe hit
  (explicit file+line task activating at stage 0 with reason
  "context-discovery"; reason/decision consistency). Acceptance: rates
  published; probe fixture routes correctly or the heuristic gap is
  documented.
- R4.2 Add requiresExactSlice to the corpus tasks where an edit is the
  natural outcome (or charge recommended firstReads unconditionally
  again) so "execution-inclusive" measures what it says on the real
  corpus. Recompute and republish. Acceptance: the charge fires on a
  nonzero set of real tasks; numbers restated with a changelog note.
- R4.3 Run a real B6 paired host evaluation (ON vs OFF, per the v4
  protocol) on at least one real repository; only then consider router
  promotion and B7 activation. Acceptance: a PairedEvaluationManifest
  with real traces exists; promotion decision recorded either way.
- R4.4 Standardize the expectedBenefit field (numeric today, enum in the
  spec) - pick one, document it, version the artifact schema.
  Acceptance: contract and code agree.

## Bottom line

The plan was executed at remarkable speed and mostly for real - the
infrastructure, contracts, and honesty machinery largely exist and are
tested. What remains undone is concentrated in exactly the places the
plan said mattered most: the guards that keep capsule text trustworthy,
memory branch-safe, delta delivery engaged, live numbers honest, and
releases gated. And the one metric that now passes does so on a fixture
whose hardest charge is switched off. Finish R1-R4 - roughly two short
PR days at the demonstrated pace - and TokenGraph will not just claim
plan conformance; it will survive exactly this audit again.
