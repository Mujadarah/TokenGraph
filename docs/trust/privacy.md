# Privacy

TokenGraph is local-first. It stores project state under `.tokengraph/` in the indexed workspace.

TokenGraph does not require an OpenAI API key, cloud sync, or an embeddings service, and it sends no telemetry to a remote service. It keeps at most 14 days of local write-amplification aggregates in `.tokengraph/telemetry/write-aggregates.json`. Those aggregates contain only UTC dates, storage classes, logical persistence-operation counts, logical payload bytes, optional measured physical-write bytes, and sampled process RSS. One index generation plus its manifest is one logical publication operation even though the protocol durably writes two files. TokenGraph leaves physical-write bytes absent when the runtime cannot measure them; filesystem allocation is not reported as I/O. The aggregates contain no paths, prompts, command text, secrets, file contents, or per-file event stream.

The selected native addon is integrity-checked and copied into one fresh private operating-system temporary directory before loading. The staging marker contains bounded target, process, and hash metadata, never project content. POSIX removes proven staging state after load. Windows may retain at most one process-owned staging root until exit; later bounded dead-process cleanup preserves ambiguous state.

For automatic Codex workspace setup, the lifecycle hook stores only schema/version, SHA-256 plugin and session hashes, the host-provided workspace root, and a timestamp under the operating-system temporary directory. The record expires after 24 hours, is refreshed on prompts, and is removed on normal session end. It does not store the raw session id, prompts, transcripts, tool inputs, or tool responses.

Hook attestation and plugin-data pointers do not grant native-lock activation. Managed hook processes remain permanently unactivated and project-read-only.

TokenGraph respects .gitignore, excludes secrets by default, and excludes dependency folders and build output by default.

When local change analysis is requested, a stable change capsule may contain repository-relative paths, content hashes, symbols, risks, and bounded exact source slices from the selected target revision. Capsules stay under `.tokengraph/repository/artifacts/` in the trusted workspace. Pull-request-shaped input means local base and head refs only: TokenGraph does not contact a forge, fetch refs, or upload capsule content.

Runner secret redaction is best effort and not a guarantee. Saved captures are JSON under `.tokengraph/runs/` in the active worktree and are stored as plaintext. TokenGraph has no always-on process capture. To avoid capture entirely, do not invoke `tokengraph run`; use normal host execution instead.

Regulated or highly sensitive output should not pass through the runner. Storage is not encrypted today. The isolated storage interfaces and write boundaries permit future optional local encryption, but TokenGraph does not provide local encryption today.
