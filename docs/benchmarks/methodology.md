# TokenGraph Benchmark Methodology

TokenGraph benchmarks are local fixture checks for routing quality and estimated context savings. They are not universal performance claims.

## Task Categories

- Code graph routing tasks.
- SQL graph routing tasks.
- Memory recall tasks.
- Wiki orientation tasks.
- Log compression tasks.
- Root cause debugging tasks.
- Regression risk tasks.
- Architecture check tasks.
- Release packaging validation tasks.

## Metrics

- Files read.
- Raw lines read.
- Estimated input tokens.
- Estimated output tokens.
- MCP tool calls.
- Time to useful patch scope.
- False positive files.
- False negative files.
- Tests recommended.
- Tests passed.
- Estimated tokens avoided.
- Whether task quality was preserved.

## Claims Policy

Do not claim universal 95 percent token reduction. Report measured savings by task type, separate savings from code graph, SQL graph, memory, wiki, and compression, and include failure cases. Token savings are estimates, not exact measurements.
