# Benchmark Fixtures

The current benchmark harness uses the local `plugins/tokengraph/tests/fixtures/next-supabase` fixture.

This fixture is used for:

- Code graph routing.
- SQL graph routing.
- Wiki orientation.
- Root cause debugging.
- Regression risk.
- Architecture checks.

Synthetic benchmark inputs are used for log compression, memory recall, and release packaging validation when the fixture does not naturally contain those artifacts.

Future fixture additions should include expected relevant files, expected missed files, recommended tests, and known failure cases so benchmark results can report false positives and false negatives honestly.
