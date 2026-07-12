# Limitations

TokenGraph does not guarantee correctness. It does not replace code review.

SQL parsing is not business understanding. Memory can become stale. Token savings are estimates.

Compression can omit low-priority details, so TokenGraph should recommend targeted raw reads when confidence is low or when security, migration, public API, or failure details matter.

TokenGraph is not a clinical, legal, or regulated-domain decision system.

Lifecycle hooks are cooperative host automation, not a security boundary. Hosts may leave hooks disabled or untrusted, and abnormal endings such as user interrupts, StopFailure, process termination, or API failure do not run normal completion enforcement. Missing or corrupt hook state fails open with a warning; users must call `tokengraph_task_report` explicitly when enforcement is unavailable.

Phase 3 adds `dist/hooks.js` and `hooks/hooks.json` to source builds and newly generated default package artifacts. The committed v0.19 `release/tokengraph/` snapshot remains temporarily accepted without those two files so dependent phases do not regenerate release output early. Phase 5 must regenerate the committed release and remove this transition allowance.
