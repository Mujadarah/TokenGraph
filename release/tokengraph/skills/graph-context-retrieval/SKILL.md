---
name: graph-context-retrieval
description: Use when project structure, symbols, SQL objects, routes, or wiki orientation must be narrowed before source inspection.
---

# Graph Context Retrieval

## When not to use

Do not use for a known one-file lookup or an explicit raw-source request.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_query_context` with `mode: "overview"`, `mode: "search"`, `mode: "symbol"`, `mode: "sql"`, or `mode: "wiki"`. Omit `knownArtifacts`; use `["id@hash"]` only from a prior response, otherwise resend required evidence.

## Evidence required

State the mode, target or query, confidence, and targeted raw reads needed. Keep paths inside the trusted workspace.

## Failure boundaries

Do not turn orientation into a claim about uninspected source. Stop on cross-workspace paths, missing confidence, or an unavailable query surface; use narrow local search as a stated fallback.

## Completion criteria

Return the map, identifiers, or references with uncertainty and exact artifact keys. The caller decides if raw evidence is required.
