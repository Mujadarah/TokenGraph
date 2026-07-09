---
name: release-packaging-auditor
description: Use TokenGraph routing plus local validation commands to audit Codex plugin release packaging and one-click install readiness.
---

# Release Packaging Auditor

Use this skill when changing plugin manifests, marketplace metadata, MCP config, release folders, package scripts, docs, or validation gates.

## MCP tools to call

1. Call `tokengraph_index_status` and refresh with `tokengraph_index_project` when needed.
2. Call `tokengraph_plan_context` with the release or install-readiness task.
3. Call `tokengraph_compress_output` for long build, package, smoke, validation, or diff output.
4. Call `tokengraph_project_map` to confirm the repository shape and release/source separation.
5. Call `tokengraph_show_wiki_page` when existing wiki pages can orient packaging or release decisions.
6. Call `tokengraph_review_memories` for prior release, cache, or Codex install decisions.

## Operating rules

- Avoid raw reads until the marketplace, manifest, package script, validator, and release folder targets are identified.
- Mark hypotheses clearly when diagnosing install failures or missing MCP tools.
- Do not pretend MCP tools were used when they are unavailable. Fall back to targeted file reads and concrete commands.
- Verify one-click install readiness with local evidence: marketplace path, required release files, validator, package command, smoke tests, and direct release MCP startup.
- Normal user docs must not require `pnpm install`, `pnpm build`, TypeScript, cloud services, API keys, or telemetry.
