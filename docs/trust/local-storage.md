# Local Storage

TokenGraph stores project state under `.tokengraph/` in the indexed workspace.

Stored state can include indexes, config, wiki manifests, memory, architecture rules, token event records, and benchmark run records. Token savings are estimates.

Users can delete indexes and memories. Memory can become stale, deprecated, or deleted. Deprecated memories are excluded from normal recall, and deleted memories require explicit audit mode.
