# Security

TokenGraph is a developer tool that indexes local project metadata for code navigation, SQL summaries, memory recall, and compact context planning.

It excludes secrets by default, respects `.gitignore`, and excludes dependency folders and build output by default. SQL indexing can be disabled. Memory can be disabled.

TokenGraph does not guarantee correctness and does not replace code review.

## Native lock boundary

Release packages contain six prebuilt native lock addons and never download or compile code at runtime. Validation checks the exact target, ABI, byte length, SHA-256, binary format, build-path policy, and locked dependency notices before loading. The verified bytes are copied to a fresh private operating-system temporary directory and loaded without `node_modules`, a compiler, network access, a sidecar, or a JavaScript lock fallback.

The kernel lock is authoritative only on a cooperative local filesystem. Network filesystems and active same-account path replacement are best effort and are not a distributed-lock or hostile-local-process security claim. Existing legacy lock files, malformed state, unsafe links, integrity mismatch, unsupported targets, and indeterminate cleanup fail closed.

## Workspace boundary

TokenGraph never treats a caller-supplied `root` as the workspace trust boundary. It resolves the trusted workspace from the first available source in this order:

1. Codex request metadata (`x-codex-turn-metadata`) naming a project workspace and thread, corroborated by the matching trusted lifecycle-hook attestation.
2. `CLAUDE_PROJECT_DIR` from Claude Code.
3. `TOKENGRAPH_WORKSPACE_ROOT`, normally configured before Codex starts.
4. A Codex session-hook attestation identified by `CODEX_THREAD_ID`.
5. A file root supplied through MCP Roots.
6. The process working directory, only when the server is not running from an installed plugin directory.

Request metadata is accepted only when its advertised workspace contains the attested root for the same thread; an invalid or missing attestation never grants access and never falls back to a process-wide root for that request. This per-request resolution lets one MCP process serve concurrent projects without cross-applying state. Every requested root must resolve inside that boundary. Installed plugin launches with no host-provided source remain blocked. Filesystem roots and home directories are rejected, and no `.tokengraph/` state is written before the check succeeds.

Architecture-rule patterns are validated in a bounded worker before they are persisted. Invalid or catastrophic-backtracking regular expressions are rejected so one saved rule cannot block the MCP server.

## Runner capture boundary

Runner secret redaction is best effort and not a guarantee. Saved captures are JSON under `.tokengraph/runs/` in the active worktree and are stored as plaintext. TokenGraph does not perform always-on process capture. To avoid runner capture entirely, do not invoke `tokengraph run`; use normal host execution instead.

Do not send regulated or highly sensitive output through the runner. Storage is not encrypted today. The isolated storage interfaces and write boundaries preserve the option to add future optional local encryption, but no encryption feature is currently claimed.
