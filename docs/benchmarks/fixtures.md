# Benchmark Fixtures

The evidence benchmark uses `plugins/tokengraph/tests/fixtures/evidence-project`. The fixture includes route, component, service, test, authorization, audit, compression, memory, PostgreSQL RLS, documentation, smoke, validation, and packaging artifacts.

Expected routing and quality evidence lives in the versioned corpus rather than in executable fixture code. Each task records required files, applicable forbidden false positives, expected tests, critical constraints, and its targeted-raw-read policy. The benchmark indexes the fixture and exercises real TokenGraph core functions; it does not manufacture repeated records from one constant metric template.

Fixture content is synthetic, deterministic, local, and free of machine paths or secrets. It is evidence for regression testing only. It is not representative of every repository or proof of autonomous agent behavior.
