# Security

TokenGraph is a developer tool that indexes local project metadata for code navigation, SQL summaries, memory recall, and compact context planning.

It excludes secrets by default, respects `.gitignore`, and excludes dependency folders and build output by default. SQL indexing can be disabled. Memory can be disabled.

TokenGraph does not guarantee correctness and does not replace code review.

## Workspace boundary

TokenGraph never treats a caller-supplied `root` as the workspace trust boundary. When launched from a plugin directory, it requires a host-provided project root (`CLAUDE_PROJECT_DIR`, `TOKENGRAPH_WORKSPACE_ROOT`, or MCP Roots). Every requested root must resolve inside that boundary. Filesystem roots and home directories are rejected, and no `.tokengraph/` state is written before the check succeeds.

Architecture-rule patterns are validated in a bounded worker before they are persisted. Invalid or catastrophic-backtracking regular expressions are rejected so one saved rule cannot block the MCP server.
