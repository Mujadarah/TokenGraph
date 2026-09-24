---
name: context-compression
description: Use when large logs, diffs, prompts, SQL, memory, or mixed context must be reduced without losing critical detail.
---

# Context Compression

## When not to use

Do not use for small material, bounded context, or evidence requiring exact text.

## Unique tool sequence

Load the shared `tokengraph` router contract; if unavailable, do not call TokenGraph. Use `tokengraph_compress` with `mode: "output"` for logs, tests, builds, installs, and diffs; use `mode: "context"` for prompts, memory, SQL, wiki, or mixed context.

## Evidence required

Preserve constraints, errors, identifiers, paths, warnings, omissions, and `omittedLineCount`. Output mode uses the token estimate; context mode uses confidence for targeted raw reads.

## Failure boundaries

Never compress polarity, required tests, or security warnings. Stop when omissions hide a decision-critical fact, input crosses the trusted workspace, or the compressor is unavailable.

## Completion criteria

Return a compact result, omissions, confidence or token estimate, and required raw reads. Compression is routing evidence, not proof of implementation.
