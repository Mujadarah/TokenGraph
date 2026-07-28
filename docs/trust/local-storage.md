# Local Storage

TokenGraph stores project state under `.tokengraph/` in the indexed workspace.

Stored state can include indexes, config, wiki manifests, memory, architecture rules, token event records, and benchmark run records. Every opened workspace owns its own `.tokengraph/` directory, including `.tokengraph/repository/`; no active state is written to a shared `.git/tokengraph` directory. A one-time migration copies valid legacy JSON records into the workspace directory, lets existing workspace records win conflicts, writes a migration manifest, and leaves the legacy files in place as a recoverable backup. Token savings are estimates.

Lifecycle hook data is kept under the host-provided plugin data directory, not in the repository: only a session hash, task id, trusted root, turn id, schema/version, and timestamp are retained. Prompts, transcripts, environment values, and tool payloads are not stored.

The default eight tools use compact mode envelopes with an explicit `mode` and `result`; compatibility tools are registered only on the opt-in full surface. The indexer parses TypeScript, JavaScript, JSX/TSX, SQL, Markdown, MDX, Python, Go, Rust, and Java with bounded local parsers. Set `parser.polyglotEnabled` to `false` for a project-local kill switch. Other extensions are excluded and reported as `unsupportedLanguages` in project counts so omission is visible.

When no host workspace root is injected, TokenGraph may use the process working directory only when launched outside the plugin root; launching from the plugin root remains blocked until the host supplies an explicit trusted workspace.

## Deterministic serialization

In canonical persisted artifacts, an omitted field means the value is unknown. A JSON `null` means the value is known to be absent. Undefined values are never emitted.

Users can delete indexes and memories. Memory can become stale, deprecated, or deleted. Deprecated memories are excluded from normal recall, and deleted memories require explicit audit mode.
