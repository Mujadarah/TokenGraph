# Phase 6 deferred-write settlement

Status: implementation decision; execution evidence deferred by the maintainer.

The low-write policy buffers correctness-neutral memory usage timestamps until
task reporting. The original implementation could accept a recall concurrently
with terminal reporting, or retain a failed pause flush that no public call could
retry. This note defines the lifecycle boundary without changing durable ledger
outcomes, hook behavior, or native activation.

- In one MCP server, task intent operations and task reporting use the same
  task-keyed promise queue. The ledger is checked again inside that queue.
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

Process termination can lose the process's unflushed telemetry and minimal
usage timestamps. Correctness-critical state remains immediate. These counters
and timestamps are not a durable event journal, and task buffering is local to
the MCP process that received the recall.

Required deferred contracts: overflow after a real atomic write; mixed physical
byte completeness in both orders and across flushes; migration/update race;
failed pause flush retry; failed auto-start cleanup; overlapping recall/report;
and review-mode nonmutation. No RED or GREEN execution is claimed here.
