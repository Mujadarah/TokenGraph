# Security

TokenGraph is a developer tool that indexes local project metadata for code navigation, SQL summaries, memory recall, and compact context planning.

It excludes secrets by default, respects `.gitignore`, and excludes dependency folders and build output by default. SQL indexing can be disabled. Memory can be disabled.

TokenGraph does not guarantee correctness and does not replace code review.

## Workspace boundary

TokenGraph never treats a caller-supplied `root` as the workspace trust boundary. It resolves the trusted workspace from the first available source in this order:

1. `CLAUDE_PROJECT_DIR` from Claude Code.
2. `TOKENGRAPH_WORKSPACE_ROOT`, normally configured before Codex starts.
3. A file root supplied through MCP Roots.
4. The process working directory, only when the server is not running from an installed plugin directory.

Every requested root must resolve inside that boundary. Installed plugin launches with no host-provided source remain blocked. Filesystem roots and home directories are rejected, and no `.tokengraph/` state is written before the check succeeds.

Architecture-rule patterns are validated in a bounded worker before they are persisted. Invalid or catastrophic-backtracking regular expressions are rejected so one saved rule cannot block the MCP server.

## Runner capture boundary

Runner secret redaction is best effort and not a guarantee. Saved captures are JSON under `.tokengraph/runs/` in the active worktree and are stored as plaintext. TokenGraph does not perform always-on process capture. To avoid runner capture entirely, do not invoke `tokengraph run`; use normal host execution instead.

Do not send regulated or highly sensitive output through the runner. Storage is not encrypted today. The isolated storage interfaces and write boundaries preserve the option to add future optional local encryption, but no encryption feature is currently claimed.
