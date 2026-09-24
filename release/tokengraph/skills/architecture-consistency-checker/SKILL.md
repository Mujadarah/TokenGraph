---
name: architecture-consistency-checker
description: Use when import direction, SQL, security, release, or module-boundary changes need consistency checks.
---

# Architecture Consistency Checker

## When not to use

Do not use when no architecture boundary is implicated or to make undocumented conventions binding.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_analyze` with `mode: "architecture"` for module rules and `mode: "risk"` for import, SQL, security, or release changes. Query targeted symbols or SQL when needed.

## Evidence required

Check source, SQL, tests, and rules. Label proposals and inference; only recorded enforced facts are violations.

## Failure boundaries

Do not silently create rules, merge workspaces, or treat missing documentation as proof. Stop on cross-boundary paths, unavailable source evidence, or a proposed repair.

## Completion criteria

Return enforced facts, warnings, proposals, affected boundaries, and the evidence that supports each classification. Keep import, SQL, security, and release conclusions separate.
