import { canonicalPersistenceLock } from "./lockDomain.js";
import { flushBufferedMemoryUses } from "./memoryStore.js";
import { repositoryMemoryPath } from "./persistence.js";
import { flushWriteTelemetry } from "./storage.js";

export type TaskWriteFlushWarning = "memory-use-flush-failed" | "write-telemetry-flush-failed";

/**
 * Flushes one task's deferred, correctness-neutral writes. Memory must settle
 * first because that durable write is itself part of the telemetry snapshot.
 * Each failure is isolated so both bounded warning codes can be reported.
 */
export async function flushTaskReportWrites(root: string, taskId: string): Promise<TaskWriteFlushWarning[]> {
  const warnings: TaskWriteFlushWarning[] = [];
  try {
    const path = await repositoryMemoryPath(root);
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    await flushBufferedMemoryUses(path, lock, taskId, { telemetry: { root, storageClass: "durable" } });
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
