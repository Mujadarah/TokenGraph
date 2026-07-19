# Limitations

TokenGraph does not guarantee correctness. It does not replace code review.

SQL parsing is not business understanding. Memory can become stale. Token savings are estimates.

Compression can omit low-priority details, so TokenGraph should recommend targeted raw reads when confidence is low or when security, migration, public API, or failure details matter.

The benchmark's primary release gate is execution-inclusive. As of v0.21.1 the checked-in fixture run passes it (+196.5-token activated-task median, +102.5-token p25, 82.1% non-negative activated tasks), but this remains synthetic single-fixture evidence: downstream exact-slice reads are charged only on tasks that declare an unresolved evidence gap (none in the current corpus do), and no paired real-host evaluation has run yet. Small self-contained tasks can still cost more tokens than bounded raw reads; the routing advisor's bypass exists for exactly those cases, and agents should still skip TokenGraph intents for tiny self-contained work.

TokenGraph is not a clinical, legal, or regulated-domain decision system.

Lifecycle hooks are cooperative host automation, not a security boundary. Hosts may leave hooks disabled or untrusted, and abnormal endings such as user interrupts, StopFailure, process termination, or API failure do not run normal completion enforcement. Missing or corrupt hook state fails open with a warning; users must call `tokengraph_task_report` explicitly when enforcement is unavailable.

Hook state lives in host plugin data, while repository state remains under `.tokengraph`. The full compatibility surface applies its description patch only after the eight default intent tools are registered. Unsupported source-language exclusions are counted in the project map instead of being silently treated as indexed files.

Releases from v0.20 onward include `dist/hooks.js` and `hooks/hooks.json`, but installation does not imply trust. Disabled or untrusted hooks, user interrupts, StopFailure, process termination, and API failure remain outside normal completion enforcement.
