# Phase 11 Plugin Eval harness boundary

Status: source harness and deterministic contracts prepared; no live benchmark,
static evaluation, verifier, or project test execution is claimed.

TokenGraph uses the installed Plugin Eval 0.1.2 CLI-only schema version 2.
The tracked benchmark is rooted at `plugins/tokengraph`, resolves the repository
through the relative `../..` source path, provisions a detached Git worktree,
and preserves failed workspaces only. Live execution is Linux-only because this
Plugin Eval version invokes verifier commands through `/bin/zsh`.

Plugin Eval 0.1.2 exposes one verifier command list for all scenarios. The
TokenGraph verifier therefore dispatches from the bounded scenario result
manifest written by each run. It independently checks required paths, clean or
exact-patch state, focused or full test commands, and low-write telemetry. Its
single JSON stdout record is retained by Plugin Eval after successful workspace
cleanup and becomes the stable input to the custom metric pack.

The metric pack emits only `checks`, `metrics`, and `artifacts`. When
`TOKENGRAPH_PLUGIN_EVAL_BENCHMARK` names a retained `benchmark-run.json`, it
combines Plugin Eval usage, duration, tool-call, workspace-change, and verifier
results with TokenGraph required-file recall, task success, low-write counters,
sampled peak RSS, passed verifier test commands, and patch correctness. Without
that environment variable it reports benchmark evidence as unavailable and
does not invent measured values.

Run artifacts, usage logs, and copied workspaces are ignored. Transcripts and
machine-local paths must not be committed. Static evaluation must target the
generated `release/tokengraph` package; live benchmark evidence remains a
separate Linux release track and does not replace the deterministic benchmark
corpus, promotion gates, or Windows paired-host evidence.
