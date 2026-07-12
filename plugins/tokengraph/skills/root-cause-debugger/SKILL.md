---
name: root-cause-debugger
description: Use when a test, build, runtime, install, or log failure needs evidence-led root-cause analysis.
---

# Root Cause Debugger

## When not to use

Do not use for feature planning without a failure, or to implement a speculative fix before reproducing the problem.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; on blocked setup follow recovery and do not invent a taskId.
2. Call `tokengraph_prepare_context({ root: trusted root, task })` once and capture its taskId.
3. Call `tokengraph_analyze({ taskId, root: trusted root, mode: "failure", kind, text, task? })` with the original failure text exactly once. Its returned compressed evidence drives follow-up `tokengraph_query_context` calls with the exact captured root that confirm or disprove the analysis; never substitute a possibly incomplete pre-compression for the original text.
4. Use standalone `tokengraph_compress({ taskId, root: trusted root, mode: "output", kind, text })` for oversized output only when failure analysis is not the consumer. Preserve exact errors, tests, stack paths, and line numbers; key fallback reads off `omittedLineCount` and the returned token estimate.
5. Separate verified facts from hypotheses. For each hypothesis, identify supporting evidence and the smallest disconfirming read or command. Add or identify regression evidence and run the relevant regression test before completion.
6. Call `tokengraph_task_report({ taskId, root: trusted root, disposition: "complete" })` only after the cause, requested fix, and regression verification are complete. Use `tokengraph_task_report({ taskId, root: trusted root, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use the existing narrow local debugging fallback, and claim no savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. Until Phase 3 hook enforcement exists, call the report explicitly and manually include its returned status in the final report.
