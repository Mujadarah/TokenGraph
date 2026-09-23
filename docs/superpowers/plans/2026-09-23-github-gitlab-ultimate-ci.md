# GitHub-Canonical GitLab Ultimate CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Keep GitHub as TokenGraph's sole source of code and release authority while the existing GitLab project pulls the same commits and reports complementary Ultimate security and Linux CI evidence.

**Architecture:** Commit one GitLab pipeline definition to a dependent GitHub branch. Configure the existing GitLab project as a pull-only, non-overwriting mirror; run a bounded branch pipeline; then report its result to the exact GitHub commit through GitLab's project integration. GitLab never authors or pushes source, and its status remains informational.

**Tech Stack:** GitLab CI YAML and stable security templates; Node.js 22, pnpm 10.14.0, Vitest; Git, GitHub and GitLab project settings.

**Spec:** docs/superpowers/specs/2026-09-23-github-gitlab-ultimate-ci-design.md

## Global Constraints

- GitHub Mujadarah/TokenGraph is canonical; GitLab kesharon-group/TokenGraph is pull-only and must not become ahead on a mirrored ref.
- Never enable Overwrite diverged branches, GitLab-to-GitHub push, deployment, tagging, publication, or managed-runtime installation.
- Keep GitHub Actions, CodeRabbit, Greptile, PR #54, and all controlling Phase 12 gates unchanged.
- GitLab-only or divergent refs require a separate disposition; GitLab pull mirroring does not delete upstream-deleted refs automatically.
- No custom job-level secrets, raw prompts, private runtime state, or machine-local paths in CI logs or artifacts. GitLab's built-in CI_JOB_TOKEN exists and must not be exposed.
- The initial pipeline is branch-only and complementary: SAST, dependency scanning, secret detection, and one bounded Linux install/typecheck/build/smoke job; no full test suite or six-target native matrix.
- Use GitLab's stable templates. Set AST_ENABLE_MR_PIPELINES to false because the dependency v2 template otherwise creates an MR pipeline.
- Treat Rust Advanced SAST as beta and verify its separate analyzer job before claiming Rust coverage.
- A GitLab pipeline result applies only to the exact mirrored GitHub SHA; missing, stale, or pending status is not green.
- Do not add GitLab as a required GitHub check without later maintainer approval.
- GitHub status integration needs a separately confirmed status-only credential. Never silently broaden repo:status to repo or admin:repo_hook.
- No merge to main, tag, publication, release-readiness claim, or waiver of TokenGraph's plan is authorized here.
- Use a clean dependent codex/ branch and conventional narrow commits. Preserve other worktrees and generated release/tokengraph.
- Do not run the full local TokenGraph suite as part of this integration; use the focused contract test and the one intended GitLab branch pipeline. Do not claim the repository's full verification gate passed.

## Review Focus

1. An existing GitLab branch is ahead or divergent: Task 3's ref audit must stop without overwrite or deletion.
2. A GitHub branch is deleted after mirroring: Task 3's acceptance check must record GitLab's retained ref as stale, never call the repositories globally equal.
3. Dependency scanning creates a duplicate MR pipeline: Task 1's test pins AST_ENABLE_MR_PIPELINES false, and Task 4's pipeline inspection must show only the intended branch pipeline.
4. A scanner is skipped or does not scan the nested Cargo.lock: Task 1 pins sufficient depth, while Task 4 checks the job reports and the supported input inventory before claiming coverage.
5. GitLab lags GitHub or reports against the wrong SHA: Task 5 verifies the GitHub status SHA and GitLab pipeline SHA match before presenting the result.

## File map

- Create .gitlab-ci.yml at repository root: the only executable GitLab CI definition, sourced through GitHub.
- Create plugins/tokengraph/tests/gitlab-ci-contract.test.ts: focused static contract for branch-only, scanners, runtime job, and prohibited release/full-suite work.
- Create docs/ci/gitlab-ultimate.md: public, credential-free operating runbook and evidence boundaries.
- Keep docs/superpowers/specs/2026-09-23-github-gitlab-ultimate-ci-design.md as the approved design; do not edit release/tokengraph.
- External settings only after local pipeline review: GitLab Settings > Repository > Mirroring repositories; GitLab Settings > Integrations > GitHub.

---

### Task 1: GitHub-tracked complementary pipeline

**Files:**
- Create: plugins/tokengraph/tests/gitlab-ci-contract.test.ts
- Create: .gitlab-ci.yml

**Interfaces:**
- Consumes: plugins/tokengraph/package.json scripts typecheck, build, and smoke; plugins/tokengraph/pnpm-lock.yaml; plugins/tokengraph/native/lock-addon/Cargo.lock.
- Produces: a branch-only GitLab pipeline with the three named security templates and job tokengraph-linux.

- [ ] **Step 1: Write the failing contract test.**

Create plugins/tokengraph/tests/gitlab-ci-contract.test.ts:

~~~ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const path = resolve(process.cwd(), "../..", ".gitlab-ci.yml");
const config = () => readFileSync(path, "utf8");

describe("GitLab complementary CI", () => {
  it("creates branch pipelines without a dependency-scanning MR duplicate", () => {
    const ci = config();
    expect(ci).toContain("if: '$CI_COMMIT_BRANCH'");
    expect(ci).toContain('AST_ENABLE_MR_PIPELINES: "false"');
    expect(ci).toContain("when: never");
  });

  it("uses stable security templates and scans nested lockfiles", () => {
    const ci = config();
    expect(ci).toContain("template: Jobs/SAST.gitlab-ci.yml");
    expect(ci).toContain("template: Jobs/Dependency-Scanning.v2.gitlab-ci.yml");
    expect(ci).toContain("template: Jobs/Secret-Detection.gitlab-ci.yml");
    expect(ci).toContain('GITLAB_ADVANCED_SAST_ENABLED: "true"');
    expect(ci).toContain('DS_MAX_DEPTH: "5"');
    expect(ci).not.toContain("Jobs/Dependency-Scanning.latest.gitlab-ci.yml");
  });

  it("runs one bounded Linux source smoke without release or full-suite work", () => {
    const ci = config();
    expect(ci).toContain("tokengraph-linux:");
    expect(ci).toContain("image: node:22-bookworm");
    expect(ci).toContain("corepack prepare pnpm@10.14.0 --activate");
    expect(ci).toContain("pnpm install --frozen-lockfile");
    expect(ci).toContain("pnpm typecheck");
    expect(ci).toContain("pnpm build");
    expect(ci).toContain("pnpm smoke -- --root . --json");
    expect(ci).not.toMatch(/^\s*-\s*pnpm (?:test|native:build|package:plugin)\b/mu);
    expect(ci).not.toMatch(/^\s*(?:deploy|release):/mu);
  });
});
~~~

- [ ] **Step 2: Capture RED.**

From plugins/tokengraph run: pnpm vitest run tests/gitlab-ci-contract.test.ts --reporter=dot. Expected: all three tests fail because .gitlab-ci.yml does not exist. Record the exact output.

- [ ] **Step 3: Add the minimal GitLab configuration.**

Create repository-root .gitlab-ci.yml:

~~~yaml
workflow:
  rules:
    - if: '$CI_COMMIT_BRANCH'
      when: always
    - when: never

stages:
  - test

include:
  - template: Jobs/SAST.gitlab-ci.yml
  - template: Jobs/Dependency-Scanning.v2.gitlab-ci.yml
  - template: Jobs/Secret-Detection.gitlab-ci.yml

variables:
  AST_ENABLE_MR_PIPELINES: "false"
  GITLAB_ADVANCED_SAST_ENABLED: "true"
  DS_MAX_DEPTH: "5"

tokengraph-linux:
  stage: test
  image: node:22-bookworm
  interruptible: true
  timeout: 20m
  script:
    - cd plugins/tokengraph
    - corepack enable
    - corepack prepare pnpm@10.14.0 --activate
    - pnpm install --frozen-lockfile
    - pnpm typecheck
    - pnpm build
    - pnpm smoke -- --root . --json
~~~

- [ ] **Step 4: Capture focused GREEN and validate the expanded GitLab configuration.**

Run the same one-file Vitest command; expect 3 passed, 0 failed. Run git diff --check. Use GitLab's CI Lint / pipeline simulation on this exact YAML and branch context; inspect the expanded jobs and rules. If a template has changed, adjust the minimum necessary YAML and contract test, then rerun these focused checks. Never describe static Vitest alone as proof the GitLab pipeline executes.

- [ ] **Step 5: Commit narrowly.**

Commit only .gitlab-ci.yml and plugins/tokengraph/tests/gitlab-ci-contract.test.ts with message ci(gitlab): add complementary branch pipeline. Do not push yet; Task 2 records the operating boundary first.

### Task 2: Public operating runbook and single GitHub publication

**Files:**
- Create: docs/ci/gitlab-ultimate.md

**Interfaces:**
- Consumes: Task 1's exact pipeline, approved spec, and public project URLs.
- Produces: a credential-free runbook. No CI configuration or external settings change in this task.

- [ ] **Step 1: Add the runbook with these exact operating rules.**

Create docs/ci/gitlab-ultimate.md with this content, updating only proven UI labels if GitLab changed them:

~~~markdown
# GitLab Ultimate mirror and CI

GitHub Mujadarah/TokenGraph is the sole source of branches, tags, reviews,
merges, and releases. GitLab kesharon-group/TokenGraph only pulls GitHub
commits and runs complementary branch CI. Never commit or push source on
GitLab and never enable Overwrite diverged branches.

Before a mirror update, compare GitHub and GitLab branch and tag refs. Stop
on a GitLab-only or divergent ref. GitLab does not delete refs removed from
GitHub, so report equality only for named, checked refs. Mirror lag is
normal; do not treat a result for an older SHA as a result for HEAD.

The pipeline runs SAST, dependency scanning, secret detection, and one
Linux install/typecheck/build/smoke job. Read each scanner's report before
claiming coverage. Rust Advanced SAST is beta. This pipeline does not
replace GitHub Actions, CodeRabbit, Greptile, or TokenGraph release gates.

The GitLab status on GitHub is informational until the maintainer
explicitly approves making it required. No mirror or CI success authorizes
merging PR #54, tagging, publishing, or installing TokenGraph.
~~~

- [ ] **Step 2: Check public-document hygiene.**

Run git diff --check and search the new runbook for token values, machine-local paths, and non-ASCII characters. The document must contain no credential examples or local checkout path.

- [ ] **Step 3: Commit and publish the reviewed dependent branch once.**

Commit only the runbook with message docs(ci): document GitHub-canonical GitLab operation. Recheck git status and git rev-parse HEAD. Push codex/gitlab-ultimate-ci to GitHub without force. This single push will trigger existing GitHub CI; opening a PR may trigger a second run because the current workflow listens to both push and pull_request. Do not manually dispatch another full suite or modify the existing workflow to avoid this side effect. Open a draft GitHub PR against codex/phase12-release-integration so CodeRabbit/Greptile can review the narrow integration without merging it to main. Record PR URL, SHA, and any review findings. Attach the PR to the current Codex task.

### Task 3: Safe pull mirror and exact-ref synchronization

**Files:** No repository edits; GitLab project settings and read-only remote-ref evidence.

**Interfaces:**
- Consumes: Task 2's pushed GitHub branch and the GitLab project kesharon-group/TokenGraph.
- Produces: a pull-only mirror whose checked branches/tags are identical to GitHub, with overwrite disabled.

- [ ] **Step 1: Re-audit both remotes before touching settings.**

Run git ls-remote --heads --tags https://github.com/Mujadarah/TokenGraph.git and the same command for https://gitlab.com/kesharon-group/TokenGraph.git. Compare every returned ref name and SHA. For a GitLab branch with a different SHA, fetch the two exact refs into the isolated worktree and require git merge-base --is-ancestor <GitLab-SHA> <GitHub-SHA> to exit zero. Annotated tag object SHAs must match exactly; do not compare only peeled tag commits. Stop on a divergent or GitLab-only ref. Record the observed table, not just a summary.

- [ ] **Step 2: Confirm no hidden prerequisite changed.**

In GitLab verify the existing project, Ultimate entitlement, suitable Linux instance runner availability, no existing mirror or GitHub integration, and zero CI variables. If any assumption changed, inspect it before proceeding. Do not change General pipelines, Auto DevOps, or runner permissions as a setup shortcut.

- [ ] **Step 3: Enable the pull-only mirror in GitLab.**

Go to Settings > Repository > Mirroring repositories. Source URL: https://github.com/Mujadarah/TokenGraph.git. Direction: Pull. Use unauthenticated HTTPS only if GitLab accepts it; if GitLab requests a GitHub read token, stop for a separate least-privilege decision. Leave Overwrite diverged branches off. Enable Trigger pipelines for mirror updates only after Task 1's YAML has been reviewed and the project has no custom job-level secrets; GitLab's built-in CI_JOB_TOKEN is still present. Do not select Only mirror protected branches because the dependent branch must reach GitLab. Save once and request the initial update.

- [ ] **Step 4: Verify named-ref equality, not presumed global parity.**

After GitLab reports mirror success, repeat both git ls-remote commands. Require exact equality for main, codex/phase12-release-integration, and codex/gitlab-ultimate-ci. Compare every other existing branch and tag, recording any retained GitLab-only ref separately. If an upstream branch/tag was deleted, do not delete the GitLab copy as part of this task. A non-equal or failed mirror is a stop condition, not a reason to enable overwrite.

### Task 4: Observe one complementary GitLab branch pipeline

**Files:** No repository edits unless the focused CI configuration has a proven defect; such a fix needs another narrow commit to GitHub and another mirror cycle.

**Interfaces:**
- Consumes: Task 3's exact mirrored codex/gitlab-ultimate-ci SHA.
- Produces: one real pipeline's job, coverage, and runtime evidence tied to that SHA.

- [ ] **Step 1: Find the mirror-triggered branch pipeline.**

In GitLab Build > Pipelines, select codex/gitlab-ultimate-ci. If the initial update did not trigger a pipeline, first verify the mirror-trigger option and the expanded pipeline simulation; use Run pipeline once for that branch only. Record pipeline URL, source, SHA, and exact job list. Do not manually rerun the complete TokenGraph suite.

- [ ] **Step 2: Inspect the expected jobs and absence of duplicates.**

Require tokengraph-linux, SAST analyzers for supported TypeScript/JavaScript and beta Rust where available, dependency scanning with both plugins/tokengraph/pnpm-lock.yaml and plugins/tokengraph/native/lock-addon/Cargo.lock, and secret_detection. Inspect actual reports/artifacts; a skipped analyzer or empty report is not proof of coverage. Confirm there is no MR duplicate, release/deploy job, full-suite job, or native six-target job. If the runner has no capacity or a scanner is unavailable, report that as an unverified dependency rather than a pass.

- [ ] **Step 3: Record focused outcomes and handle failures narrowly.**

Capture each job's exit status and the Linux smoke result. For a real YAML/analyzer error, change only .gitlab-ci.yml and its focused contract test on GitHub, rerun that focused test, commit conventionally, push without force, and wait for the same SHA to mirror. Do not modify TokenGraph native lock or security checks to make this pipeline green.

### Task 5: Status-only GitHub integration and follow-up observation

**Files:** No repository edits; GitLab GitHub integration settings and GitHub status evidence.

**Interfaces:**
- Consumes: Task 4's verified GitLab pipeline and exact SHA.
- Produces: an informational GitLab pipeline status on that same GitHub commit, without making it a merge requirement.

- [ ] **Step 1: Ask for action-time credential confirmation.**

Before any token creation, show the maintainer the target GitHub repo, GitLab integration recipient, repo:status permission, intended short expiry, and the fact that GitLab will store the secret. Request explicit confirmation for this credential action. Never paste the token into chat, files, CI variables, URLs, or logs. If status-only permission is not accepted, stop; do not add repo or admin:repo_hook.

- [ ] **Step 2: Configure only the GitHub project integration.**

With the maintainer's action-time confirmation, create the status-only token in GitHub's token UI and paste it directly into GitLab Settings > Integrations > GitHub. Set Repository URL to https://github.com/Mujadarah/TokenGraph. Leave static status-check names enabled for a stable identity. Test settings and save. Do not enable external-PR pipelines, a second GitLab project, webhooks, or any GitLab-to-GitHub repository push.

- [ ] **Step 3: Verify exact-SHA status and preserve existing reviewers.**

On GitHub inspect commit statuses for Task 4's SHA and the GitLab pipeline target URL. Require the status SHA to equal the pipeline SHA and the target to identify the observed GitLab run. Check that GitHub Actions, CodeRabbit, and Greptile checks are still present. If GitHub HEAD advances while GitLab lags, the new SHA must have no green GitLab status borrowed from the old SHA.

- [ ] **Step 4: Observe one later GitHub-to-GitLab update before closing rollout.**

At the next ordinary GitHub commit, verify GitLab eventually points to the same SHA and runs the intended branch pipeline. Do not create a gratuitous commit solely to exercise the mirror. Report mirror delay, pipeline status, scanner coverage, and any retained upstream-deleted refs. Leave the GitLab check informational and PRs draft; request separate maintainer decisions for a required check, merge, tag, or publication.

## Final evidence and stop conditions

Report the dependent branch, local and remote SHA, dirty files, focused RED/GREEN totals, draft PR URL, mirror direction/options, exact-ref comparison, GitLab pipeline URL/SHA/job results, scanner coverage gaps, GitHub status context/SHA, open reviews, and any blocker. Do not claim full TokenGraph verification or release readiness: the full tests, native matrix, Phase 12 host probe, live Plugin Eval, and release gates remain governed by their own plan.

Official references: https://docs.gitlab.com/user/project/repository/mirror/pull/ ; https://docs.gitlab.com/user/project/integrations/github/ ; https://docs.gitlab.com/user/application_security/sast/ ; https://docs.gitlab.com/user/application_security/dependency_scanning/dependency_scanning_sbom/ ; https://docs.gitlab.com/user/application_security/secret_detection/pipeline/ .
