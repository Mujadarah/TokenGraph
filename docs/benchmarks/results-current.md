# Current Benchmark Results

Run the deterministic evidence benchmark from `plugins/tokengraph`:

```powershell
pnpm benchmark -- --json
```

The current checked-in corpus and fixture produce:

- Corpus: `evidence-v1`.
- Tasks: 30.
- Category counts: code routing 5, SQL/security 5, debugging 4, change risk 4, compression 4, memory/wiki 4, release packaging 4.
- Critical-constraint preservation: 100% under polarity-safe exact normalized predicates.
- Critical false negatives: 0.
- Required-file recall: 100% against the checked-in 0.85 baseline.
- Forbidden false positives: 0.
- Missing expected-test recommendations: 0.
- Median net estimated savings: 30.5 tokens after the full compact MCP response, actual registered schema, and canonical completion-footer overhead.
- 25th-percentile net estimated savings: -166 tokens.
- Deterministic release gate: pass.
- Negative tail: 11 individual tasks still have non-positive net estimates. These are concentrated in small raw baselines and the memory/wiki flow and remain visible as task failures.

Calibration entries contain one observation per corpus task: four for five categories and five for code routing and SQL/security. Every category remains low-confidence and does not activate Task 1A calibration. The direct `taskCalibration` projection is consumable by Task 1A, but these deterministic fixture observations are not statistical proof of host-agent quality.

These results are deterministic fixture evidence, not universal agent-output proof. They do not demonstrate patch quality or exact billed-token savings. Paired Codex and Claude evaluation remains a later release gate.
