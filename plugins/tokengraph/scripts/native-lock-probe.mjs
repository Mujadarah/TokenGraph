#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const INPUT_LIMIT = 8 * 1024;
const OUTPUT_LIMIT = 8 * 1024;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DOMAINS = new Set([
  "workspace-state", "repository-state", "runs", "tasks", "vault", "wiki", "artifacts", "git-info"
]);

function fail(message) {
  throw new Error(message);
}

async function readBoundedRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) fail("PROBE_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.endsWith("\n") || text.trim().split(/\r?\n/u).length !== 1) fail("PROBE_INPUT_INVALID");
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    fail("PROBE_INPUT_INVALID");
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) fail("PROBE_INPUT_INVALID");
  return request;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(label);
  return value;
}

function validateRequest(request) {
  const pausePoints = new Set([
    "after-barrier-create", "after-barrier-remove", "after-journal-state",
    "after-journal-create", "after-journal-write", "after-journal-sync", "after-journal-parent-flush",
    "after-journal-rename", "after-journal-rename-parent-flush",
    "after-lease-create", "after-lease-write", "after-lease-sync", "after-lease-parent-flush",
    "after-lease-rename", "after-lease-rename-parent-flush"
  ]);
  const pauseStates = new Set([
    "intent", "pending-barrier", "barrier-created", "barrier-identity",
    "pending-lease-create", "temporary-lease-create", "pending-lease-replace", "temporary-lease-replace",
    "temporary-identity", "lease-created", "lease-finalized", "heartbeat",
    "cleanup-with-lease", "cleanup-barrier-only", "idle"
  ]);
  const stateAwarePausePoints = new Set([
    "after-journal-state", "after-journal-create", "after-journal-write", "after-journal-sync",
    "after-journal-parent-flush", "after-journal-rename", "after-journal-rename-parent-flush",
    "after-lease-create", "after-lease-write", "after-lease-sync", "after-lease-parent-flush",
    "after-lease-rename", "after-lease-rename-parent-flush"
  ]);
  if (!new Set(["hold", "try", "native-try", "crash", "release"]).has(request.operation) ||
      typeof request.workspaceRoot !== "string" || !isAbsolute(request.workspaceRoot) || request.workspaceRoot.includes("\0") ||
      !DOMAINS.has(request.domain) || typeof request.key !== "string" || !SAFE_KEY.test(request.key) ||
      typeof request.coordinationRoot !== "string" || !isAbsolute(request.coordinationRoot) || request.coordinationRoot.includes("\0") ||
      typeof request.activate !== "boolean" ||
      (request.failOperation !== undefined && typeof request.failOperation !== "boolean") ||
      (request.exerciseKeyCount !== undefined && request.exerciseKeyCount !== 1_000) ||
      (request.pauseAt !== undefined && !pausePoints.has(request.pauseAt)) ||
      (request.pauseState !== undefined && !pauseStates.has(request.pauseState))) fail("PROBE_INPUT_INVALID");
  const validated = {
    operation: request.operation,
    workspaceRoot: resolve(request.workspaceRoot),
    domain: request.domain,
    key: request.key,
    coordinationRoot: resolve(request.coordinationRoot),
    timeoutMs: boundedInteger(request.timeoutMs, 1, 600_000, "PROBE_TIMEOUT_INVALID"),
    holdMs: request.holdMs === undefined ? 0 : boundedInteger(request.holdMs, 0, 60_000, "PROBE_HOLD_INVALID"),
    clockOffsetMs: request.clockOffsetMs === undefined ? 0 : boundedInteger(request.clockOffsetMs, -300_000, 300_000, "PROBE_CLOCK_INVALID"),
    cancelMs: request.cancelMs === undefined ? undefined : boundedInteger(request.cancelMs, 1, request.timeoutMs, "PROBE_CANCEL_INVALID"),
    failOperation: request.failOperation ?? false,
    exerciseKeyCount: request.exerciseKeyCount,
    pauseAt: request.pauseAt,
    pauseOccurrence: request.pauseOccurrence === undefined
      ? 1 : boundedInteger(request.pauseOccurrence, 1, 32, "PROBE_PAUSE_OCCURRENCE_INVALID"),
    pauseState: request.pauseState,
    activate: request.activate
  };
  if ((validated.operation === "hold" && validated.holdMs === 0) ||
      (["crash", "release"].includes(validated.operation) && validated.holdMs !== 0) ||
      (validated.pauseAt === "after-journal-state" && validated.pauseState === undefined) ||
      (validated.pauseState !== undefined && !stateAwarePausePoints.has(validated.pauseAt)) ||
      (validated.exerciseKeyCount !== undefined &&
        (validated.operation !== "try" || validated.holdMs !== 0 || validated.pauseAt !== undefined || validated.failOperation))) {
    fail("PROBE_INPUT_INVALID");
  }
  return Object.freeze(validated);
}

async function emit(record) {
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > OUTPUT_LIMIT) fail("PROBE_OUTPUT_TOO_LARGE");
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(text, (error) => error ? rejectWrite(error) : resolveWrite());
  });
}

function errno(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
}

async function counterState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(parsed.current) || parsed.current < 0 ||
        !Number.isSafeInteger(parsed.maxOwners) || parsed.maxOwners < parsed.current) fail("PROBE_COUNTER_INVALID");
    return parsed;
  } catch (error) {
    if (errno(error) === "ENOENT") return { current: 0, maxOwners: 0 };
    throw error;
  }
}

async function writeCounter(path, state) {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function withCounterGuard(root, operation) {
  const guard = join(root, "counter.guard");
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await mkdir(guard, { mode: 0o700 });
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail("PROBE_COUNTER_TIMEOUT");
      await delay(5);
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(guard);
  }
}

function wait(milliseconds, signal) {
  return new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolveWait();
    }
    function aborted() {
      clearTimeout(timer);
      rejectWait(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main() {
  const request = validateRequest(await readBoundedRequest());
  for (const path of [request.workspaceRoot, request.coordinationRoot]) {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path) fail("PROBE_DIRECTORY_INVALID");
  }
  const runtimeRootValue = process.env.TOKENGRAPH_TEST_RUNTIME_ROOT;
  if (!runtimeRootValue || !isAbsolute(runtimeRootValue) || runtimeRootValue.includes("\0")) fail("PROBE_RUNTIME_INVALID");
  const runtimeRoot = await realpath(runtimeRootValue);
  const moduleUrl = (name) => pathToFileURL(join(runtimeRoot, "dist", "core", `${name}.js`)).href;
  const [{ canonicalPersistenceLock }, storage, activation, nativeProvider] = await Promise.all([
    import(moduleUrl("lockDomain")),
    import(moduleUrl("storage")),
    import(moduleUrl("legacyRuntimeActivation")),
    import(moduleUrl("nativeLockProvider"))
  ]);
  const capability = request.activate
    ? activation.activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true })
    : undefined;
  const lock = await canonicalPersistenceLock(request.workspaceRoot, request.domain, request.key);
  const controller = new AbortController();
  const keepAlive = setInterval(() => undefined, 1_000);
  const deadline = setTimeout(() => {
    controller.abort();
    process.exit(124);
  }, request.timeoutMs);
  const cancellation = request.cancelMs === undefined ? undefined : setTimeout(() => controller.abort(), request.cancelMs);
  cancellation?.unref?.();
  let acquiredMax = 0;
  const operation = async () => {
    const counterPath = join(request.coordinationRoot, "counter.json");
    const entered = await withCounterGuard(request.coordinationRoot, async () => {
      const before = await counterState(counterPath);
      const next = { current: before.current + 1, maxOwners: Math.max(before.maxOwners, before.current + 1) };
      await writeCounter(counterPath, next);
      return next;
    });
    acquiredMax = entered.maxOwners;
    await emit({ status: "acquired", owner: process.pid, maxOwners: acquiredMax });
    try {
      if (request.operation === "crash") {
        process.abort();
        await new Promise(() => undefined);
      }
      if (request.holdMs > 0) await delay(request.holdMs);
      if (request.failOperation) {
        throw Object.assign(new Error("Probe operation failed as requested."), { code: "PROBE_OPERATION_FAILURE" });
      }
    } finally {
      await withCounterGuard(request.coordinationRoot, async () => {
        const current = await counterState(counterPath);
        await writeCounter(counterPath, { current: Math.max(0, current.current - 1), maxOwners: current.maxOwners });
      });
    }
    if (request.pauseAt === "after-barrier-remove") {
      await emit({ status: "operation-complete", owner: process.pid, maxOwners: acquiredMax });
    }
  };
  try {
    if (request.operation === "native-try") {
      if (!request.activate) {
        throw Object.assign(new Error("Native contention probe is not activated."), {
          code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED"
        });
      }
      await mkdir(lock.domainRoot, { recursive: true, mode: 0o700 });
      const addon = await nativeProvider.getNativeLockAddon();
      const acquisitionDeadline = Date.now() + request.timeoutMs;
      let handle;
      for (;;) {
        try {
          handle = addon.tryAcquireAnchor(lock.anchorPath);
          break;
        } catch (error) {
          if (errno(error) !== "LOCK_BUSY") throw error;
          if (Date.now() >= acquisitionDeadline) {
            throw Object.assign(new Error("Native contention probe timed out."), { code: "LOCK_TIMEOUT" });
          }
          await delay(10);
        }
      }
      try {
        await operation();
      } finally {
        handle.release();
      }
      await emit({ status: "released", owner: process.pid, maxOwners: acquiredMax });
      return;
    } else if (request.exerciseKeyCount !== undefined) {
      const domains = ["runs", "tasks", "artifacts"];
      for (let index = 0; index < request.exerciseKeyCount; index += domains.length) {
        await Promise.all(domains.map(async (domain, offset) => {
          const keyIndex = index + offset;
          if (keyIndex >= request.exerciseKeyCount) return;
          const exerciseLock = await canonicalPersistenceLock(
            request.workspaceRoot, domain, `key-${keyIndex}.json`
          );
          await storage.withFileLock(exerciseLock, async () => undefined, { signal: controller.signal });
        }));
      }
      await emit({ status: "acquired", owner: process.pid, maxOwners: 1 });
      await emit({ status: "released", owner: process.pid, maxOwners: 1 });
      return;
    }
    if (request.clockOffsetMs === 0 && request.pauseAt === undefined) {
      await storage.withFileLock(lock, operation, { signal: controller.signal });
    } else {
      const lease = await import(moduleUrl("fileLockLease"));
      const provider = await import(moduleUrl("nativeLockProvider"));
      const productionIo = lease.productionFileLockIoForTesting();
      let paused = false;
      const pauseCounts = new Map();
      const pauseForever = async () => {
        if (paused) return;
        paused = true;
        await emit({ status: "paused", owner: process.pid, maxOwners: 0 });
        await new Promise(() => undefined);
      };
      const maybePause = async (point, states = undefined) => {
        if (request.pauseAt !== point || (request.pauseState !== undefined && !states?.includes(request.pauseState))) return;
        const key = request.pauseState === undefined ? point : `${point}:${request.pauseState}`;
        const occurrence = (pauseCounts.get(key) ?? 0) + 1;
        pauseCounts.set(key, occurrence);
        if (request.pauseAt === point && request.pauseOccurrence === occurrence) await pauseForever();
      };
      const journalStates = (journal) => {
        if (journal.phase === "intent") return ["intent", "pending-barrier"];
        if (journal.phase === "barrier-created") {
          if (journal.pendingLeaseWrite?.operation === "create") {
            return journal.pendingLeaseWrite.temporaryIdentity === undefined
              ? ["pending-lease-create"] : ["temporary-lease-create", "temporary-identity"];
          }
          return ["barrier-created", "barrier-identity"];
        }
        if (journal.phase === "lease-created") {
          if (journal.pendingLeaseWrite?.operation === "replace") {
            return journal.pendingLeaseWrite.temporaryIdentity === undefined
              ? ["pending-lease-replace"] : ["temporary-lease-replace", "temporary-identity"];
          }
          const states = ["lease-created", "lease-finalized"];
          if (journal.heartbeatAt !== journal.startedAt) states.push("heartbeat");
          return states;
        }
        if (journal.phase === "cleanup") {
          return [journal.leaseIdentity === undefined ? "cleanup-barrier-only" : "cleanup-with-lease"];
        }
        return [journal.phase];
      };
      const journalTemporaryPath = `${lock.journalPath}.tokengraph-write-v2.tmp`;
      const leasePath = join(lock.compatibilityPath, "lease.json");
      const leaseTemporaryPath = `${leasePath}.tokengraph-write-v2.tmp`;
      const io = Object.freeze({
        ...productionIo,
        async createDirectory(path) {
          const snapshot = await productionIo.createDirectory(path);
          if (request.pauseAt === "after-barrier-create" && resolve(path) === resolve(lock.compatibilityPath)) {
            await pauseForever();
          }
          return snapshot;
        },
        async createFileDurable(path, text) {
          const kind = resolve(path) === resolve(journalTemporaryPath)
            ? "journal" : resolve(path) === resolve(leaseTemporaryPath) ? "lease" : undefined;
          const states = kind === "journal"
            ? journalStates(JSON.parse(text))
            : kind === "lease" ? journalStates(JSON.parse(await readFile(lock.journalPath, "utf8"))) : undefined;
          return lease.createProductionProtocolFileForTesting(path, text, undefined, async (point) => {
            if (kind === undefined) return;
            const suffix = point === "after-create" ? "create"
              : point === "after-write" ? "write"
                : point === "after-sync" ? "sync" : "parent-flush";
            await maybePause(`after-${kind}-${suffix}`, states);
          });
        },
        async replaceFileFromTemporary(temporaryPath, targetPath, temporaryIdentity, expectedTargetIdentity) {
          const kind = resolve(targetPath) === resolve(lock.journalPath)
            ? "journal" : resolve(targetPath) === resolve(leasePath) ? "lease" : undefined;
          const states = kind === "journal"
            ? journalStates(JSON.parse(await readFile(temporaryPath, "utf8")))
            : kind === "lease" ? journalStates(JSON.parse(await readFile(lock.journalPath, "utf8"))) : undefined;
          const snapshot = await lease.replaceProductionProtocolFileForTesting(
            temporaryPath, targetPath, temporaryIdentity, expectedTargetIdentity, undefined, async (point) => {
              if (kind === undefined) return;
              await maybePause(point === "after-rename"
                ? `after-${kind}-rename` : `after-${kind}-rename-parent-flush`, states);
            }
          );
          if (!paused && resolve(targetPath) === resolve(lock.journalPath)) {
            await maybePause("after-journal-state", states);
          }
          return snapshot;
        },
        async removeDirectory(path, expectedIdentity) {
          await productionIo.removeDirectory(path, expectedIdentity);
          if (resolve(path) === resolve(lock.compatibilityPath)) await maybePause("after-barrier-remove");
        }
      });
      const runtime = Object.freeze({
        pid: process.pid,
        platform: process.platform,
        now: () => Date.now() + request.clockOffsetMs,
        randomUUID,
        wait,
        processLiveness(pid) {
          try {
            process.kill(pid, 0);
            return "alive";
          } catch (error) {
            return errno(error) === "ESRCH" ? "dead" : "unknown";
          }
        },
        loadAddon: () => provider.getNativeLockAddon(),
        scheduleHeartbeat(milliseconds, callback) {
          let chain = Promise.resolve();
          let failure;
          const timer = setInterval(() => { chain = chain.then(callback).catch((error) => { failure ??= error; }); }, milliseconds);
          timer.unref?.();
          return Object.freeze({
            async stop() {
              clearInterval(timer);
              await chain;
              if (failure !== undefined) throw failure;
            }
          });
        },
        io
      });
      await lease.runWithFileLockForTesting(lock, operation, { signal: controller.signal }, { capability, runtime });
    }
    await emit({ status: "released", owner: process.pid, maxOwners: acquiredMax });
  } finally {
    clearTimeout(deadline);
    if (cancellation !== undefined) clearTimeout(cancellation);
    clearInterval(keepAlive);
  }
}

try {
  await main();
} catch (error) {
  await emit({
    status: error && typeof error === "object" && typeof error.code === "string" ? error.code : "error",
    owner: process.pid,
    maxOwners: 0
  }).catch(() => undefined);
  process.exitCode = 1;
}
