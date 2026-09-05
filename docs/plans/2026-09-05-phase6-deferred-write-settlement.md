# Phase 6 deferred-write settlement

Status: implementation decision; execution evidence deferred by the maintainer.

The low-write policy buffers correctness-neutral memory usage timestamps until
task reporting. The original implementation could accept a recall concurrently
with terminal reporting, or retain a failed pause flush that no public call could
retry. This note defines the lifecycle boundary without changing durable ledger
outcomes, hook behavior, or native activation.

- In one MCP server, task intent operations and task reporting use the same
  task-keyed promise queue. The ledger is checked again inside that queue.
- Process-local queues alone cannot settle a recall when a different MCP
  process completes the task. The strict task event therefore carries an
  optional, deduplicated `deferredMemoryUseIds` field, limited to 100 UUIDs.
  This is an additive schema-v3 event field: older events remain valid, unknown
  fields remain rejected, and the native rollout already requires every older
  TokenGraph process to be stopped before activation. The reporting process
  unions these ids with any local buffer and performs one memory-store write.
  No prompt, query, title, body, path, or other memory content is persisted.
- A repeated pause settles only ids whose stored `lastUsedAt` predates the
  terminal ledger timestamp, so retrying a successful report does not create a
  second memory-store write. A failed settlement restores the union to the
  reporting process's bounded local buffer for retry.
- Reporting waits for an earlier recall to finish. A later recall sees the
  terminal ledger and is rejected before it can buffer another use.
- Repeating the same pause report is idempotent: it does not rewrite the paused
  ledger, add events, or reopen the task. It may retry its existing deferred
  writes and returns the existing paused status. Completion after pause remains
  refused. Ordinary task calls remain refused after pause or completion.
- A failed auto-started intent discards its own deferred usage before removing
  an empty ledger. Unrelated tasks' buffers are unaffected.
- Review mode does not record memory usage. Recall mode records the active
  memories selected for delivery. Legacy calls without a task use balanced
  daily coalescing at the call boundary, including under minimal policy.
- Memory flushing precedes the telemetry snapshot; each failure remains a
  bounded warning, and neither failure suppresses the durable report/footer.

Telemetry counts are exact BigInts in process. Numeric schema-v1 persistence
continues to require safe integers. Overflow at serialization or cross-process
merge refuses persistence and retains the exact pending counters; an already
committed data write is not turned into a failed operation by numeric overflow.
Unknown physical bytes propagate as omission through an aggregate. The field
exists only when every contributing observation has a measured value.

Config migration rereads and normalizes the current bytes while holding the
workspace-state lock, backs up only the version actually replaced, and skips
replacement if another writer already completed migration.

Process termination can lose unflushed telemetry. Minimal usage timestamps are
reconstructable from the bounded task event by any reporting process; a recall
that loses its process before its already-required event write may still lose
that correctness-neutral observation. Correctness-critical state remains
immediate, and telemetry counters are not a durable event journal.

Required deferred contracts: overflow after a real atomic write; mixed physical
byte completeness in both orders and across flushes; migration/update race;
failed pause flush retry; failed auto-start cleanup; overlapping recall/report;
and review-mode nonmutation. No RED or GREEN execution is claimed here.
