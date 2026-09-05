import { resolve } from "node:path";

import { canonicalPersistenceLock } from "./lockDomain.js";
import { discardBufferedMemoryUses, flushBufferedMemoryUses } from "./memoryStore.js";
import { repositoryMemoryPath } from "./persistence.js";
import { flushWriteTelemetry } from "./storage.js";
import { loadTaskLedger } from "./taskLedger.js";

export type TaskWriteFlushWarning = "memory-use-flush-failed" | "write-telemetry-flush-failed";
const taskLifecycleChains = new Map<string, Promise<void>>();

/** Serializes in-process recalls and reporting for the same task, not other tasks. */
export async function withTaskWriteLifecycle<T>(root: string, taskId: string, operation: () => Promise<T>): Promise<T> {
  const canonicalRoot = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const key = `${canonicalRoot}\u0000${taskId}`;
  const previous = taskLifecycleChains.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(() => undefined, () => undefined);
  taskLifecycleChains.set(key, settled);
  try { return await current; }
  finally { if (taskLifecycleChains.get(key) === settled) taskLifecycleChains.delete(key); }
}

export async function discardTaskMemoryUses(root: string, taskId: string): Promise<void> {
  const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
  discardBufferedMemoryUses(lock, taskId);
}

/**
 * Flushes one task's deferred, correctness-neutral writes. Memory must settle
 * first because that durable write is itself part of the telemetry snapshot.
 * Each failure is isolated so both bounded warning codes can be reported.
 */
export async function flushTaskReportWrites(root: string, taskId: string): Promise<TaskWriteFlushWarning[]> {
  const warnings: TaskWriteFlushWarning[] = [];
  try {
    const ledger = await loadTaskLedger(root, taskId);
    const deferredMemoryUseDigests = [...new Set(ledger?.events.flatMap((event) => event.deferredMemoryUseDigests ?? []) ?? [])];
    const settledAfter = ledger?.pausedAt ?? ledger?.completedAt ?? ledger?.updatedAt;
    const path = await repositoryMemoryPath(root);
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    await flushBufferedMemoryUses(path, lock, taskId, {
      telemetry: { root, storageClass: "durable" },
      additionalDigests: deferredMemoryUseDigests,
      ...(settledAfter ? { settledAfter } : {})
    });
  } catch {
    warnings.push("memory-use-flush-failed");
  }
  try {
    await flushWriteTelemetry(root);
  } catch {
    warnings.push("write-telemetry-flush-failed");
  }
  return warnings;
}
