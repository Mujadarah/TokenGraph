# Privacy

TokenGraph is local-first. It stores project state under `.tokengraph/` in the indexed workspace.

TokenGraph does not require an OpenAI API key. It does not require cloud sync. It does not require embeddings service. It does not add telemetry.

For automatic Codex workspace setup, the lifecycle hook stores only schema/version, SHA-256 plugin and session hashes, the host-provided workspace root, and a timestamp under the operating-system temporary directory. The record expires after 24 hours, is refreshed on prompts, and is removed on normal session end. It does not store the raw session id, prompts, transcripts, tool inputs, or tool responses.

TokenGraph respects .gitignore, excludes secrets by default, and excludes dependency folders and build output by default.

Runner secret redaction is best effort and not a guarantee. Saved captures are JSON under `.tokengraph/runs/` in the active worktree and are stored as plaintext. TokenGraph has no always-on process capture. To avoid capture entirely, do not invoke `tokengraph run`; use normal host execution instead.

Regulated or highly sensitive output should not pass through the runner. Storage is not encrypted today. The isolated storage interfaces and write boundaries permit future optional local encryption, but TokenGraph does not provide local encryption today.
