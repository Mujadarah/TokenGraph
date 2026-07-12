# Current Benchmark Results

Run the deterministic evidence benchmark from `plugins/tokengraph`:

```powershell
pnpm benchmark -- --json
```

The current checked-in corpus and fixture produce:

- Corpus: `evidence-v1`.
- Tasks: 30.
- Category counts: code routing 5, SQL/security 5, debugging 4, change risk 4, compression 4, memory/wiki 4, release packaging 4.
- Critical-constraint preservation: 100%.
- Critical false negatives: 0.
- Required-file recall: 1.0 against the checked-in 0.85 baseline.
- Median net estimated savings: 925 tokens after compact, tool, and footer overhead.
- Deterministic release gate: pass.
- Task failures: 11. Ten include forbidden-file false positives exposed by broad lexical matches or import closure; two identify a missing expected test recommendation, with one task reporting both conditions.

Calibration entries contain four or five observations per category. Every category is therefore low-confidence; the benchmark does not claim statistical confidence from these samples.

These results are deterministic fixture evidence, not universal agent-output proof. They do not demonstrate patch quality or exact billed-token savings. Paired Codex and Claude evaluation remains a later release gate.
