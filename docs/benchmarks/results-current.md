# Current Benchmark Results

Run the deterministic evidence benchmark from `plugins/tokengraph`:

```powershell
pnpm benchmark -- --json
```

The current checked-in corpus and fixture produce:

- Corpus: `evidence-v1`.
- Tasks: 30.
- Category counts: code routing 5, SQL/security 5, debugging 4, change risk 4, compression 4, memory/wiki 4, release packaging 4.
- Critical-constraint preservation: 0% under polarity-safe exact normalized predicates.
- Critical false negatives: 3.
- Required-file recall: approximately 0.9455 against the checked-in 0.85 baseline.
- Median net estimated savings: -894 tokens after compact, schema, and footer overhead.
- Deterministic release gate: fail because preservation is below 100%, critical false negatives are non-zero, and median net savings is not positive.
- Task failures: 30. Nine tasks expose forbidden-file false positives, three expose false negatives, seven miss expected test recommendations, all 30 fail at least one exact constraint predicate, and all 30 have non-positive net estimates. Conditions can overlap.

Calibration entries contain one observation per corpus task: four for five categories and five for code routing and SQL/security. Every category remains low-confidence and does not activate Task 1A calibration. The direct `taskCalibration` projection is consumable by Task 1A, but these deterministic fixture observations are not statistical proof of host-agent quality.

These results are deterministic fixture evidence, not universal agent-output proof. They do not demonstrate patch quality or exact billed-token savings. Paired Codex and Claude evaluation remains a later release gate.
