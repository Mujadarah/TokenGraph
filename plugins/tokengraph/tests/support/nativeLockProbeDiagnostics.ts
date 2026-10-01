import type { ChildProcess } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalPersistenceLock, LOCK_DOMAINS, type LockDomain } from "../../src/core/lockDomain.js";

export function legacyWorkerFailureMessage(stderr: string): string {
  return JSON.stringify({ stderr: { bytes: Buffer.byteLength(stderr), content: "omitted" } });
}

export interface ProbeDiagnosticRequest {
  workspaceRoot: string;
  coordinationRoot: string;
  domain: string;
  key: string;
  operation: string;
  timeoutMs: number;
  holdMs?: number;
  clockOffsetMs?: number;
  cancelMs?: number;
  activate?: boolean;
  failOperation?: boolean;
  exerciseKeyCount?: number;
  pauseAt?: string;
  pauseState?: string;
  pauseOccurrence?: number;
}

export interface ProbeDiagnosticContext {
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;
  request: ProbeDiagnosticRequest;
  startedAt: number;
  records: () => readonly { status: string }[];
  stderr: () => string;
  cut?: { index: number; stage: "pause" | "recovery"; pause?: Pick<ProbeDiagnosticRequest, "pauseAt" | "pauseState" | "pauseOccurrence" | "holdMs"> };
}

const phases = ["idle", "intent", "barrier-created", "lease-created", "cleanup"];
const pauseStates = [...phases, "pending-barrier", "barrier-identity", "pending-lease-create", "temporary-lease-create",
  "pending-lease-replace", "temporary-lease-replace", "temporary-identity", "lease-finalized", "heartbeat",
  "cleanup-with-lease", "cleanup-barrier-only"];
const pausePoints = ["after-barrier-create", "after-barrier-remove", "after-journal-state",
  ...["journal", "lease"].flatMap((kind) => ["create", "write", "sync", "parent-flush", "rename", "rename-parent-flush"].map((point) => `after-${kind}-${point}`))];
const statuses = ["acquired", "released", "paused", "operation-complete", "error", "PROBE_OPERATION_FAILURE",
  "LOCK_TIMEOUT", "LOCK_ABORTED", "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED", "INVALID_PERSISTENCE_LOCK",
  "LEGACY_LOCK_BLOCKED", "UNSAFE_LOCK_DIRECTORY", "LOCK_JOURNAL_UNSAFE", "LOCK_LEASE_OCCUPIED"];
const allow = (value: unknown, allowed: readonly string[]): string | undefined =>
  typeof value === "string" ? (allowed.includes(value) ? value : "redacted") : undefined;
const integer = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const identity = (stats: BigIntStats): string => `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;

function pauseSummary(request: Pick<ProbeDiagnosticRequest, "pauseAt" | "pauseState" | "pauseOccurrence" | "holdMs">): object {
  return { pauseAt: allow(request.pauseAt, pausePoints), pauseState: allow(request.pauseState, pauseStates),
    pauseOccurrence: integer(request.pauseOccurrence), holdMs: integer(request.holdMs) };
}

// Only numeric/boolean fields and fixed protocol labels reach public CI output.
// Neither stderr text, filesystem identities, paths, nor journal payloads are printed.
export function probeDiagnosticMetadata(context: ProbeDiagnosticContext): object {
  const { child, request } = context;
  const records = context.records();
  return {
    request: { operation: allow(request.operation, ["hold", "try", "native-try", "crash", "release"]),
      domain: allow(request.domain, LOCK_DOMAINS), key: allow(request.key, ["config.json", "routing.json", "run.json", "key-0.json", "exclude"]),
      timeoutMs: integer(request.timeoutMs), clockOffsetMs: integer(request.clockOffsetMs), cancelMs: integer(request.cancelMs),
      activate: typeof request.activate === "boolean" ? request.activate : undefined,
      failOperation: typeof request.failOperation === "boolean" ? request.failOperation : undefined,
      exerciseKeyCount: integer(request.exerciseKeyCount), ...pauseSummary(request) },
    cut: context.cut === undefined ? undefined : { index: integer(context.cut.index),
      stage: allow(context.cut.stage, ["pause", "recovery"]),
      ...(context.cut.pause === undefined ? {} : { pause: pauseSummary(context.cut.pause) }) },
    pid: child.pid ?? null,
    lifecycle: child.exitCode !== null || child.signalCode !== null ? "exited" : "live",
    exitCode: child.exitCode, signal: allow(child.signalCode, ["SIGKILL", "SIGTERM", "SIGABRT", "SIGINT"]) ?? null,
    watchdog: child.exitCode === 124 ? "exit-124" : "not-observed",
    elapsedMs: Math.max(0, Math.round(performance.now() - context.startedAt)),
    lastStatus: allow(records.at(-1)?.status, statuses) ?? "not-observed",
    recordCount: records.length,
    stderr: { bytes: Buffer.byteLength(context.stderr()), content: "omitted" }
  };
}

interface StateSummary {
  state: string;
  phase?: string;
  schemaVersion?: number;
  generation?: number;
  pid?: number;
  barrierIdentityRecorded?: boolean;
  leaseIdentityRecorded?: boolean;
  pendingBarrier?: boolean;
  pendingLeaseWrite?: string;
  temporaryIdentityRecorded?: boolean;
}

// Check every parent before/after the bounded read. Refuse links and multi-link files.
// Observations are diagnostic only: they never authorize recovery or validate ownership.
async function readState(path: string, maximumBytes: number, active: () => boolean): Promise<StateSummary> {
  try {
    const parents: Array<{ path: string; identity: string }> = [];
    let parent = dirname(resolve(path));
    for (;;) {
      if (!active()) return { state: "capture-deadline" };
      const stats = await lstat(parent, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink()) return { state: "unsafe" };
      parents.push({ path: parent, identity: identity(stats) });
      if (parent === parse(parent).root) break;
      parent = dirname(parent);
    }
    if (!active()) return { state: "capture-deadline" };
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return { state: "unsafe" };
    if (before.size > BigInt(maximumBytes)) return { state: "oversized" };
    if (!active()) return { state: "capture-deadline" };
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || identity(opened) !== identity(before)) return { state: "changed" };
      if (!active()) return { state: "capture-deadline" };
      const bytes = Buffer.alloc(maximumBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maximumBytes) return { state: "oversized" };
      if (!active()) return { state: "capture-deadline" };
      const after = await handle.stat({ bigint: true });
      const entry = await lstat(path, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || identity(entry) !== identity(opened) ||
          identity(after) !== identity(opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
        return { state: "changed" };
      }
      for (const parentEntry of parents) {
        if (!active()) return { state: "capture-deadline" };
        const stats = await lstat(parentEntry.path, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink() || identity(stats) !== parentEntry.identity) return { state: "changed" };
      }
      const value = object(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
      return { state: "observed", schemaVersion: integer(value.schemaVersion), generation: integer(value.generation),
        phase: allow(value.phase, phases), pid: integer(value.pid),
        barrierIdentityRecorded: typeof value.barrierIdentity === "string", leaseIdentityRecorded: typeof value.leaseIdentity === "string",
        pendingBarrier: value.pendingBarrier !== undefined, pendingLeaseWrite: allow(object(value.pendingLeaseWrite).operation, ["create", "replace"]),
        temporaryIdentityRecorded: typeof object(value.pendingLeaseWrite).temporaryIdentity === "string" };
    } finally { await handle.close(); }
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid-json" : "unavailable" };
  }
}

interface Snapshot { journal: StateSummary; journalTemporary: StateSummary; lease: StateSummary; leaseTemporary: StateSummary; barrier: { state: string } }

export async function captureProbeDiagnostic(context: ProbeDiagnosticContext): Promise<object> {
  // Freeze lifecycle/time at the failure decision, before any diagnostic I/O.
  const details = probeDiagnosticMetadata(context);
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable: Snapshot = { journal: { state: "capture-deadline" }, journalTemporary: { state: "capture-deadline" },
    lease: { state: "capture-deadline" }, leaseTemporary: { state: "capture-deadline" }, barrier: { state: "capture-deadline" } };
  const snapshot = (async (): Promise<Snapshot> => {
    try {
      const lock = await canonicalPersistenceLock(context.request.workspaceRoot, context.request.domain as LockDomain, context.request.key);
      if (!active) return unavailable;
      const lease = join(lock.compatibilityPath, "lease.json");
      const [journal, journalTemporary, leaseState, leaseTemporary, barrier] = await Promise.all([
        readState(lock.journalPath, 8_192, () => active), readState(`${lock.journalPath}.tokengraph-write-v2.tmp`, 8_192, () => active),
        readState(lease, 4_096, () => active), readState(`${lease}.tokengraph-write-v2.tmp`, 4_096, () => active),
        lstat(lock.compatibilityPath).then((stats) => ({ state: stats.isSymbolicLink() ? "unsafe" : stats.isDirectory() ? "directory" : "other" }),
          (error: NodeJS.ErrnoException) => ({ state: error.code === "ENOENT" ? "missing" : "unavailable" }))
      ]);
      return { journal, journalTemporary, lease: leaseState, leaseTemporary, barrier };
    } catch { return { journal: { state: "unavailable" }, journalTemporary: { state: "unavailable" },
      lease: { state: "unavailable" }, leaseTemporary: { state: "unavailable" }, barrier: { state: "unavailable" } }; }
  })();
  try {
    // This bounds failure reporting only; no child/test deadline is changed.
    const state = await Promise.race([snapshot, new Promise<Snapshot>((done) => {
      timer = setTimeout(() => { active = false; done(unavailable); }, 250);
    })]);
    const latestJournal = (state.journal.generation ?? -1) > (state.journalTemporary.generation ?? -1) ? state.journal : state.journalTemporary;
    return { ...details, lastObservedPhase: latestJournal.phase ?? state.journal.phase ?? "not-observed",
      observation: "best-effort-after-failure", ...state };
  } finally { active = false; clearTimeout(timer); }
}

export async function probeFailure(message: string, contexts: readonly ProbeDiagnosticContext[]): Promise<Error> {
  try {
    const diagnostics = await Promise.all(contexts.map(captureProbeDiagnostic));
    return new Error(`${message} native-lock-probes=${JSON.stringify(diagnostics)}`);
  } catch {
    // A diagnostic must never mask the original failure or strand its waiter.
    return new Error(`${message} native-lock-probes=unavailable`);
  }
}

// Polling, success conditions and deadlines are unchanged; only failure reporting differs.
export async function waitForProbeExists(
  path: string, timeoutMs = 2_000, contexts?: () => readonly ProbeDiagnosticContext[]
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw await probeFailure("Timed out waiting for native lock probe state.", contexts?.() ?? []);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

export async function waitForProbeStatus(
  records: readonly { status: string }[], status: string, timeoutMs: number, context?: ProbeDiagnosticContext
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!records.some((record) => record.status === status)) {
    if (Date.now() >= deadline) throw await probeFailure(`Timed out waiting for probe status ${allow(status, statuses)}.`, context === undefined ? [] : [context]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}
