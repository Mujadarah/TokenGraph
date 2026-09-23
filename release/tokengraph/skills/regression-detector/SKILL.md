---
name: regression-detector
description: Use when a diff or proposed change needs evidence-based impact analysis and regression-test selection.
---

# Regression Detector

## When not to use

Do not use when no change set can be identified or as a substitute for running relevant tests.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_analyze` with `mode: "risk"`, then query changed exports and dependents with `mode: "symbol"` and schema or policy impact with `mode: "sql"`.

## Evidence required

Recommend tests from coverage, dependents, routes, SQL, and risk evidence. Distinguish verified tests from estimated risk and record changed paths.

## Failure boundaries

Do not infer a regression from a name-only match or declare safety without running the recommended tests. Stop when the diff is incomplete, untrusted, or outside the workspace.

## Completion criteria

Return affected surfaces, risk reasons, recommended tests, and their verified results. Mark unresolved impact as uncertainty rather than silently narrowing scope.
