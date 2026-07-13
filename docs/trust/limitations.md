# Limitations

TokenGraph does not guarantee correctness. It does not replace code review.

SQL parsing is not business understanding. Memory can become stale. Token savings are estimates.

Compression can omit low-priority details, so TokenGraph should recommend targeted raw reads when confidence is low or when security, migration, public API, or failure details matter.

TokenGraph is not a clinical, legal, or regulated-domain decision system.

Lifecycle hooks are cooperative host automation, not a security boundary. Hosts may leave hooks disabled or untrusted, and abnormal endings such as user interrupts, StopFailure, process termination, or API failure do not run normal completion enforcement. Missing or corrupt hook state fails open with a warning; users must call `tokengraph_task_report` explicitly when enforcement is unavailable.

The v0.20 release includes `dist/hooks.js` and `hooks/hooks.json`, but installation does not imply trust. Disabled or untrusted hooks, user interrupts, StopFailure, process termination, and API failure remain outside normal completion enforcement.
