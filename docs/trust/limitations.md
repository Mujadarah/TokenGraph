# Limitations

TokenGraph does not guarantee correctness. It does not replace code review.

SQL parsing is not business understanding. Memory can become stale. Token savings are estimates.

Compression can omit low-priority details, so TokenGraph should recommend targeted raw reads when confidence is low or when security, migration, public API, or failure details matter.

The benchmark's primary release gate is execution-inclusive. The current checked-in fixture run passes it with a +174.5-token activated-task median, +40.5-token p25, and 81.5% non-negative activated tasks. Four tasks charge one hash-validated exact source slice each, totaling 711 estimated tokens. This remains synthetic single-fixture evidence. The first real-host evaluation ran five paired ON/OFF trials in one repository, but it did not pass every frozen promotion gate. Enforcement therefore remains disabled pending eligible reviewed schema-v3 evidence. Small bounded tasks can still cost more tokens than raw reads and should bypass TokenGraph at Stage 0.

TokenGraph is not a clinical, legal, or regulated-domain decision system.

Lifecycle hooks are cooperative host automation, not a security boundary. Hosts may leave hooks disabled or untrusted, and abnormal endings such as user interrupts, StopFailure, process termination, or API failure do not run normal completion enforcement. Missing or corrupt hook state fails open with a warning; users must call `tokengraph_task_report` explicitly when enforcement is unavailable.

Hook state lives in host plugin data, while repository state remains under `.tokengraph`. The full compatibility surface applies its description patch only after the eight default intent tools are registered. Unsupported source-language exclusions are counted in the project map instead of being silently treated as indexed files.

Releases from v0.20 onward include `dist/hooks.js` and `hooks/hooks.json`, but installation does not imply trust. Disabled or untrusted hooks, user interrupts, StopFailure, process termination, and API failure remain outside normal completion enforcement.
