---
name: context-compression
description: Use TokenGraph compression and planning tools to preserve important constraints while reducing prompt, diff, log, SQL, memory, and wiki context.
when_to_use: Use when a coding agent must reduce a large context while preserving implementation-critical details.
---

# Context Compression

Use this skill when a prompt, diff, log, test output, SQL block, memory set, or wiki context is too large to use directly.

## MCP tools to call

Call `tokengraph_setup_status` first when compression needs project context. If it reports `blocked`, follow its recovery steps and do not claim project-aware compression was used.

1. Call `tokengraph_compress_context` for prompt, memory, diff, SQL, wiki, and mixed context.
2. Call `tokengraph_compress_output` for logs, tests, builds, installs, diffs, and mixed command output.
3. Call `tokengraph_plan_context` to replace broad background with targeted first reads.
4. Call `tokengraph_show_wiki_page` for compact project orientation instead of repeated raw summaries.
5. Call `tokengraph_review_memories` with a narrow query instead of dumping memory files.
6. Call `tokengraph_summarize_sql` for database context instead of reading full migrations by default.

## Operating rules

- Avoid raw reads and raw dumps by default. Use raw content only when compression confidence is low or the exact source is required.
- Preserve user constraints, exact error messages, test names, stack paths, migration identifiers, public API names, and security warnings.
- Mark hypotheses clearly when compressed context suggests a cause or patch scope.
- Do not pretend `tokengraph_compress_context` or any unavailable MCP tool was used.
- Report important omissions and recommend targeted raw reads when compression could hide implementation-critical detail.
