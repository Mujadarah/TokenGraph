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
