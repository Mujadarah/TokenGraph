# Privacy

TokenGraph is local-first. It stores project state under `.tokengraph/` in the indexed workspace.

TokenGraph does not require an OpenAI API key. It does not require cloud sync. It does not require embeddings service. It does not add telemetry.

TokenGraph respects .gitignore, excludes secrets by default, and excludes dependency folders and build output by default.

Runner secret redaction is best effort and not a guarantee. Saved captures are JSON under `.tokengraph/runs/` in the active worktree and are stored as plaintext. TokenGraph has no always-on process capture. To avoid capture entirely, do not invoke `tokengraph run`; use normal host execution instead.

Regulated or highly sensitive output should not pass through the runner. Storage is not encrypted today. The isolated storage interfaces and write boundaries permit future optional local encryption, but TokenGraph does not provide local encryption today.
