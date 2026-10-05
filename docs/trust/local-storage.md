# Local Storage

TokenGraph stores project state under `.tokengraph/` in the indexed workspace.

Stored state can include indexes, config, wiki manifests, memory, architecture rules, token event records, benchmark run records, local write aggregates, and stable retrieval or change-capsule artifacts. Every opened workspace owns its own `.tokengraph/` directory, including `.tokengraph/repository/`; no active state is written to a shared `.git/tokengraph` directory. A one-time migration copies valid legacy JSON records into the workspace directory, lets existing workspace records win conflicts, writes a migration manifest, and leaves the legacy files in place as a recoverable backup. Token savings are estimates.

Stable artifacts are content-addressed JSON under `.tokengraph/repository/artifacts/`. A change capsule can include bounded target-revision source slices selected for the requested local Git change. Write-amplification aggregates are retained for at most 14 days under `.tokengraph/telemetry/` and contain aggregate dates, storage classes, operation counts, byte counts, and sampled process RSS rather than paths or content.

Current indexes are immutable schema-v5 generation files selected by `.index-manifest.json`. Publication durably writes and validates a generation before atomically replacing the manifest; earlier validated generations remain available for bounded recovery and later pruning. A valid legacy schema-v4 `index.json` remains readable and is promoted to the generation format only by a later activated writer. Newer or malformed schemas are refused rather than overwritten.

Lifecycle pointer data is kept under the host-provided plugin data directory, not in the repository: only a session hash, task id, turn id, schema/version, and timestamp are retained. The trusted root is stored separately in a short-lived operating-system temporary-directory workspace attestation with plugin/session hashes, schema/version, and timestamp. Prompts, transcripts, environment values, and tool payloads are not stored.

The default eight tools use compact task-aware envelopes; query, recall, compression, and analysis results identify their mode, while preparation returns the task id and plan directly. Compatibility tools are registered only on the opt-in full surface. The indexer parses TypeScript, JavaScript, JSX/TSX, SQL, Markdown, MDX, Python, Go, Rust, and Java with bounded local parsers. Set `parser.polyglotEnabled` to `false` for a project-local kill switch. Other extensions are excluded and reported as `unsupportedLanguages` in project counts so omission is visible.

When no host workspace root is injected, TokenGraph may use the process working directory only when launched outside the plugin root; launching from the plugin root remains blocked until the host supplies an explicit trusted workspace.

## Deterministic serialization

In canonical persisted artifacts, an omitted field means the value is unknown. A JSON `null` means the value is known to be absent. Undefined values are never emitted.

Users can delete indexes and memories. Memory can become stale, deprecated, or deleted. Deprecated memories are excluded from normal recall, and deleted memories require explicit audit mode.
