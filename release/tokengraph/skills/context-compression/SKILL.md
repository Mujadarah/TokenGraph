---
name: context-compression
description: Use when large logs, diffs, prompts, SQL, memory, or mixed context must be reduced without losing critical detail.
---

# Context Compression

## When not to use

Do not use for already-small material, bounded raw context, or when exact full text is itself the requested evidence. Use it when compression can avoid broader reads while preserving constraints.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})` and capture `trustedWorkspace.root` as the trusted root; on blocked setup follow recovery and do not invent a taskId.
2. Use `tokengraph_prepare_context({ task })` only when a retrieval plan is needed. Otherwise omit `taskId` from the first `tokengraph_compress` call so it can auto-start the ledger and return a taskId; capture the returned taskId.
3. Reuse that exact taskId. Call `tokengraph_compress({ taskId, mode: "output", kind, text })` for test, build, install, diff, or log output. Call `tokengraph_compress({ taskId, mode: "context", task, contentKind, text? })` for prompt, memory, diff, SQL, wiki, or mixed context. The trusted root may be omitted after ready setup when host workspace resolution is stable; otherwise pass only the captured trusted root.
4. Preserve constraints, exact errors, test names, paths, identifiers, security warnings, raw references, and reported omissions. For output mode, use `omittedLineCount` and the token estimate—not confidence—to decide whether targeted raw lines are required. For context mode, use targeted raw reads on low confidence.
5. Only after the compressed result supports the requested outcome and verification, call `tokengraph_task_report({ taskId })`; compact reporting is the default. Use `tokengraph_task_report({ taskId, responseMode: "verbose" })` only for report diagnostics, and `tokengraph_task_report({ taskId, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use the existing narrow local fallback, and claim no savings or graph-backed evidence.

A paused task id is terminal. Start a new task with `tokengraph_prepare_context` or a direct intent call that omits `taskId`; never reuse the paused id.

A host refresh may require a fresh task or `/reload-plugins`. The lifecycle hook checks reports and exact footers at normal Stop. If hooks are disabled, untrusted, unavailable, or the turn ends by interrupt or API failure, call the report explicitly and manually include its returned status.
