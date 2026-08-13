# Limitations

TokenGraph does not guarantee correctness. It does not replace code review.

Every TokenGraph v0.23.1 MCP and CLI process must be stopped before v2 activation and must not be restarted while v2 runs. The compatibility barrier is defense in depth against stale files and accidental downgrade attempts; concurrent mixed-runtime operation is unsupported.

Native addons support Windows 10/Server 2016 x64, Windows 10 arm64, macOS 11 or newer on x64/arm64, and glibc Linux x64/arm64 with kernel 4.18 and glibc 2.28 or newer. Linux musl and every unlisted target are unsupported and fail closed. There is no runtime download, native compilation, sidecar, network lookup, or JavaScript lock fallback.

Native locking is a cooperative local-filesystem boundary, not a distributed lock or defense against an actively malicious same-account process. Network filesystems remain best effort. Integrity validation detects corruption and accidental replacement but cannot protect against an attacker who can replace both addon and manifest during startup.

Private addon staging cleanup is bounded: at most 32 oldest matching roots are inspected, and only a definitely dead PID with exact marker, target, hash, type, identity, and entry-set evidence is removed. Ambiguous or live state is preserved. A Windows crash may therefore leave a single process-owned staging root until a later safe cleanup or manual inspection.

SQL parsing is not business understanding. Memory can become stale. Token savings are estimates.

Compression can omit low-priority details, so TokenGraph should recommend targeted raw reads when confidence is low or when security, migration, public API, or failure details matter.

The benchmark's primary release gate is execution-inclusive. The current checked-in fixture run passes it with a +172.5-token activated-task median, +38.5-token p25, and 81.5% non-negative activated tasks. Four tasks charge one hash-validated exact source slice each, totaling 711 estimated tokens. This remains synthetic single-fixture evidence. The reviewed schema-v3 real-host campaign covers TokenGraph, `mattpocock/ts-reset`, and `imbhargav5/nextbase-nextjs-supabase-starter`: 15 counterbalanced ON/OFF pairs and 30 accepted traces across three repositories and three categories. The multi-repository coverage target is met, and quality non-inferiority and Stage 0 latency pass, but minimum category samples, token superiority, resource limits, complete router-rate denominators, execution p25, and the 80% non-negative threshold do not all pass; two reports also have a negative execution median. Routing enforcement therefore remains disabled. B7 polyglot parsing is independently enabled by default and can be disabled per project with `parser.polyglotEnabled: false`; it is not a routing-promotion signal. Small bounded tasks can still cost more tokens than raw reads and should bypass TokenGraph at Stage 0.

TokenGraph is not a clinical, legal, or regulated-domain decision system.

Lifecycle hooks are cooperative host automation, not a security boundary. Hosts may leave hooks disabled or untrusted, and abnormal endings such as user interrupts, StopFailure, process termination, or API failure do not run normal completion enforcement. Missing or corrupt hook state fails open with a warning; users must call `tokengraph_task_report` explicitly when enforcement is unavailable.

Lifecycle attestation and plugin-data hook state do not grant native-lock activation. Managed hooks remain permanently unactivated and project-read-only.

Hook state lives in host plugin data, while repository state remains under `.tokengraph`. The full compatibility surface applies its description patch only after the eight default intent tools are registered. Unsupported source-language exclusions are counted in the project map instead of being silently treated as indexed files.

On POSIX hosts TokenGraph keeps its own state directories under `.tokengraph` at mode 0700. The one exception is the `git-info` lock domain inside the user's Git directory: TokenGraph never changes the permissions of `.git/info`, so when Git created it group- or world-readable, the lock metadata stored there (process id, nonce, timestamps) is readable by other local accounts. It is never writable by them, a writable directory is refused outright, and no project content is exposed.

Releases from v0.20 onward include `dist/hooks.js` and `hooks/hooks.json`, but installation does not imply trust. Disabled or untrusted hooks, user interrupts, StopFailure, process termination, and API failure remain outside normal completion enforcement.
