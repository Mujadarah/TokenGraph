---
name: root-cause-debugger
description: Use when a test, build, runtime, install, or log failure needs evidence-led root-cause analysis.
---

# Root Cause Debugger

## When not to use

Do not use for bounded failures with complete evidence, or speculative fixes before reproduction.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Call `tokengraph_analyze` with `mode: "failure"` and the original failure text exactly once. Use returned compressed evidence, then `tokengraph_query_context` to confirm hypotheses. Use `tokengraph_compress` with `mode: "output"` only when analysis is not the consumer.

## Evidence required

Separate facts from hypotheses. Preserve exact errors, tests, stack paths, and lines; name supporting evidence, the smallest disconfirming read, and regression evidence.

## Failure boundaries

Never replace the original failure text, or treat a compressed result as the consumer when it is not. Stop if unreproducible or outside the trusted workspace.

## Completion criteria

Return the cause, bounded fix target, and regression result. Keep hypotheses labeled until disproved or confirmed.
