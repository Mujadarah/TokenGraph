# Benchmark Fixtures

The evidence benchmark uses `plugins/tokengraph/tests/fixtures/evidence-project`. The fixture includes route, component, service, test, authorization, audit, compression, memory, PostgreSQL RLS, documentation, smoke, validation, and packaging artifacts.

Scoring labels live in the versioned corpus. Independent raw-baseline files, durable memories, and expected-net observations live in `plugins/tokengraph/scripts/benchmark-evidence-v1.json`. The evaluator never builds memories, planner context, compressor text, tracer logs, risk inputs, or wiki inputs from required files, critical constraints, expected tests, or forbidden-file labels.

Each task's raw baseline contains only the independently selected relevant fixture files, not the whole fixture. Every referenced baseline file must exist. A required scoring file that is absent from a core flow's selected output remains an explicit false negative and fails the corresponding release-gate condition.

Fixture content is synthetic, deterministic, local, and free of machine paths or secrets. It is evidence for regression testing only. It is not representative of every repository or proof of autonomous agent behavior.
