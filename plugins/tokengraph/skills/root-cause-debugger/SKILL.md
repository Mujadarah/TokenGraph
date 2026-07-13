---
name: root-cause-debugger
description: Use when a test, build, runtime, install, or log failure needs evidence-led root-cause analysis.
---

# Root Cause Debugger

## When not to use

Do not use for a tiny self-contained failure whose complete raw evidence is already bounded, or to implement a speculative fix before reproducing the problem. Use it when routing can avoid broader reads or preserve failure constraints.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; on blocked setup follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a retrieval plan is needed. Otherwise omit `taskId` from the first failure analysis so it can auto-start the ledger and return a taskId; capture the returned taskId.
3. Call `tokengraph_analyze({ taskId?, mode: "failure", kind, text, task? })` with the original failure text exactly once. Its returned compressed evidence and taskId drive follow-up `tokengraph_query_context` calls that confirm or disprove the analysis; never substitute a possibly incomplete pre-compression for the original text. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Use standalone `tokengraph_compress({ taskId, mode: "output", kind, text })` for oversized output only when failure analysis is not the consumer. Preserve exact errors, tests, stack paths, and line numbers; key fallback reads off `omittedLineCount` and the returned token estimate.
5. Separate verified facts from hypotheses. For each hypothesis, identify supporting evidence and the smallest disconfirming read or command. Add or identify regression evidence and run the relevant regression test before completion.
6. Only after the cause, requested fix, and regression verification are complete, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state "TokenGraph was not used," use the existing narrow local debugging fallback, and claim no savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
