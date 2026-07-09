# Current Benchmark Results

Current results are generated from local fixtures with:

```powershell
cd plugins\tokengraph
pnpm benchmark -- --json
```

The harness reports task-level estimated savings for code graph routing, SQL graph routing, memory recall, wiki orientation, log compression, root cause debugging, regression risk, architecture checks, and release packaging validation.

These numbers are not universal claims. They are local fixture estimates meant to catch regressions in benchmark coverage and proof discipline.

## Current Status

- Harness: `plugins/tokengraph/scripts/benchmark.mjs`
- Fixture root: `plugins/tokengraph/tests/fixtures/next-supabase`
- Claims policy: no universal 95 percent token reduction claim
- Quality policy: compression and routing must preserve the option to perform targeted raw reads when needed
