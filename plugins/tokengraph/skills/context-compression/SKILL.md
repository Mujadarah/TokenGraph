---
name: context-compression
description: Use when large logs, diffs, prompts, SQL, memory, or mixed context must be reduced without losing critical detail.
---

# Context Compression

## When not to use

Do not use for already-small material or when exact full text is itself the requested evidence.

## Workflow

Follow the common lifecycle in the general `tokengraph` skill:

1. Call `tokengraph_setup({})`; on blocked setup follow recovery and do not invent a taskId.
2. Call `tokengraph_prepare_context({ root?, task })` once and capture its taskId and trusted root.
3. Reuse the exact taskId and trusted root. Call `tokengraph_compress({ taskId, root?, mode: "output", kind, text })` for test, build, install, diff, or log output. Call `tokengraph_compress({ taskId, root?, mode: "context", task, contentKind, text? })` for prompt, memory, diff, SQL, wiki, or mixed context.
4. Preserve user constraints, exact errors, test names, paths, identifiers, security warnings, raw references, and reported omissions. Treat compression confidence as routing evidence; on low confidence, route to targeted raw reads rather than guessing.
5. Call `tokengraph_task_report({ taskId, root?, disposition: "complete" })` only after the compressed result supports the requested outcome and verification. Use `tokengraph_task_report({ taskId, root?, disposition: "pause" })` for missing evidence, approval, blocked setup after creation, or unfinished work.

Never merge tasks or workspaces, invent or reuse completed ids, or change the trusted root. If core tools are unavailable, state “TokenGraph was not used,” use the existing narrow local fallback, and claim no savings or graph-backed evidence.

A host refresh may require a fresh task or `/reload-plugins`. Until Phase 3 hook enforcement exists, call the report explicitly and manually include its returned status in the final report.
