# GitHub-Canonical GitLab Ultimate CI Design

Date: 2026-09-23
Status: Approved for implementation planning on 2026-09-23; rollout awaits plan review

## Purpose and authority

Use the existing `kesharon-group/TokenGraph` GitLab project as a downstream
CI and security-analysis copy of `Mujadarah/TokenGraph`. GitHub remains the
only source of code, branches, tags, pull requests, reviews, merges, release
decisions, and published artifacts. GitLab must never become ahead of GitHub
on a mirrored ref, push back to GitHub, or publish a TokenGraph release.

This design adds complementary GitLab Ultimate evidence. It does not replace
GitHub Actions, CodeRabbit, Greptile, or the Phase 12 release gates. In
particular, a GitLab green pipeline does not resolve the current Windows
full-gate timeout, the discordant GitHub CI timeout run, the real Claude host
probe, or the Linux live Plugin Eval requirement.

## Observed starting state

- GitHub and GitLab `main` both pointed to
  `af29092d791021f6ce9f26f4eb12e532f55e188a` on 2026-09-23.
- GitHub `codex/phase12-release-integration` pointed to
  `4587682dbd36f1cb6920358466a6f15a698303a3`; GitLab held its ancestor
  `53e845615f57583fb41bc1e23be25f1e11219b52`.
- The existing GitLab project had no repository mirror, active GitHub project
  integration, `.gitlab-ci.yml`, or pipeline history.
- GitHub PR #54 was open and draft. These are snapshots, not continuing
  assumptions; refresh every ref and project setting before rollout.
- The maintainer states that the `kesharon-group` namespace has GitLab
  Ultimate. Verify the needed features in the project before enabling them.

## Ownership and data flow

```text
GitHub canonical branch/tag commit
    -> GitLab pull-only mirror of the same commit SHA
    -> GitLab branch pipeline and Ultimate security reports
    -> GitHub commit status for that exact SHA
```

The CI configuration is committed to GitHub on a dependent `codex/` branch
and reaches GitLab only through mirroring. Do not author pipeline code or
fixes directly in GitLab. GitLab-native merge requests and security records
are service-local metadata, not a second source tree or a replacement for
GitHub PR review.

Mirror branches and tags from the public GitHub repository over HTTPS. Leave
`Overwrite diverged branches` disabled. Before enabling mirroring, compare
all relevant GitHub and GitLab branch and tag refs: GitLab refs must match,
be absent, or be ancestors of their GitHub counterparts. Stop on a divergent
or GitLab-only ref and seek a specific disposition; do not force-update or
delete it. After the initial pull, verify exact SHA equality for `main` and
the Phase 12 branch, then verify new GitHub commits propagate. The mirror is
eventually consistent, not an instantaneous second primary. Start with
GitLab's scheduled pull and a deliberate initial `Update now`; a webhook for
lower latency is a separate access and design decision.

GitLab pull mirroring does not delete branches or tags removed upstream.
Treat any later GitLab-only ref as stale until reviewed; remove it only after
a separate, explicit cleanup decision. Equality claims must name the refs
actually compared rather than imply automatic deletion parity.

## Pipeline scope

Use a GitHub-tracked `.gitlab-ci.yml` with branch-pipeline rules that avoid
duplicate branch and external-PR pipelines. Run no deployment or release job.
The complementary checks are:

1. GitLab's stable SAST template, enabling Advanced SAST where supported by
   the Ultimate project. Report language coverage honestly; Rust Advanced
   SAST is currently beta and runs in a separate analyzer job, so do not
   claim Rust coverage merely because a TypeScript analyzer passes.
2. GitLab's supported SBOM-based dependency-scanning template for the pnpm
   and Cargo manifests/lockfiles that its analyzer actually accepts.
3. GitLab's stable pipeline secret-detection template. Scanner findings are
   security evidence, not a claim of comprehensive secret detection.
4. One bounded Linux integration job for dependency installation, typecheck,
   build, and smoke of the source plugin. Keep the process-tree, native lock,
   trust, and packaging checks unchanged; omit the already-running full
   GitHub test suite and six-target native matrix from this complementary
   pipeline.

Use official templates rather than copying analyzer implementations. Pin
locally selected tool images or versions where GitLab permits it, and review
template behavior before the first pipeline. A scanner job that is skipped
for missing support is not evidence that the corresponding code was scanned.
Keep CI job logs and artifacts free of credentials, machine-local paths,
raw prompts, and private runtime state. Add no custom CI job secrets;
GitLab's built-in CI_JOB_TOKEN still exists and must not be exposed.
No production activation or managed runtime installation occurs in GitLab CI.

GitLab security dashboards derive default-branch findings from a successful
default-branch pipeline. Phase 12 branch findings can be inspected earlier,
but do not describe the default-branch dashboard as populated until the
GitHub-reviewed configuration reaches `main` and a `main` pipeline succeeds.

## Credentials and status reporting

The public GitHub source requires no GitHub read credential for pull
mirroring. GitLab's documented GitHub project integration requires a GitHub
API token with `repo:status` permission to report pipeline status. Use a
separate, short-lived token for this integration; do not grant `repo`,
`admin:repo_hook`, repository-content write, or workflow write merely to
report status. Store the token only in GitLab's integration secret field,
never in Git, CI variables, a URL, logs, or this design. Confirm the exact
scope and recipient with the maintainer immediately before creating the
credential. If the documented status-only token is unavailable or rejected,
stop for a new access decision instead of broadening it silently.

Report a stable, clearly named GitLab status to the exact mirrored GitHub
commit SHA. Do not make it a required GitHub merge check until a real
end-to-end pipeline and status have been observed and the maintainer approves
that policy change. A pending, missing, or stale GitLab status must never be
presented as a pass for a different commit.

## Failure behavior and boundaries

- If mirroring encounters divergence or identity uncertainty, stop and
  preserve both sides; never enable overwrite to make a badge green.
- If GitLab lags GitHub, show the pending or absent status honestly. Do not
  run a pipeline on a stale GitLab SHA and attribute it to the new GitHub SHA.
- If a scanner cannot analyze a supported expected source or lockfile, fix
  the configuration or document the coverage gap; do not suppress the job.
- If a pipeline requires custom credentials in a job, stop and review the
  threat model. The first rollout adds no custom job-level secrets.
- If GitLab's integration emits duplicate pipelines or statuses, narrow the
  workflow rules before making the check required on GitHub.
- Never use GitLab's mirror or pipeline as authority to merge PR #54, tag,
  publish, install, or waive the controlling TokenGraph plan's gates.

## Rollout and verification contract

1. Recheck GitHub/GitLab refs, GitLab Ultimate features, runner availability,
   and the clean dependent branch. Record any GitLab-only or divergent refs.
2. Add the pipeline configuration through the GitHub dependent branch and
   review it there. Validate the YAML and GitLab pipeline simulation before
   enabling automatic runs. Do not merge it to `main` as a setup shortcut.
3. Enable pull-only mirroring with overwrite off and no credentials in the
   public clone URL. Pull once, then compare exact SHAs on mirrored refs.
4. Run one complementary branch pipeline. Record each expected job's status,
   analyzer coverage, Linux smoke result, and the exact commit SHA. Confirm
   there is no deployment, release, full-suite, or native-matrix duplicate.
5. After action-time credential confirmation, configure GitLab's GitHub
   project integration and verify a status on the same GitHub SHA. Check that
   GitHub's existing CI and reviewers remain present and unchanged.
6. Observe a later GitHub commit flow to GitLab without a GitLab-originated
   commit. Keep GitLab's check informational until the maintainer separately
   approves requiring it for merge.

This design authorizes neither implementation nor external setting changes.
The maintainer must review this written spec, then review an implementation
plan, before rollout begins.

## References

- GitLab pull mirroring: https://docs.gitlab.com/user/project/repository/mirror/pull/
- GitLab GitHub status integration: https://docs.gitlab.com/user/project/integrations/github/
- GitLab security configuration: https://docs.gitlab.com/user/application_security/detect/security_configuration/
- GitLab dependency scanning: https://docs.gitlab.com/user/application_security/dependency_scanning/
- GitLab pipeline secret detection: https://docs.gitlab.com/user/application_security/secret_detection/pipeline/
