import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLegacyRuntimeShutdown,
  getLegacyRuntimeActivationStatus
} from "../src/core/legacyRuntimeActivation.js";
import {
  LOCK_DOMAINS,
  canonicalPersistenceLock,
  isCanonicalPersistenceLock
} from "../src/core/lockDomain.js";
import {
  type DirectorySnapshot,
  type FileLockPolicy,
  type FileLockRuntime,
  type FileSnapshot,
  createProductionProtocolFileForTesting,
  parseLockRecoveryJournalForTesting,
  productionFileLockIoForTesting,
  replaceProductionProtocolFileForTesting,
  runWithFileLockForTesting,
  sameProcessLockQueueEntryCountForTesting,
  sameProcessLockQueueSizeForTesting,
  validateLockRecoveryTransitionForTesting
} from "../src/core/fileLockLease.js";
import type { NativeLockAddon, NativeLockHandle } from "../src/core/nativeLockAddon.js";

const temporaryRoots: string[] = [];

const TEST_POLICY: FileLockPolicy = Object.freeze({
  attempts: 3,
  waitMs: 1,
  staleMs: 30,
  heartbeatMs: 9
});

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

interface FakeFile {
  identity: string;
  text: string;
  nlink: number;
  mode: number;
}

interface FakeDirectory {
  identity: string;
  mode: number;
}

class FakeLockRuntime implements FileLockRuntime {
  readonly pid = 4242;
  readonly platform: NodeJS.Platform;
  readonly files = new Map<string, FakeFile>();
  readonly directories = new Map<string, FakeDirectory>();
  readonly events: string[] = [];
  readonly liveness = new Map<number, "alive" | "dead" | "unknown">();
  readonly activeAnchors = new Set<string>();
  readonly journalRecords: Record<string, unknown>[] = [];
  readonly journalTargetIdentities: string[] = [];
  maxNativeOwners = 0;
  busyAttempts = 0;
  acquisitionFailure: unknown;
  queueTimeouts = 0;
  waitHook: (() => void) | undefined;
  createHook: ((path: string, text: string) => void) | undefined;
  cleanupFailure: string | undefined;
  readonly transientFailures = new Map<string, { remaining: number; code: string; skip?: number }>();
  private sequence = 0;
  private clock = 1_700_000_000_000;
  private readonly heartbeatCallbacks = new Set<() => Promise<void>>();

  now(): number { return this.clock; }
  advance(milliseconds: number): void { this.clock += milliseconds; }
  randomUUID(): string { return `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`; }
  async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    this.events.push(`wait:${milliseconds}`);
    if (signal?.aborted) throw coded("ABORT_ERR");
    if (milliseconds === TEST_POLICY.attempts * TEST_POLICY.waitMs) {
      if (this.queueTimeouts > 0) {
        this.queueTimeouts -= 1;
      } else {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(coded("ABORT_ERR")), { once: true });
        });
        return;
      }
    }
    this.waitHook?.();
    this.waitHook = undefined;
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }
  processLiveness(pid: number): "alive" | "dead" | "unknown" {
    this.events.push(`liveness:${pid}`);
    return this.liveness.get(pid) ?? "unknown";
  }

  async loadAddon(): Promise<NativeLockAddon> {
    this.events.push("load-addon");
    const runtime = this;
    return Object.freeze({
      targetId: "linux-x64",
      implementation: "flock",
      tryAcquireAnchor(anchorPath: string): NativeLockHandle {
        runtime.events.push(`acquire:${anchorPath}`);
        if (runtime.acquisitionFailure !== undefined) throw runtime.acquisitionFailure;
        if (runtime.busyAttempts > 0) {
          runtime.busyAttempts -= 1;
          throw coded("LOCK_BUSY");
        }
        if (runtime.activeAnchors.has(anchorPath)) throw coded("LOCK_BUSY");
        runtime.files.set(anchorPath, runtime.files.get(anchorPath) ?? {
          identity: runtime.nextIdentity("anchor"), text: "", nlink: 1, mode: 0o600
        });
        runtime.activeAnchors.add(anchorPath);
        runtime.maxNativeOwners = Math.max(runtime.maxNativeOwners, runtime.activeAnchors.size);
        let protectedPath: string | undefined;
        let released = false;
        return Object.freeze({
          protectCompatibilityDirectory(path: string): void {
            if (protectedPath !== undefined || released) throw coded("NATIVE_LOCK_ERROR");
            protectedPath = path;
            runtime.events.push(`protect:${path}`);
          },
          releaseCompatibilityDirectory(): void {
            if (protectedPath === undefined || released) throw coded("NATIVE_LOCK_ERROR");
            runtime.events.push(`release-compat:${protectedPath}`);
            protectedPath = undefined;
          },
          release(): void {
            if (protectedPath !== undefined || released) throw coded("NATIVE_LOCK_ERROR");
            runtime.events.push(`release-anchor:${anchorPath}`);
            runtime.activeAnchors.delete(anchorPath);
            released = true;
          }
        });
      }
    });
  }

  scheduleHeartbeat(milliseconds: number, callback: () => Promise<void>) {
    this.events.push(`schedule:${milliseconds}`);
    this.heartbeatCallbacks.add(callback);
    return Object.freeze({
      stop: async (): Promise<void> => {
        this.events.push("stop-heartbeat");
        this.heartbeatCallbacks.delete(callback);
      }
    });
  }

  async flushHeartbeats(): Promise<void> {
    for (const callback of [...this.heartbeatCallbacks]) await callback();
  }

  private nextIdentity(prefix: string): string { return `${prefix}-${++this.sequence}`; }
  private maybeFail(event: string): void {
    const configured = this.transientFailures.get(event);
    if (configured === undefined || configured.remaining <= 0) return;
    if ((configured.skip ?? 0) > 0) {
      configured.skip = (configured.skip ?? 0) - 1;
      return;
    }
    configured.remaining -= 1;
    throw coded(configured.code);
  }
  entries(path: string): string[] {
    const names = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.directories.keys()]) {
      if (candidate !== path && dirname(candidate) === path) names.add(candidate.slice(path.length + 1));
    }
    return [...names].sort();
  }

  readonly io: FileLockRuntime["io"];

  constructor(platform: NodeJS.Platform = "linux") {
    this.platform = platform;
    this.io = {
      ensureDirectory: async (path: string): Promise<void> => {
        this.events.push(`ensure:${path}`);
        this.maybeFail(`ensure:${path}`);
        this.directories.set(path, this.directories.get(path) ?? { identity: this.nextIdentity("d"), mode: 0o700 });
      },
      readFile: async (path: string, maximumBytes: number): Promise<FileSnapshot | undefined> => {
        this.events.push(`read:${path}`);
        this.maybeFail(`read:${path}`);
        const file = this.files.get(path);
        if (file === undefined) return undefined;
        if (Buffer.byteLength(file.text) > maximumBytes) throw coded("EFBIG");
        return { ...file };
      },
      inspectDirectory: async (path: string): Promise<DirectorySnapshot | undefined> => {
        this.events.push(`inspect:${path}`);
        this.maybeFail(`inspect:${path}`);
        if (this.files.has(path)) throw coded("LEGACY_LOCK_BLOCKED");
        const directory = this.directories.get(path);
        return directory === undefined ? undefined : { ...directory, entries: this.entries(path) };
      },
      createDirectory: async (path: string): Promise<DirectorySnapshot> => {
        this.events.push(`mkdir:${path}`);
        this.maybeFail(`mkdir:${path}`);
        if (this.files.has(path) || this.directories.has(path)) throw coded("EEXIST");
        const directory = { identity: this.nextIdentity("d"), mode: 0o700 };
        this.directories.set(path, directory);
        return { ...directory, entries: [] };
      },
      createFileDurable: async (path: string, text: string): Promise<FileSnapshot> => {
        this.events.push(`create:${path}`);
        if (path.endsWith(".tokengraph-native-journal-v2.lock.tokengraph-write-v2.tmp")) {
          const record = JSON.parse(text) as Record<string, unknown>;
          this.journalRecords.push(record);
          this.events.push(`journal:${String(record.phase)}:${String(record.generation)}`);
        }
        this.createHook?.(path, text);
        this.maybeFail(`create:${path}`);
        if (this.files.has(path)) throw coded("EEXIST");
        const file = { identity: this.nextIdentity("f"), text, nlink: 1, mode: 0o600 };
        this.files.set(path, file);
        return { ...file };
      },
      replaceFileFromTemporary: async (
        temporaryPath: string,
        targetPath: string,
        temporaryIdentity: string,
        expectedTargetIdentity?: string
      ): Promise<FileSnapshot> => {
        this.events.push(`rename:${temporaryPath}:${targetPath}`);
        this.maybeFail(`rename:${temporaryPath}`);
        const temporary = this.files.get(temporaryPath);
        const target = this.files.get(targetPath);
        if (temporary?.identity !== temporaryIdentity ||
          (expectedTargetIdentity === undefined ? target !== undefined : target?.identity !== expectedTargetIdentity)) {
          throw coded("ESTALE");
        }
        this.files.set(targetPath, temporary);
        this.files.delete(temporaryPath);
        if (targetPath.endsWith(".tokengraph-native-journal-v2.lock")) {
          this.journalTargetIdentities.push(temporaryIdentity);
        }
        this.events.push(`rename-after:${temporaryPath}`);
        this.maybeFail(`rename-after:${temporaryPath}`);
        return { ...temporary };
      },
      flushParentDirectory: async (path: string): Promise<void> => {
        this.events.push(`flush-parent:${path}`);
        this.maybeFail(`flush-parent:${path}`);
      },
      removeFile: async (path: string, expectedIdentity: string): Promise<void> => {
        this.events.push(`unlink:${path}`);
        this.maybeFail(`unlink:${path}`);
        if (this.cleanupFailure === "unlink") throw coded("EIO");
        if (this.files.get(path)?.identity !== expectedIdentity) throw coded("ESTALE");
        this.files.delete(path);
      },
      removeDirectory: async (path: string, expectedIdentity: string): Promise<void> => {
        this.events.push(`rmdir:${path}`);
        this.maybeFail(`rmdir:${path}`);
        if (this.cleanupFailure === "rmdir") throw coded("EIO");
        if (this.directories.get(path)?.identity !== expectedIdentity || this.entries(path).length !== 0) throw coded("ENOTEMPTY");
        this.directories.delete(path);
      }
    };
  }
}

function staleJournal(
  runtime: FakeLockRuntime,
  relativeLegacyName: string,
  phase: "intent" | "barrier-created" | "lease-created" | "cleanup",
  fields: { barrierIdentity?: string; leaseIdentity?: string } = {}
) {
  const timestamp = new Date(runtime.now() - TEST_POLICY.staleMs - 1).toISOString();
  const active = {
    schemaVersion: 2 as const,
    generation: 1,
    predecessor: { generation: 0, identity: "bootstrap" },
    relativeLegacyName,
    keyHash: createHash("sha256").update(relativeLegacyName).digest("hex"),
    pid: 77,
    nonce: "10000000-0000-4000-8000-000000000001",
    phase,
    startedAt: timestamp,
    heartbeatAt: timestamp
  };
  if (phase === "intent") return { ...active, phase, pendingBarrier: { operation: "create" as const } };
  return { ...active, phase, ...fields };
}

function staleLease(runtime: FakeLockRuntime, nonce = "10000000-0000-4000-8000-000000000001") {
  const timestamp = new Date(runtime.now() - TEST_POLICY.staleMs - 1).toISOString();
  return {
    schemaVersion: 1 as const,
    pid: 77,
    nonce,
    startedAt: timestamp,
    heartbeatAt: timestamp
  };
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function productionBackedRuntime(runtime: FakeLockRuntime): FileLockRuntime {
  return {
    pid: runtime.pid,
    platform: process.platform,
    now: () => runtime.now(),
    randomUUID: () => runtime.randomUUID(),
    wait: (milliseconds, signal) => runtime.wait(milliseconds, signal),
    processLiveness: (pid) => runtime.processLiveness(pid),
    loadAddon: () => runtime.loadAddon(),
    scheduleHeartbeat: (milliseconds, callback) => runtime.scheduleHeartbeat(milliseconds, callback),
    io: productionFileLockIoForTesting()
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("deterministic condition was not reached");
}

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-storage-lock-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy runtime activation", () => {
  it("refuses an explicitly unactivated lock attempt before any runtime effect", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "run-a.json");
    const runtime = new FakeLockRuntime();

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: undefined,
      runtime
    })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" });
    expect(runtime.events).toEqual([]);
  });

  it("mints an in-memory capability only for the literal confirmation", () => {
    try {
      activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: false as true });
      throw new Error("invalid activation unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" });
    }

    const capability = activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true });
    expect(capability).toBeTypeOf("object");
    expect(JSON.stringify(capability)).toBe("{}");
    expect(getLegacyRuntimeActivationStatus()).toEqual({ activated: true });
  });

  it("rejects structurally forged capabilities before any runtime effect", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "forged-capability.json");
    const runtime = new FakeLockRuntime();

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: {} as ReturnType<typeof activateLegacyRuntimeShutdown>,
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" });
    expect(runtime.events).toEqual([]);
  });
});

describe("closed lock-domain registry", () => {
  it("contains exactly the eight authorized domains", () => {
    expect(LOCK_DOMAINS).toEqual([
      "workspace-state",
      "repository-state",
      "runs",
      "tasks",
      "vault",
      "wiki",
      "artifacts",
      "git-info"
    ]);
  });

  it("brands a safe direct-child compatibility path and fixed infrastructure", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "run-a.json");

    expect(lock).toMatchObject({
      domain: "runs",
      domainRoot: join(root, ".tokengraph", "runs"),
      compatibilityPath: join(root, ".tokengraph", "runs", "run-a.json.lock"),
      anchorPath: join(root, ".tokengraph", "runs", ".tokengraph-native-anchor-v2.lock"),
      journalPath: join(root, ".tokengraph", "runs", ".tokengraph-native-journal-v2.lock")
    });
    expect(isCanonicalPersistenceLock(lock)).toBe(true);
    expect(isCanonicalPersistenceLock({ ...lock })).toBe(false);
  });

  it("derives the literal roots for all seven workspace domains", async () => {
    const root = await temporaryWorkspace();
    const expected = {
      "workspace-state": join(root, ".tokengraph"),
      "repository-state": join(root, ".tokengraph", "repository"),
      runs: join(root, ".tokengraph", "runs"),
      tasks: join(root, ".tokengraph", "tasks"),
      vault: join(root, ".tokengraph", "vault"),
      wiki: join(root, ".tokengraph", "wiki"),
      artifacts: join(root, ".tokengraph", "repository", "artifacts")
    } as const;
    for (const [domain, domainRoot] of Object.entries(expected)) {
      await expect(canonicalPersistenceLock(root, domain as keyof typeof expected, "data.json"))
        .resolves.toMatchObject({ domainRoot });
    }
  });

  it("rejects traversal, separators, unknown domains, and forged git parents", async () => {
    const root = await temporaryWorkspace();
    await expect(canonicalPersistenceLock(root, "runs", "../escape"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
    await expect(canonicalPersistenceLock(root, "runs", "nested/file"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
    await expect(canonicalPersistenceLock(root, "runs", "trailing."))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
    await expect(canonicalPersistenceLock(root, "runs", "stream:name"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
    await expect(canonicalPersistenceLock(root, "unknown" as "runs", "file"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });

    await writeFile(join(root, ".git"), "gitdir: ../outside\n", "utf8");
    await expect(canonicalPersistenceLock(root, "git-info", "exclude"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
  });

  it("rejects portable device names and case-insensitive infrastructure aliases", async () => {
    const root = await temporaryWorkspace();
    for (const name of [
      "NUL",
      "con.json",
      ".TOKENGRAPH-NATIVE-ANCHOR-V2",
      ".TokenGraph-Native-Journal-V2"
    ]) {
      await expect(canonicalPersistenceLock(root, "runs", name), name)
        .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
    }
  });

  it("rejects forged branded locks and an invalid heartbeat policy before I/O", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "policy.json");
    const runtime = new FakeLockRuntime();
    await expect(runWithFileLockForTesting({ ...lock }, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_LOCK" });
    expect(runtime.events).toEqual([]);

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: { ...TEST_POLICY, heartbeatMs: 10 }
    })).rejects.toBeInstanceOf(TypeError);
    expect(runtime.events).toEqual([]);
  });

  it("derives git-info from a confined resolved common directory", async () => {
    const root = await temporaryWorkspace();
    const common = await temporaryWorkspace();
    const gitDir = join(common, "worktrees", "sample");
    await mkdir(join(common, "info"), { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    await writeFile(join(gitDir, "commondir"), "../..\n", "utf8");
    await writeFile(join(gitDir, "gitdir"), `${join(root, ".git")}\n`, "utf8");

    const lock = await canonicalPersistenceLock(root, "git-info", "exclude");
    expect(lock.domainRoot).toBe(join(common, "info"));
    expect(lock.compatibilityPath).toBe(join(common, "info", "exclude.lock"));
  });

  it("preserves a main repository git-info root", async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, ".git", "info"), { recursive: true });

    const lock = await canonicalPersistenceLock(root, "git-info", "exclude");
    expect(lock.domainRoot).toBe(join(root, ".git", "info"));
    expect(lock.compatibilityPath).toBe(join(root, ".git", "info", "exclude.lock"));
  });

  it("rejects an external common directory without a worktree backlink", async () => {
    const root = await temporaryWorkspace();
    const common = await temporaryWorkspace();
    const gitDir = join(common, "worktrees", "missing-backlink");
    await mkdir(join(common, "info"), { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    await writeFile(join(gitDir, "commondir"), "../..\n", "utf8");

    await expect(canonicalPersistenceLock(root, "git-info", "exclude"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
  });

  it("rejects an external common directory with a mismatched worktree backlink", async () => {
    const root = await temporaryWorkspace();
    const other = await temporaryWorkspace();
    const common = await temporaryWorkspace();
    const gitDir = join(common, "worktrees", "mismatched-backlink");
    await mkdir(join(common, "info"), { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`, "utf8");
    await writeFile(join(gitDir, "commondir"), "../..\n", "utf8");
    await writeFile(join(gitDir, "gitdir"), `${join(other, ".git")}\n`, "utf8");

    await expect(canonicalPersistenceLock(root, "git-info", "exclude"))
      .rejects.toMatchObject({ code: "INVALID_LOCK_DOMAIN" });
  });
});

describe("journal stability", () => {
  it("accepts only the exact JournalV2 phase cross-product", () => {
    const predecessor = { generation: 0, identity: "journal-0" };
    const owner = {
      schemaVersion: 2,
      generation: 1,
      predecessor,
      relativeLegacyName: "run-a.json.lock",
      keyHash: createHash("sha256").update("run-a.json.lock").digest("hex"),
      pid: 77,
      nonce: "10000000-0000-4000-8000-000000000001",
      startedAt: "2023-11-14T22:13:20.000Z",
      heartbeatAt: "2023-11-14T22:13:20.000Z"
    };
    const valid = [
      { schemaVersion: 2, generation: 0, phase: "idle" },
      { ...owner, phase: "intent", pendingBarrier: { operation: "create" } },
      { ...owner, phase: "barrier-created", barrierIdentity: "barrier" },
      { ...owner, phase: "barrier-created", barrierIdentity: "barrier", pendingLeaseWrite: {
        operation: "create", payloadSha256: "a".repeat(64)
      } },
      { ...owner, phase: "barrier-created", barrierIdentity: "barrier", pendingLeaseWrite: {
        operation: "create", payloadSha256: "a".repeat(64), temporaryIdentity: "temp"
      } },
      { ...owner, phase: "lease-created", barrierIdentity: "barrier", leaseIdentity: "lease" },
      { ...owner, phase: "lease-created", barrierIdentity: "barrier", leaseIdentity: "lease", pendingLeaseWrite: {
        operation: "replace", fromIdentity: "lease", payloadSha256: "b".repeat(64)
      } },
      { ...owner, phase: "lease-created", barrierIdentity: "barrier", leaseIdentity: "lease", pendingLeaseWrite: {
        operation: "replace", fromIdentity: "lease", payloadSha256: "b".repeat(64), temporaryIdentity: "temp"
      } },
      { ...owner, phase: "cleanup", barrierIdentity: "barrier", leaseIdentity: "lease" },
      { ...owner, phase: "cleanup", barrierIdentity: "barrier" },
      { schemaVersion: 2, generation: 2, phase: "idle", predecessor: { generation: 1, identity: "journal-1" } }
    ];
    for (const record of valid) {
      expect(parseLockRecoveryJournalForTesting(`${JSON.stringify(record)}\n`), JSON.stringify(record)).toEqual(record);
    }

    const invalid = [
      { schemaVersion: 2, generation: 0, phase: "idle", predecessor },
      { ...owner, phase: "idle" },
      { ...owner, phase: "intent" },
      { ...owner, phase: "intent", pendingBarrier: { operation: "create" }, barrierIdentity: "barrier" },
      { ...owner, phase: "barrier-created" },
      { ...owner, phase: "barrier-created", barrierIdentity: "barrier", pendingLeaseWrite: {
        operation: "replace", fromIdentity: "lease", payloadSha256: "a".repeat(64)
      } },
      { ...owner, phase: "lease-created", barrierIdentity: "barrier" },
      { ...owner, phase: "lease-created", barrierIdentity: "barrier", leaseIdentity: "lease", pendingLeaseWrite: {
        operation: "replace", fromIdentity: "other", payloadSha256: "b".repeat(64)
      } },
      { ...owner, phase: "lease-created", barrierIdentity: "barrier", leaseIdentity: "lease",
        pendingBarrier: { operation: "create" }, pendingLeaseWrite: {
          operation: "replace", fromIdentity: "lease", payloadSha256: "b".repeat(64)
        } },
      { ...owner, phase: "cleanup", barrierIdentity: "barrier", pendingBarrier: { operation: "create" } },
      { ...owner, phase: "cleanup", leaseIdentity: "lease" },
      { ...owner, phase: "cleanup", barrierIdentity: "barrier", unexpected: true }
    ];
    for (const record of invalid) {
      expect(parseLockRecoveryJournalForTesting(`${JSON.stringify(record)}\n`), JSON.stringify(record)).toBeUndefined();
    }
  });

  it("accepts only listed predecessor-bound G to G plus one transitions", () => {
    const idle = { schemaVersion: 2, generation: 0, phase: "idle" };
    const owner = {
      schemaVersion: 2,
      generation: 1,
      predecessor: { generation: 0, identity: "journal-0" },
      relativeLegacyName: "run-a.json.lock",
      keyHash: createHash("sha256").update("run-a.json.lock").digest("hex"),
      pid: 77,
      nonce: "10000000-0000-4000-8000-000000000001",
      startedAt: "2023-11-14T22:13:20.000Z",
      heartbeatAt: "2023-11-14T22:13:20.000Z",
      phase: "intent",
      pendingBarrier: { operation: "create" }
    };
    const bind = (record: Record<string, unknown>, generation: number, identity: string) => ({
      ...record, generation, predecessor: { generation: generation - 1, identity }
    });
    const barrier = bind({ ...owner, phase: "barrier-created", barrierIdentity: "barrier", pendingBarrier: undefined }, 2, "journal-1");
    delete (barrier as { pendingBarrier?: unknown }).pendingBarrier;
    const pendingCreate = bind({ ...barrier, pendingLeaseWrite: {
      operation: "create", payloadSha256: "a".repeat(64)
    } }, 3, "journal-2");
    const recordedCreate = bind({ ...pendingCreate, pendingLeaseWrite: {
      operation: "create", payloadSha256: "a".repeat(64), temporaryIdentity: "lease-temp"
    } }, 4, "journal-3");
    const lease = bind({ ...barrier, phase: "lease-created", leaseIdentity: "lease" }, 5, "journal-4");
    const createdLease = bind({ ...barrier, phase: "lease-created", leaseIdentity: "lease-temp" }, 5, "journal-4");
    const pendingReplace = bind({ ...lease, pendingLeaseWrite: {
      operation: "replace", fromIdentity: "lease", payloadSha256: "b".repeat(64)
    } }, 6, "journal-5");
    const recordedReplace = bind({ ...pendingReplace, pendingLeaseWrite: {
      operation: "replace", fromIdentity: "lease", payloadSha256: "b".repeat(64), temporaryIdentity: "lease-next"
    } }, 7, "journal-6");
    const replacedLease = bind({ ...lease, leaseIdentity: "lease-next",
      heartbeatAt: "2023-11-14T22:13:20.001Z" }, 8, "journal-7");
    const cleanupBoth = bind({ ...lease, phase: "cleanup" }, 6, "journal-5");
    const cleanupBarrier = bind({ ...cleanupBoth, leaseIdentity: undefined }, 7, "journal-6");
    delete (cleanupBarrier as { leaseIdentity?: unknown }).leaseIdentity;
    const idleNext = { schemaVersion: 2, generation: 8, phase: "idle", predecessor: { generation: 7, identity: "journal-7" } };

    const allowed = [
      [idle, owner, "journal-0"],
      [owner, barrier, "journal-1"],
      [owner, bind({ schemaVersion: 2, phase: "idle" }, 2, "journal-1"), "journal-1"],
      [barrier, pendingCreate, "journal-2"],
      [barrier, bind({ ...barrier, phase: "cleanup" }, 3, "journal-2"), "journal-2"],
      [pendingCreate, recordedCreate, "journal-3"],
      [pendingCreate, bind({ ...barrier }, 4, "journal-3"), "journal-3"],
      [recordedCreate, bind({ ...barrier }, 5, "journal-4"), "journal-4"],
      [recordedCreate, createdLease, "journal-4"],
      [lease, pendingReplace, "journal-5"],
      [pendingReplace, recordedReplace, "journal-6"],
      [pendingReplace, bind({ ...lease }, 7, "journal-6"), "journal-6"],
      [recordedReplace, bind({ ...lease }, 8, "journal-7"), "journal-7"],
      [recordedReplace, replacedLease, "journal-7"],
      [lease, cleanupBoth, "journal-5"],
      [cleanupBoth, cleanupBarrier, "journal-6"],
      [cleanupBarrier, idleNext, "journal-7"]
    ] as const;
    for (const [before, after, identity] of allowed) {
      expect(validateLockRecoveryTransitionForTesting(before, after, identity),
        `${String((before as { phase?: unknown }).phase)}:${String(before.generation)} -> ` +
        `${String((after as { phase?: unknown }).phase)}:${String(after.generation)}`)
        .toBe(true);
    }

    const forbidden = [
      bind({ ...owner, phase: "cleanup", pendingBarrier: undefined, barrierIdentity: "barrier" }, 1, "journal-0"),
      bind({ ...owner, phase: "lease-created", pendingBarrier: undefined, barrierIdentity: "barrier", leaseIdentity: "lease" }, 2, "journal-1"),
      bind({ ...barrier }, 4, "journal-2"),
      bind({ ...barrier, nonce: "20000000-0000-4000-8000-000000000002" }, 3, "journal-2"),
      bind({ ...barrier, heartbeatAt: "2023-11-14T22:13:19.999Z" }, 3, "journal-2"),
      { schemaVersion: 2, generation: 7, phase: "idle", predecessor: { generation: 6, identity: "journal-6" } }
    ];
    expect(validateLockRecoveryTransitionForTesting(idle, forbidden[0], "journal-0")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(owner, forbidden[1], "journal-1")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(barrier, forbidden[2], "journal-2")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(barrier, forbidden[3], "journal-2")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(barrier, forbidden[4], "journal-2")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(cleanupBoth, forbidden[5], "journal-6")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(cleanupBoth, idleNext, "journal-6")).toBe(false);
    expect(validateLockRecoveryTransitionForTesting(barrier, pendingCreate, "wrong-identity")).toBe(false);
    const nonCanonicalIntent = bind({ ...owner, heartbeatAt: "2023-11-14T22:13:20.001Z" }, 1, "journal-0");
    expect(validateLockRecoveryTransitionForTesting(idle, nonCanonicalIntent, "journal-0")).toBe(false);
  });

  it("fails closed when the journal identity changes between its two reads", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "run-a.json");
    const runtime = new FakeLockRuntime();
    const journal = staleJournal(runtime, "run-a.json.lock", "intent");
    runtime.files.set(lock.journalPath, {
      identity: "journal-before",
      text: `${JSON.stringify(journal)}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");
    runtime.waitHook = () => {
      runtime.files.set(lock.journalPath, {
        identity: "journal-after",
        text: `${JSON.stringify({ ...journal, nonce: "20000000-0000-4000-8000-000000000002" })}\n`,
        nlink: 1,
        mode: 0o600
      });
    };
    let ran = false;

    await expect(runWithFileLockForTesting(lock, async () => { ran = true; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(ran).toBe(false);
    expect(runtime.files.get(lock.journalPath)?.identity).toBe("journal-after");
  });

  it("refuses an unjournaled upgraded barrier elsewhere in the domain", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "run-a.json");
    const runtime = new FakeLockRuntime();
    runtime.directories.set(join(lock.domainRoot, "orphan.json.lock"), { identity: "orphan", mode: 0o700 });
    let ran = false;

    await expect(runWithFileLockForTesting(lock, async () => { ran = true; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(ran).toBe(false);
    expect(runtime.directories.has(join(lock.domainRoot, "orphan.json.lock"))).toBe(true);
  });
});

describe("owned lease lifecycle", () => {
  it("writes durable phases in order, heartbeats below stale/3, and cleans before anchor release", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "run-a.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");

    const result = runWithFileLockForTesting(lock, async () => {
      const lease = JSON.parse(runtime.files.get(leasePath)!.text) as Record<string, unknown>;
      expect(lease).toEqual({
        schemaVersion: 1,
        pid: 4242,
        nonce: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        startedAt: "2023-11-14T22:13:20.000Z",
        heartbeatAt: "2023-11-14T22:13:20.000Z"
      });
      runtime.advance(90);
      await runtime.flushHeartbeats();
      const refreshed = JSON.parse(runtime.files.get(leasePath)!.text) as Record<string, unknown>;
      expect(refreshed.heartbeatAt).toBe("2023-11-14T22:13:20.090Z");
      expect(parseLockRecoveryJournalForTesting(runtime.files.get(lock.journalPath)!.text))
        .toMatchObject({ phase: "lease-created", heartbeatAt: "2023-11-14T22:13:20.090Z" });
      expect(runtime.activeAnchors.has(lock.anchorPath)).toBe(true);
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    });

    await expect(result).resolves.toBe("owned");
    expect(runtime.maxNativeOwners).toBe(1);
    const finalJournal = parseLockRecoveryJournalForTesting(runtime.files.get(lock.journalPath)!.text);
    expect(finalJournal).toMatchObject({ schemaVersion: 2, phase: "idle" });
    expect(finalJournal?.generation).toBeGreaterThan(0);
    expect(runtime.directories.has(lock.compatibilityPath)).toBe(false);
    expect(runtime.activeAnchors.size).toBe(0);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
    const find = (fragment: string): number => runtime.events.findIndex((event) => event.includes(fragment));
    expect(find("journal:intent:")).toBeLessThan(find(`mkdir:${lock.compatibilityPath}`));
    expect(find("journal:barrier-created:")).toBeLessThan(find(`protect:${lock.compatibilityPath}`));
    expect(find(`create:${leasePath}.tokengraph-write-v2.tmp`)).toBeLessThan(find("journal:lease-created:"));
    expect(find("journal:cleanup:")).toBeLessThan(find(`unlink:${leasePath}`));
    expect(find(`unlink:${leasePath}`)).toBeLessThan(find(`release-compat:${lock.compatibilityPath}`));
    expect(find(`release-compat:${lock.compatibilityPath}`)).toBeLessThan(find(`rmdir:${lock.compatibilityPath}`));
    const finalIdleEvent = `journal:idle:${String(finalJournal?.generation)}`;
    expect(find(`rmdir:${lock.compatibilityPath}`)).toBeLessThan(runtime.events.lastIndexOf(finalIdleEvent));
    expect(runtime.events.lastIndexOf(finalIdleEvent)).toBeLessThan(find(`release-anchor:${lock.anchorPath}`));
    const generations = runtime.journalRecords.map((record) => Number(record.generation));
    expect(generations).toEqual(generations.map((_value, index) => index));
    for (let index = 1; index < runtime.journalRecords.length; index += 1) {
      expect(runtime.journalRecords[index]?.predecessor).toEqual({
        generation: index - 1,
        identity: runtime.journalTargetIdentities[index - 1]
      });
    }
    expect(runtime.events).toContain("schedule:9");
  });

  it("keeps heartbeat timestamps monotonic across wall-clock rollback", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "clock-rollback.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    let heartbeatAt = "";

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.advance(-10_000);
      await runtime.flushHeartbeats();
      heartbeatAt = (JSON.parse(runtime.files.get(leasePath)!.text) as { heartbeatAt: string }).heartbeatAt;
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(heartbeatAt).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("closed journal recovery table", () => {
  it("removes only the fixed crash temporary beside an idle journal", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "journal-temp.json");
    const runtime = new FakeLockRuntime();
    const temporaryPath = `${lock.journalPath}.tokengraph-write-v2.tmp`;
    runtime.files.set(temporaryPath, {
      identity: "dead-journal-temp", text: "partial", nlink: 1, mode: 0o600
    });

    await expect(runWithFileLockForTesting(lock, async () => "owned", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(runtime.files.has(temporaryPath)).toBe(false);
  });

  it("reconciles complete generation-zero bootstrap and predecessor-bound successor cuts", async () => {
    const cases = ["complete-bootstrap-temp", "post-rename-bootstrap", "bound-successor"] as const;
    for (const name of cases) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${name}.json`);
      const runtime = new FakeLockRuntime();
      const temporaryPath = `${lock.journalPath}.tokengraph-write-v2.tmp`;
      const generationZero = { schemaVersion: 2, generation: 0, phase: "idle" } as const;
      if (name === "complete-bootstrap-temp") {
        runtime.files.set(temporaryPath, {
          identity: "journal-0", text: `${JSON.stringify(generationZero)}\n`, nlink: 1, mode: 0o600
        });
      } else {
        runtime.files.set(lock.journalPath, {
          identity: "journal-0", text: `${JSON.stringify(generationZero)}\n`, nlink: 1, mode: 0o600
        });
        if (name === "bound-successor") {
          const timestamp = new Date(runtime.now() - TEST_POLICY.staleMs - 1).toISOString();
          const relativeLegacyName = `${name}.json.lock`;
          const successor = {
            schemaVersion: 2,
            generation: 1,
            predecessor: { generation: 0, identity: "journal-0" },
            relativeLegacyName,
            keyHash: createHash("sha256").update(relativeLegacyName).digest("hex"),
            pid: 77,
            nonce: "10000000-0000-4000-8000-000000000001",
            phase: "intent",
            startedAt: timestamp,
            heartbeatAt: timestamp,
            pendingBarrier: { operation: "create" }
          };
          runtime.files.set(temporaryPath, {
            identity: "journal-1", text: `${JSON.stringify(successor)}\n`, nlink: 1, mode: 0o600
          });
          runtime.liveness.set(77, "dead");
        }
      }

      await expect(runWithFileLockForTesting(lock, async () => name, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), name).resolves.toBe(name);
      expect(parseLockRecoveryJournalForTesting(runtime.files.get(lock.journalPath)!.text), name)
        .toMatchObject({ schemaVersion: 2, phase: "idle" });
      expect(runtime.files.has(temporaryPath), name).toBe(false);
    }
  });

  it("preserves invalid bootstrap targets and complete unbound successors", async () => {
    for (const name of ["invalid-target", "unbound-successor"] as const) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${name}.json`);
      const runtime = new FakeLockRuntime();
      const temporaryPath = `${lock.journalPath}.tokengraph-write-v2.tmp`;
      const target = name === "invalid-target" ? "partial" : `${JSON.stringify({
        schemaVersion: 2, generation: 0, phase: "idle"
      })}\n`;
      const temporary = name === "invalid-target" ? "partial-temp" : `${JSON.stringify({
        ...staleJournal(runtime, `${name}.json.lock`, "intent"),
        generation: 1,
        predecessor: { generation: 0, identity: "foreign-target" }
      })}\n`;
      runtime.files.set(lock.journalPath, { identity: "journal-target", text: target, nlink: 1, mode: 0o600 });
      runtime.files.set(temporaryPath, { identity: "journal-temp", text: temporary, nlink: 1, mode: 0o600 });

      await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), name).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
      expect(runtime.files.get(lock.journalPath)?.identity, name).toBe("journal-target");
      expect(runtime.files.get(temporaryPath)?.identity, name).toBe("journal-temp");
    }
  });

  it("preserves bound journal successors until their filesystem row preconditions hold", async () => {
    for (const row of [
      "intent-rollback", "cleanup-barrier-only", "cleanup-barrier-absent", "pending-create-finalize"
    ] as const) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${row}.json`);
      const runtime = new FakeLockRuntime();
      const barrierIdentity = "barrier";
      const leasePath = join(lock.compatibilityPath, "lease.json");
      let current: Record<string, unknown>;
      let successor: Record<string, unknown>;
      if (row === "intent-rollback") {
        current = staleJournal(runtime, `${row}.json.lock`, "intent");
        successor = { schemaVersion: 2, generation: 2, phase: "idle",
          predecessor: { generation: 1, identity: "journal" } };
        runtime.directories.set(lock.compatibilityPath, { identity: barrierIdentity, mode: 0o700 });
      } else if (row === "cleanup-barrier-only" || row === "cleanup-barrier-absent") {
        current = staleJournal(runtime, `${row}.json.lock`, "cleanup", {
          barrierIdentity, leaseIdentity: "lease"
        });
        const { leaseIdentity: _leaseIdentity, ...barrierOnly } = current;
        successor = { ...barrierOnly, generation: 2,
          predecessor: { generation: 1, identity: "journal" } };
        if (row === "cleanup-barrier-only") {
          runtime.directories.set(lock.compatibilityPath, { identity: barrierIdentity, mode: 0o700 });
          runtime.files.set(leasePath, {
            identity: "lease", text: `${JSON.stringify(staleLease(runtime))}\n`, nlink: 1, mode: 0o600
          });
        }
      } else {
        const leaseText = `${JSON.stringify(staleLease(runtime))}\n`;
        current = {
          ...staleJournal(runtime, `${row}.json.lock`, "barrier-created", { barrierIdentity }),
          pendingLeaseWrite: {
            operation: "create", payloadSha256: createHash("sha256").update(leaseText).digest("hex"),
            temporaryIdentity: "expected-lease"
          }
        };
        const { pendingLeaseWrite: _pendingLeaseWrite, ...leaseCreated } = current;
        successor = { ...leaseCreated, generation: 2,
          predecessor: { generation: 1, identity: "journal" }, phase: "lease-created",
          leaseIdentity: "expected-lease" };
        runtime.directories.set(lock.compatibilityPath, { identity: barrierIdentity, mode: 0o700 });
      }
      const journalTemporary = `${lock.journalPath}.tokengraph-write-v2.tmp`;
      runtime.files.set(lock.journalPath, {
        identity: "journal", text: `${JSON.stringify(current)}\n`, nlink: 1, mode: 0o600
      });
      runtime.files.set(journalTemporary, {
        identity: "journal-successor", text: `${JSON.stringify(successor)}\n`, nlink: 1, mode: 0o600
      });
      runtime.liveness.set(77, "dead");
      expect(parseLockRecoveryJournalForTesting(runtime.files.get(lock.journalPath)!.text), `${row}:target`)
        .toBeDefined();
      expect(parseLockRecoveryJournalForTesting(runtime.files.get(journalTemporary)!.text), `${row}:successor`)
        .toBeDefined();
      expect(validateLockRecoveryTransitionForTesting(current, successor, "journal"), `${row}:transition`)
        .toBe(true);

      const attempt = runWithFileLockForTesting(lock, async () => "unexpected", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      });
      await expect(attempt, row).rejects.toBeTruthy();
      expect(runtime.files.get(lock.journalPath)?.identity, row).toBe("journal");
      expect(runtime.files.get(journalTemporary)?.identity, row).toBe("journal-successor");
      if (row === "cleanup-barrier-only") expect(runtime.files.get(leasePath)?.identity).toBe("lease");
    }
  });

  it("resolves recorded pending lease create and replace cuts before dead-owner cleanup", async () => {
    const cases = [
      "create-missing", "create-temp", "create-post-rename",
      "replace-missing", "replace-temp", "replace-post-rename"
    ] as const;
    for (const name of cases) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${name}.json`);
      const runtime = new FakeLockRuntime();
      const barrierIdentity = "barrier";
      const leasePath = join(lock.compatibilityPath, "lease.json");
      const temporaryPath = `${leasePath}.tokengraph-write-v2.tmp`;
      const leaseText = `${JSON.stringify(staleLease(runtime))}\n`;
      const temporaryIdentity = "new-lease";
      const operation = name.startsWith("create") ? "create" : "replace";
      const oldIdentity = "old-lease";
      runtime.directories.set(lock.compatibilityPath, { identity: barrierIdentity, mode: 0o700 });
      const record = {
        ...staleJournal(runtime, `${name}.json.lock`, operation === "create" ? "barrier-created" : "lease-created", {
          barrierIdentity,
          ...(operation === "replace" ? { leaseIdentity: oldIdentity } : {})
        }),
        pendingLeaseWrite: {
          operation,
          ...(operation === "replace" ? { fromIdentity: oldIdentity } : {}),
          payloadSha256: createHash("sha256").update(leaseText).digest("hex"),
          temporaryIdentity
        }
      };
      if (name.endsWith("missing")) {
        if (operation === "replace") {
          runtime.files.set(leasePath, { identity: oldIdentity, text: leaseText, nlink: 1, mode: 0o600 });
        }
      } else if (name.endsWith("temp")) {
        if (operation === "replace") {
          runtime.files.set(leasePath, { identity: oldIdentity, text: leaseText, nlink: 1, mode: 0o600 });
        }
        runtime.files.set(temporaryPath, {
          identity: temporaryIdentity, text: leaseText, nlink: 1, mode: 0o600
        });
      } else {
        runtime.files.set(leasePath, {
          identity: temporaryIdentity, text: leaseText, nlink: 1, mode: 0o600
        });
      }
      runtime.files.set(lock.journalPath, {
        identity: "journal", text: `${JSON.stringify(record)}\n`, nlink: 1, mode: 0o600
      });
      runtime.liveness.set(77, "dead");

      await expect(runWithFileLockForTesting(lock, async () => name, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), name).resolves.toBe(name);
      expect(runtime.files.has(temporaryPath), name).toBe(false);
      expect(runtime.directories.has(lock.compatibilityPath), name).toBe(false);
      expect(runtime.events.filter((event) => event === "schedule:9").length, name).toBe(1);
    }
  });

  it("preserves a pending replacement when the old target identity changed", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "pending-replace-foreign.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    const temporaryPath = `${leasePath}.tokengraph-write-v2.tmp`;
    const leaseText = `${JSON.stringify(staleLease(runtime))}\n`;
    runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o700 });
    runtime.files.set(leasePath, { identity: "foreign-lease", text: leaseText, nlink: 1, mode: 0o600 });
    runtime.files.set(temporaryPath, { identity: "new-lease", text: leaseText, nlink: 1, mode: 0o600 });
    runtime.files.set(lock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify({
        ...staleJournal(runtime, "pending-replace-foreign.json.lock", "lease-created", {
          barrierIdentity: "barrier", leaseIdentity: "old-lease"
        }),
        pendingLeaseWrite: {
          operation: "replace", fromIdentity: "old-lease",
          payloadSha256: createHash("sha256").update(leaseText).digest("hex"), temporaryIdentity: "new-lease"
        }
      })}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(leasePath)?.identity).toBe("foreign-lease");
    expect(runtime.files.get(temporaryPath)?.identity).toBe("new-lease");
  });

  it("preserves an unrecorded temporary when its pending target precondition is false", async () => {
    for (const operation of ["create", "replace"] as const) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `pending-${operation}-foreign-target.json`);
      const runtime = new FakeLockRuntime();
      const leasePath = join(lock.compatibilityPath, "lease.json");
      const temporaryPath = `${leasePath}.tokengraph-write-v2.tmp`;
      const leaseText = `${JSON.stringify(staleLease(runtime))}\n`;
      runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o700 });
      runtime.files.set(leasePath, { identity: "foreign-target", text: leaseText, nlink: 1, mode: 0o600 });
      runtime.files.set(temporaryPath, { identity: "unrecorded-temp", text: "partial", nlink: 1, mode: 0o600 });
      runtime.files.set(lock.journalPath, {
        identity: "journal",
        text: `${JSON.stringify({
          ...staleJournal(runtime, `pending-${operation}-foreign-target.json.lock`,
            operation === "create" ? "barrier-created" : "lease-created", {
              barrierIdentity: "barrier",
              ...(operation === "replace" ? { leaseIdentity: "old-target" } : {})
            }),
          pendingLeaseWrite: {
            operation,
            ...(operation === "replace" ? { fromIdentity: "old-target" } : {}),
            payloadSha256: createHash("sha256").update(leaseText).digest("hex")
          }
        })}\n`,
        nlink: 1,
        mode: 0o600
      });
      runtime.liveness.set(77, "dead");

      await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), operation).rejects.toBeTruthy();
      expect(runtime.files.get(leasePath)?.identity, operation).toBe("foreign-target");
      expect(runtime.files.get(temporaryPath)?.identity, operation).toBe("unrecorded-temp");
    }
  });

  it("preserves an unrecorded lease temporary outside a pending transition", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "lease-temp.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    const temporaryPath = `${leasePath}.tokengraph-write-v2.tmp`;
    runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o700 });
    runtime.files.set(leasePath, {
      identity: "lease", text: `${JSON.stringify(staleLease(runtime))}\n`, nlink: 1, mode: 0o600
    });
    runtime.files.set(temporaryPath, {
      identity: "dead-lease-temp", text: "partial", nlink: 1, mode: 0o600
    });
    runtime.files.set(lock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify(staleJournal(runtime, "lease-temp.json.lock", "lease-created", {
        barrierIdentity: "barrier", leaseIdentity: "lease"
      }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "recovered", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(temporaryPath)?.identity).toBe("dead-lease-temp");
  });

  it("keeps repeated crash residue to one barrier and fixed temporaries", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "repeated-crash.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    for (let crash = 0; crash < 20; crash += 1) {
      runtime.directories.set(lock.compatibilityPath, { identity: `barrier-${crash}`, mode: 0o700 });
      runtime.files.set(leasePath, {
        identity: `lease-${crash}`, text: `${JSON.stringify(staleLease(runtime))}\n`, nlink: 1, mode: 0o600
      });
      runtime.files.set(lock.journalPath, {
        identity: `journal-${crash}`,
        text: `${JSON.stringify(staleJournal(runtime, "repeated-crash.json.lock", "lease-created", {
          barrierIdentity: `barrier-${crash}`, leaseIdentity: `lease-${crash}`
        }))}\n`,
        nlink: 1,
        mode: 0o600
      });
      runtime.liveness.set(77, "dead");
      await runWithFileLockForTesting(lock, async () => undefined, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      });
      expect([...runtime.directories.keys()].filter((path) => path.endsWith(".lock")).length).toBeLessThanOrEqual(1);
      expect([...runtime.files.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("preserves a cleanup lease when the journal did not record its identity", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "run-a.json");
    const runtime = new FakeLockRuntime();
    const barrierIdentity = "crashed-barrier";
    const leasePath = join(lock.compatibilityPath, "lease.json");
    runtime.directories.set(lock.domainRoot, { identity: "root", mode: 0o700 });
    runtime.directories.set(lock.compatibilityPath, { identity: barrierIdentity, mode: 0o700 });
    runtime.files.set(leasePath, {
      identity: "unrecorded-lease",
      text: `${JSON.stringify(staleLease(runtime))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.files.set(lock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify(staleJournal(runtime, "run-a.json.lock", "cleanup", { barrierIdentity }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(leasePath)?.identity).toBe("unrecorded-lease");
    expect(runtime.directories.get(lock.compatibilityPath)?.identity).toBe(barrierIdentity);
  });

  it("recovers each authorized dead crash row and starts exactly one new owner", async () => {
    const accepted = [
      { name: "intent plus absent barrier", phase: "intent", barrier: "absent", lease: false },
      { name: "intent plus adoptable empty barrier", phase: "intent", barrier: "matching", lease: false },
      { name: "barrier-created plus empty barrier", phase: "barrier-created", barrier: "matching", lease: false },
      { name: "lease-created plus matching lease", phase: "lease-created", barrier: "matching", lease: true },
      { name: "cleanup plus matching lease", phase: "cleanup", barrier: "matching", lease: true },
      { name: "cleanup plus empty barrier", phase: "cleanup", barrier: "matching", lease: false },
      { name: "cleanup plus absent barrier", phase: "cleanup", barrier: "absent", lease: false }
    ] as const;

    for (const row of accepted) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `row-${accepted.indexOf(row)}.json`);
      const runtime = new FakeLockRuntime();
      const relativeName = `row-${accepted.indexOf(row)}.json.lock`;
      const barrierIdentity = "crashed-barrier";
      const leaseIdentity = "crashed-lease";
      if (row.barrier === "matching") {
        runtime.directories.set(lock.compatibilityPath, { identity: barrierIdentity, mode: 0o700 });
      }
      if (row.lease) {
        runtime.files.set(join(lock.compatibilityPath, "lease.json"), {
          identity: leaseIdentity,
          text: `${JSON.stringify(staleLease(runtime))}\n`,
          nlink: 1,
          mode: 0o600
        });
      }
      const fields = row.phase === "intent" ? {} : {
        barrierIdentity,
        ...(row.phase === "lease-created" || row.phase === "cleanup" && row.lease ? { leaseIdentity } : {})
      };
      runtime.files.set(lock.journalPath, {
        identity: "crashed-journal",
        text: `${JSON.stringify(staleJournal(runtime, relativeName, row.phase, fields))}\n`,
        nlink: 1,
        mode: 0o600
      });
      runtime.liveness.set(77, "dead");

      await expect(runWithFileLockForTesting(lock, async () => row.name, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      })).resolves.toBe(row.name);
      expect(parseLockRecoveryJournalForTesting(runtime.files.get(lock.journalPath)!.text), row.name)
        .toMatchObject({ schemaVersion: 2, phase: "idle" });
      expect(runtime.directories.has(lock.compatibilityPath), row.name).toBe(false);
      expect(runtime.maxNativeOwners, row.name).toBe(1);
    }
  });

  it("recovers the journal-recorded key before starting a different key in the same domain", async () => {
    const root = await temporaryWorkspace();
    const currentLock = await canonicalPersistenceLock(root, "runs", "current.json");
    const recordedLock = await canonicalPersistenceLock(root, "runs", "recorded.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(recordedLock.compatibilityPath, "lease.json");
    runtime.directories.set(recordedLock.compatibilityPath, { identity: "recorded-barrier", mode: 0o700 });
    runtime.files.set(leasePath, {
      identity: "recorded-lease", text: `${JSON.stringify(staleLease(runtime))}\n`, nlink: 1, mode: 0o600
    });
    runtime.files.set(currentLock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify(staleJournal(runtime, "recorded.json.lock", "lease-created", {
        barrierIdentity: "recorded-barrier", leaseIdentity: "recorded-lease"
      }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(currentLock, async () => "current", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("current");
    expect(runtime.directories.has(recordedLock.compatibilityPath)).toBe(false);
    expect(runtime.directories.has(currentLock.compatibilityPath)).toBe(false);
    expect(runtime.events.indexOf(`rmdir:${recordedLock.compatibilityPath}`))
      .toBeLessThan(runtime.events.indexOf(`mkdir:${currentLock.compatibilityPath}`));
  });

  it("fails every unauthorized phase/object row without deleting crash evidence", async () => {
    const rejected = [
      { name: "intent-nonempty", phase: "intent", barrier: "matching", lease: false, extra: true },
      { name: "barrier-absent", phase: "barrier-created", barrier: "absent", lease: false },
      { name: "barrier-mismatch", phase: "barrier-created", barrier: "mismatch", lease: false },
      { name: "lease-missing", phase: "lease-created", barrier: "matching", lease: false },
      { name: "cleanup-extra", phase: "cleanup", barrier: "matching", lease: false, extra: true }
    ] as const;

    for (const row of rejected) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${row.name}.json`);
      const runtime = new FakeLockRuntime();
      const relativeName = `${row.name}.json.lock`;
      if (row.barrier !== "absent") {
        runtime.directories.set(lock.compatibilityPath, {
          identity: row.barrier === "mismatch" ? "foreign-barrier" : "recorded-barrier",
          mode: 0o700
        });
      }
      if ("extra" in row && row.extra) {
        runtime.files.set(join(lock.compatibilityPath, "foreign.txt"), {
          identity: "foreign", text: "x", nlink: 1, mode: 0o600
        });
      }
      const fields = row.phase === "intent" ? {} : {
        barrierIdentity: "recorded-barrier",
        ...(row.phase === "lease-created" ? { leaseIdentity: "missing-lease" } : {})
      };
      runtime.files.set(lock.journalPath, {
        identity: "crashed-journal",
        text: `${JSON.stringify(staleJournal(runtime, relativeName, row.phase, fields))}\n`,
        nlink: 1,
        mode: 0o600
      });
      runtime.liveness.set(77, "dead");

      await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), row.name).rejects.toBeTruthy();
      expect(runtime.files.get(lock.journalPath)?.identity, row.name).toBe("crashed-journal");
      if (row.barrier !== "absent") expect(runtime.directories.has(lock.compatibilityPath), row.name).toBe(true);
    }
  });

  it("requires two unchanged stale reads and confirmed-dead liveness", async () => {
    const states = [
      { name: "fresh-dead", liveness: "dead", age: TEST_POLICY.staleMs },
      { name: "stale-alive-pid-reuse", liveness: "alive", age: TEST_POLICY.staleMs + 1 },
      { name: "stale-unknown", liveness: "unknown", age: TEST_POLICY.staleMs + 1 }
    ] as const;
    for (const state of states) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${state.name}.json`);
      const runtime = new FakeLockRuntime();
      const timestamp = new Date(runtime.now() - state.age).toISOString();
      const journal = {
        ...staleJournal(runtime, `${state.name}.json.lock`, "intent"),
        startedAt: timestamp,
        heartbeatAt: timestamp
      };
      runtime.files.set(lock.journalPath, {
        identity: "occupied-journal", text: `${JSON.stringify(journal)}\n`, nlink: 1, mode: 0o600
      });
      runtime.liveness.set(77, state.liveness);

      await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), state.name).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
      expect(runtime.files.get(lock.journalPath)?.identity, state.name).toBe("occupied-journal");
    }
  });

  it("treats malformed and linked journals and leases as occupied", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "linked.json");
    const runtime = new FakeLockRuntime();
    runtime.files.set(lock.journalPath, { identity: "linked", text: "{}\n", nlink: 2, mode: 0o600 });

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(lock.journalPath)?.identity).toBe("linked");
  });

  it("rejects duplicate-key diagnostic JSON instead of accepting the last value", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "duplicate.json");
    const runtime = new FakeLockRuntime();
    const valid = JSON.stringify(staleJournal(runtime, "duplicate.json.lock", "intent"));
    runtime.files.set(lock.journalPath, {
      identity: "duplicate-journal",
      text: `${valid.replace("{\"schemaVersion\":2,", "{\"schemaVersion\":2,\"schemaVersion\":2,")}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(lock.journalPath)?.identity).toBe("duplicate-journal");
  });

  it("never permits a forged journal to name native infrastructure as its barrier", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "infrastructure.json");
    const runtime = new FakeLockRuntime();
    const infrastructureName = ".tokengraph-native-anchor-v2.lock";
    runtime.files.set(lock.journalPath, {
      identity: "forged-journal",
      text: `${JSON.stringify(staleJournal(runtime, infrastructureName, "cleanup", {
        barrierIdentity: "forged-barrier"
      }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(lock.journalPath)?.identity).toBe("forged-journal");
  });

  it("rejects a permissive POSIX barrier before recovery", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "permissive.json");
    const runtime = new FakeLockRuntime("linux");
    runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o777 });
    runtime.files.set(lock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify(staleJournal(runtime, "permissive.json.lock", "barrier-created", {
        barrierIdentity: "barrier"
      }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "UNSAFE_LOCK_DIRECTORY" });
    expect(runtime.directories.get(lock.compatibilityPath)?.mode).toBe(0o777);
  });

  it("rejects a same-nonce lease whose owner tuple does not match the journal", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "owner-mismatch.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o700 });
    runtime.files.set(leasePath, {
      identity: "lease",
      text: `${JSON.stringify({ ...staleLease(runtime), pid: 78 })}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.files.set(lock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify(staleJournal(runtime, "owner-mismatch.json.lock", "lease-created", {
        barrierIdentity: "barrier",
        leaseIdentity: "lease"
      }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");
    runtime.liveness.set(78, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_LEASE_OCCUPIED" });
    expect(runtime.files.get(leasePath)?.identity).toBe("lease");
  });

  it("preserves a malformed, linked, or second-read-replaced lease", async () => {
    for (const mutation of ["malformed", "linked", "replaced"] as const) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${mutation}.json`);
      const runtime = new FakeLockRuntime();
      const leasePath = join(lock.compatibilityPath, "lease.json");
      runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o700 });
      runtime.files.set(leasePath, {
        identity: "lease",
        text: mutation === "malformed" ? "{}\n" : `${JSON.stringify(staleLease(runtime))}\n`,
        nlink: mutation === "linked" ? 2 : 1,
        mode: 0o600
      });
      runtime.files.set(lock.journalPath, {
        identity: "journal",
        text: `${JSON.stringify(staleJournal(runtime, `${mutation}.json.lock`, "lease-created", {
          barrierIdentity: "barrier", leaseIdentity: "lease"
        }))}\n`,
        nlink: 1,
        mode: 0o600
      });
      runtime.liveness.set(77, "dead");
      if (mutation === "replaced") {
        let waits = 0;
        runtime.waitHook = () => { waits += 1; };
        const originalWait = runtime.wait.bind(runtime);
        runtime.wait = async (milliseconds, signal) => {
          await originalWait(milliseconds, signal);
          if (runtime.events.filter((event) => event === "wait:1").length === 2) {
            runtime.files.set(leasePath, {
              identity: "replacement", text: `${JSON.stringify(staleLease(runtime))}\n`, nlink: 1, mode: 0o600
            });
          }
        };
      }

      await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), mutation).rejects.toMatchObject({ code: "LOCK_LEASE_OCCUPIED" });
      expect(runtime.files.has(leasePath), mutation).toBe(true);
    }
  });
});

describe("bounded native and diagnostic failures", () => {
  it("retries only native busy and then acquires", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "task-a.json");
    const runtime = new FakeLockRuntime();
    runtime.busyAttempts = 2;

    await expect(runWithFileLockForTesting(lock, async () => "acquired", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("acquired");
    expect(runtime.events.filter((event) => event.startsWith("acquire:")).length).toBe(3);
    expect(runtime.events.filter((event) => event === "wait:1").length).toBeGreaterThanOrEqual(2);
  });

  it("times out after the exact bounded acquire attempts", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "task-timeout.json");
    const runtime = new FakeLockRuntime();
    runtime.busyAttempts = 10;

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(runtime.events.filter((event) => event.startsWith("acquire:")).length).toBe(3);
    expect(runtime.events.filter((event) => event === "wait:1").length).toBe(2);
    expect(runtime.events.some((event) => event.includes(":intent"))).toBe(false);
  });

  it("honors abort while waiting without another native attempt", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "task-abort.json");
    const runtime = new FakeLockRuntime();
    const controller = new AbortController();
    runtime.busyAttempts = 10;
    runtime.waitHook = () => controller.abort();

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", { signal: controller.signal }, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_ABORTED" });
    expect(runtime.events.filter((event) => event.startsWith("acquire:")).length).toBe(1);
  });

  it("does not retry a nontransient native failure", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "task-native-error.json");
    const runtime = new FakeLockRuntime();
    const failure = coded("NATIVE_LOCK_ERROR");
    runtime.acquisitionFailure = failure;

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toBe(failure);
    expect(runtime.events.filter((event) => event.startsWith("acquire:")).length).toBe(1);
  });

  it("retries bounded Windows diagnostic EPERM without changing kernel ownership", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "task-windows.json");
    const runtime = new FakeLockRuntime("win32");
    const journalTemporary = `${lock.journalPath}.tokengraph-write-v2.tmp`;
    runtime.transientFailures.set(`create:${journalTemporary}`, { remaining: 2, code: "EPERM", skip: 1 });

    await expect(runWithFileLockForTesting(lock, async () => "owned", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(runtime.events.filter((event) => event === `create:${journalTemporary}`).length).toBeGreaterThanOrEqual(3);
    expect(runtime.maxNativeOwners).toBe(1);
  });

  it("retries a transient Windows heartbeat read", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "heartbeat-read.json");
    const runtime = new FakeLockRuntime("win32");
    const leasePath = join(lock.compatibilityPath, "lease.json");

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.transientFailures.set(`read:${leasePath}`, { remaining: 1, code: "EPERM" });
      await runtime.flushHeartbeats();
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(runtime.events.filter((event) => event === `read:${leasePath}`).length).toBeGreaterThanOrEqual(3);
  });

  it("retries a transient Windows heartbeat replacement", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "heartbeat-write.json");
    const runtime = new FakeLockRuntime("win32");
    const leasePath = join(lock.compatibilityPath, "lease.json");

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.transientFailures.set(`create:${leasePath}.tokengraph-write-v2.tmp`, { remaining: 1, code: "EACCES" });
      await runtime.flushHeartbeats();
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(runtime.events.filter((event) => event === `create:${leasePath}.tokengraph-write-v2.tmp`).length)
      .toBeGreaterThanOrEqual(3);
  });

  it("retries a transient Windows cleanup lease read", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "cleanup-read.json");
    const runtime = new FakeLockRuntime("win32");
    const leasePath = join(lock.compatibilityPath, "lease.json");

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.transientFailures.set(`read:${leasePath}`, { remaining: 1, code: "EBUSY" });
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    })).resolves.toBe("owned");
  });

  it("retries a transient Windows cleanup lease unlink", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "cleanup-unlink.json");
    const runtime = new FakeLockRuntime("win32");
    const leasePath = join(lock.compatibilityPath, "lease.json");

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.transientFailures.set(`unlink:${leasePath}`, { remaining: 1, code: "EPERM" });
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    })).resolves.toBe("owned");
  });

  it("retries a transient Windows cleanup barrier inspection", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "cleanup-inspect.json");
    const runtime = new FakeLockRuntime("win32");

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.transientFailures.set(`inspect:${lock.compatibilityPath}`, { remaining: 1, code: "EACCES" });
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    })).resolves.toBe("owned");
  });

  it("retries a transient Windows cleanup barrier removal", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "cleanup-rmdir.json");
    const runtime = new FakeLockRuntime("win32");

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.transientFailures.set(`rmdir:${lock.compatibilityPath}`, { remaining: 1, code: "EBUSY" });
      return "owned";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    })).resolves.toBe("owned");
  });

  it("ignores acquisition aborts after native ownership begins", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "tasks", "post-acquire-abort.json");
    const runtime = new FakeLockRuntime("win32");
    const controller = new AbortController();

    await expect(runWithFileLockForTesting(lock, async () => {
      controller.abort();
      runtime.advance(90);
      await runtime.flushHeartbeats();
      return "owned";
    }, { signal: controller.signal }, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(runtime.activeAnchors.size).toBe(0);
    expect(runtime.directories.has(lock.compatibilityPath)).toBe(false);
  });
});

describe("failure-preserving cleanup", () => {
  it("cleans after an owner exception and returns the original error", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "vault", "manifest.json");
    const runtime = new FakeLockRuntime();
    const ownerError = new Error("owner failed");

    await expect(runWithFileLockForTesting(lock, async () => { throw ownerError; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toBe(ownerError);
    expect(runtime.directories.has(lock.compatibilityPath)).toBe(false);
    expect(runtime.activeAnchors.size).toBe(0);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });

  it("preserves an explicit undefined rejection instead of converting it to success", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "vault", "undefined-rejection.json");
    const runtime = new FakeLockRuntime();
    const outcome = await runWithFileLockForTesting(lock, async () => Promise.reject(undefined), {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    }).then(
      () => ({ state: "fulfilled" as const }),
      (reason: unknown) => ({ state: "rejected" as const, reason })
    );
    expect(outcome).toEqual({ state: "rejected", reason: undefined });
    expect(runtime.activeAnchors.size).toBe(0);
  });

  it("returns cleanup failure alone and preserves ambiguous state", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "vault", "cleanup.json");
    const runtime = new FakeLockRuntime();
    runtime.cleanupFailure = "unlink";

    await expect(runWithFileLockForTesting(lock, async () => "completed", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "EIO" });
    expect(runtime.files.has(join(lock.compatibilityPath, "lease.json"))).toBe(true);
    expect(runtime.directories.has(lock.compatibilityPath)).toBe(true);
    expect(runtime.activeAnchors.size).toBe(0);
  });

  it("returns operation and cleanup failures in ordered AggregateError", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "vault", "aggregate.json");
    const runtime = new FakeLockRuntime();
    const ownerError = new Error("owner failed");
    runtime.cleanupFailure = "unlink";

    let caught: unknown;
    try {
      await runWithFileLockForTesting(lock, async () => { throw ownerError; }, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([ownerError, expect.objectContaining({ code: "EIO" })]);
    expect(runtime.activeAnchors.size).toBe(0);
  });

  it("preserves a nonce-replaced lease and never updates or deletes it", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "vault", "nonce.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    const foreign = { ...staleLease(runtime, "20000000-0000-4000-8000-000000000002"), pid: 88 };

    await expect(runWithFileLockForTesting(lock, async () => {
      runtime.files.set(leasePath, {
        identity: "foreign-lease", text: `${JSON.stringify(foreign)}\n`, nlink: 1, mode: 0o600
      });
      await expect(runtime.flushHeartbeats()).rejects.toMatchObject({ code: "LOCK_LEASE_OCCUPIED" });
      return "operation-finished";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_LEASE_OCCUPIED" });
    expect(runtime.files.get(leasePath)).toMatchObject({ identity: "foreign-lease" });
    expect(runtime.events).not.toContain(`unlink:${leasePath}`);
    expect(runtime.activeAnchors.size).toBe(0);
  });
});

describe("durable transition failure windows", () => {
  it("finishes a same-process journal commit after rename reported failure", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "wiki", "journal-receipt.json");
    const runtime = new FakeLockRuntime();
    runtime.transientFailures.set(`rename-after:${lock.journalPath}.tokengraph-write-v2.tmp`, {
      remaining: 1,
      code: "EIO",
      skip: 1
    });

    await expect(runWithFileLockForTesting(lock, async () => "owned", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).resolves.toBe("owned");
    expect(parseLockRecoveryJournalForTesting(runtime.files.get(lock.journalPath)!.text))
      .toMatchObject({ schemaVersion: 2, phase: "idle" });
    expect(runtime.events).toContain(`rename-after:${lock.journalPath}.tokengraph-write-v2.tmp`);
  });

  it("does not retroactively authorize a pre-existing lease temporary", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "wiki", "live-preflight.json");
    const runtime = new FakeLockRuntime();
    const leaseTemporary = `${join(lock.compatibilityPath, "lease.json")}.tokengraph-write-v2.tmp`;
    let ran = false;
    runtime.createHook = (path, text) => {
      if (path !== `${lock.journalPath}.tokengraph-write-v2.tmp`) return;
      const record = parseLockRecoveryJournalForTesting(text);
      if (record?.phase !== "barrier-created" || record.pendingLeaseWrite !== undefined) return;
      runtime.files.set(leaseTemporary, { identity: "pre-existing-temp", text: "partial", nlink: 1, mode: 0o600 });
      runtime.createHook = undefined;
    };

    await expect(runWithFileLockForTesting(lock, async () => { ran = true; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: TEST_POLICY
    })).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: "LOCK_JOURNAL_UNSAFE" }), expect.anything()]
    });
    expect(ran).toBe(false);
    expect(runtime.files.get(leaseTemporary)?.identity).toBe("pre-existing-temp");
    expect(runtime.journalRecords.some((record) => record.pendingLeaseWrite !== undefined)).toBe(false);
  });

  it("rejects a same-text journal replacement with a foreign identity", async () => {
    const parent = await temporaryWorkspace();
    const target = join(parent, ".tokengraph-native-journal-v2.lock");
    const text = `${JSON.stringify({ phase: "intent" })}\n`;
    const original = await createProductionProtocolFileForTesting(target, text);
    await unlink(target);
    await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
    const temporary = `${target}.tokengraph-write-v2.tmp`;
    const candidate = await createProductionProtocolFileForTesting(temporary, text);

    await expect(replaceProductionProtocolFileForTesting(
      temporary, target, candidate.identity, original.identity
    ))
      .rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
  });

  it("rejects a same-text lease replacement with a foreign identity", async () => {
    const parent = await temporaryWorkspace();
    const target = join(parent, "lease.json");
    const text = `${JSON.stringify({ nonce: "10000000-0000-4000-8000-000000000001" })}\n`;
    const original = await createProductionProtocolFileForTesting(target, text);
    await unlink(target);
    await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
    const temporary = `${target}.tokengraph-write-v2.tmp`;
    const candidate = await createProductionProtocolFileForTesting(temporary, text);

    await expect(replaceProductionProtocolFileForTesting(
      temporary, target, candidate.identity, original.identity
    ))
      .rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
  });

  it("preserves a foreign fixed temporary without deleting it", async () => {
    const parent = await temporaryWorkspace();
    const target = join(parent, "journal.json");
    const targetSnapshot = await createProductionProtocolFileForTesting(target, "{}\n");
    const foreignTemporary = `${target}.tokengraph-write-v2.tmp`;
    await createProductionProtocolFileForTesting(foreignTemporary, "foreign");
    const before = await lstat(foreignTemporary, { bigint: true });

    await expect(replaceProductionProtocolFileForTesting(
      foreignTemporary, target, "unrecorded-identity", targetSnapshot.identity
    ))
      .rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    const after = await lstat(foreignTemporary, { bigint: true });
    expect(`${after.dev}:${after.ino}:${after.birthtimeNs}`).toBe(`${before.dev}:${before.ino}:${before.birthtimeNs}`);
    expect(await readFile(foreignTemporary, "utf8")).toBe("foreign");
  });

  it("checks the complete barrier entry set before removing any recognized temp", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "wiki", "foreign-extra.json");
    const runtime = new FakeLockRuntime();
    const leasePath = join(lock.compatibilityPath, "lease.json");
    const fixedTemporary = `${leasePath}.tokengraph-write-v2.tmp`;
    const foreignPath = join(lock.compatibilityPath, "foreign.txt");
    runtime.directories.set(lock.compatibilityPath, { identity: "barrier", mode: 0o700 });
    runtime.files.set(leasePath, {
      identity: "lease", text: `${JSON.stringify(staleLease(runtime))}\n`, nlink: 1, mode: 0o600
    });
    runtime.files.set(fixedTemporary, { identity: "temp", text: "partial", nlink: 1, mode: 0o600 });
    runtime.files.set(foreignPath, { identity: "foreign", text: "foreign", nlink: 1, mode: 0o600 });
    runtime.files.set(lock.journalPath, {
      identity: "journal",
      text: `${JSON.stringify(staleJournal(runtime, "foreign-extra.json.lock", "lease-created", {
        barrierIdentity: "barrier", leaseIdentity: "lease"
      }))}\n`,
      nlink: 1,
      mode: 0o600
    });
    runtime.liveness.set(77, "dead");

    await expect(runWithFileLockForTesting(lock, async () => "unexpected", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    })).rejects.toMatchObject({ code: "LOCK_JOURNAL_UNSAFE" });
    expect(runtime.files.get(fixedTemporary)?.identity).toBe("temp");
    expect(runtime.files.get(foreignPath)?.identity).toBe("foreign");
    expect(runtime.files.get(leasePath)?.identity).toBe("lease");
  });

  it("bounds production JournalV2 bootstrap and successor residue across every durable crash cut", async () => {
    const points = ["after-create", "after-write", "after-sync", "after-rename", "after-directory-flush"] as const;
    for (const mode of ["bootstrap", "successor"] as const) {
      for (const point of points) {
        const root = await temporaryWorkspace();
        const lock = await canonicalPersistenceLock(root, "runs", "production-cut.json");
        await mkdir(lock.domainRoot, { recursive: true, mode: 0o700 });
        const target = lock.journalPath;
        const temporary = `${target}.tokengraph-write-v2.tmp`;
        const generationZero = { schemaVersion: 2, generation: 0, phase: "idle" } as const;
        const generationZeroText = `${JSON.stringify(generationZero)}\n`;
        let expectedTargetIdentity: string | undefined;
        let text = generationZeroText;
        const base = new FakeLockRuntime(process.platform);
        if (mode === "successor") {
          const created = await createProductionProtocolFileForTesting(temporary, generationZeroText);
          const committed = await replaceProductionProtocolFileForTesting(
            temporary, target, created.identity, undefined
          );
          expectedTargetIdentity = committed.identity;
          const timestamp = new Date(base.now() - TEST_POLICY.staleMs - 1).toISOString();
          const relativeLegacyName = "production-cut.json.lock";
          text = `${JSON.stringify({
            schemaVersion: 2,
            generation: 1,
            predecessor: { generation: 0, identity: committed.identity },
            relativeLegacyName,
            keyHash: createHash("sha256").update(relativeLegacyName).digest("hex"),
            pid: 77,
            nonce: "10000000-0000-4000-8000-000000000001",
            phase: "intent",
            startedAt: timestamp,
            heartbeatAt: timestamp,
            pendingBarrier: { operation: "create" }
          })}\n`;
          base.liveness.set(77, "dead");
        }

        if (point === "after-create" || point === "after-write" || point === "after-sync") {
          await expect(createProductionProtocolFileForTesting(temporary, text, point), `${mode}:${point}`)
            .rejects.toMatchObject({ code: "SIMULATED_DURABLE_WRITE_CRASH" });
        } else {
          const created = await createProductionProtocolFileForTesting(temporary, text);
          await expect(replaceProductionProtocolFileForTesting(
            temporary, target, created.identity, expectedTargetIdentity, point
          ), `${mode}:${point}`).rejects.toMatchObject({ code: "SIMULATED_DURABLE_WRITE_CRASH" });
        }
        expect((await readdir(lock.domainRoot)).filter((entry) => entry.endsWith(".tmp")).length,
          `${mode}:${point}:pre-recovery`).toBeLessThanOrEqual(1);

        await expect(runWithFileLockForTesting(lock, async () => `${mode}:${point}`, {}, {
          capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
          runtime: productionBackedRuntime(base),
          policy: TEST_POLICY
        }), `${mode}:${point}`).resolves.toBe(`${mode}:${point}`);

        const finalText = await readFile(target, "utf8");
        expect(parseLockRecoveryJournalForTesting(finalText), `${mode}:${point}`)
          .toMatchObject({ schemaVersion: 2, phase: "idle" });
        expect((await readdir(lock.domainRoot)).filter((entry) => entry.endsWith(".tmp")),
          `${mode}:${point}:post-recovery`).toEqual([]);
        expect((await readdir(lock.domainRoot)).filter((entry) =>
          entry.endsWith(".lock") && !entry.startsWith(".tokengraph-native-")),
        `${mode}:${point}:barriers`).toEqual([]);
      }
    }
  });

  it("reconciles production pending barrier lease and cleanup crash rows in a fresh runtime", async () => {
    const rows = [
      "pending-barrier", "create-temp", "create-target", "replace-temp", "replace-target",
      "cleanup-both", "cleanup-barrier"
    ] as const;
    for (const row of rows) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "runs", `${row}.json`);
      await mkdir(lock.domainRoot, { recursive: true, mode: 0o700 });
      const base = new FakeLockRuntime(process.platform);
      base.liveness.set(77, "dead");
      const relativeLegacyName = `${row}.json.lock`;
      const active = staleJournal(base, relativeLegacyName,
        row === "pending-barrier" ? "intent" :
          row.startsWith("create") ? "barrier-created" :
            row.startsWith("replace") ? "lease-created" : "cleanup");
      let record: Record<string, unknown> = active;
      await mkdir(lock.compatibilityPath, { mode: 0o700 });
      const barrierStats = await lstat(lock.compatibilityPath, { bigint: true });
      const barrierIdentity = `${barrierStats.dev}:${barrierStats.ino}:${barrierStats.birthtimeNs}`;
      if (row !== "pending-barrier") {
        record = { ...record, barrierIdentity };
        const leasePath = join(lock.compatibilityPath, "lease.json");
        const temporaryPath = `${leasePath}.tokengraph-write-v2.tmp`;
        const leaseText = `${JSON.stringify(staleLease(base))}\n`;
        if (row === "create-temp") {
          const temporary = await createProductionProtocolFileForTesting(temporaryPath, leaseText);
          record = { ...record, pendingLeaseWrite: {
            operation: "create", payloadSha256: createHash("sha256").update(leaseText).digest("hex"),
            temporaryIdentity: temporary.identity
          } };
        } else if (row === "create-target") {
          const target = await createProductionProtocolFileForTesting(leasePath, leaseText);
          record = { ...record, pendingLeaseWrite: {
            operation: "create", payloadSha256: createHash("sha256").update(leaseText).digest("hex"),
            temporaryIdentity: target.identity
          } };
        } else if (row === "replace-temp" || row === "replace-target") {
          const old = await createProductionProtocolFileForTesting(leasePath, leaseText);
          const temporary = await createProductionProtocolFileForTesting(temporaryPath, leaseText);
          record = { ...record, leaseIdentity: old.identity, pendingLeaseWrite: {
            operation: "replace", fromIdentity: old.identity,
            payloadSha256: createHash("sha256").update(leaseText).digest("hex"),
            temporaryIdentity: temporary.identity
          } };
          if (row === "replace-target") {
            await replaceProductionProtocolFileForTesting(
              temporaryPath, leasePath, temporary.identity, old.identity
            );
          }
        } else if (row === "cleanup-both") {
          const lease = await createProductionProtocolFileForTesting(leasePath, leaseText);
          record = { ...record, leaseIdentity: lease.identity };
        }
      }
      await createProductionProtocolFileForTesting(lock.journalPath, `${JSON.stringify(record)}\n`);

      await expect(runWithFileLockForTesting(lock, async () => row, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime: productionBackedRuntime(base),
        policy: TEST_POLICY
      }), row).resolves.toBe(row);
      expect(parseLockRecoveryJournalForTesting(await readFile(lock.journalPath, "utf8")), row)
        .toMatchObject({ schemaVersion: 2, phase: "idle" });
      expect((await readdir(lock.domainRoot)).filter((entry) => entry.endsWith(".tmp")), row).toEqual([]);
      expect((await readdir(lock.domainRoot)).filter((entry) =>
        entry.endsWith(".lock") && !entry.startsWith(".tokengraph-native-")), row).toEqual([]);
    }
  });

  it("rolls back owned setup state after failures at each pre-operation flush boundary", async () => {
    const windows = [
      { name: "intent-flush", event: "journal", skip: 1 },
      { name: "barrier-flush", event: "journal", skip: 2 },
      { name: "lease-flush", event: "lease", skip: 0 },
      { name: "lease-journal-flush", event: "journal", skip: 5 }
    ] as const;
    for (const window of windows) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "wiki", `${window.name}.json`);
      const runtime = new FakeLockRuntime();
      const event = window.event === "journal" ? `create:${lock.journalPath}.tokengraph-write-v2.tmp` :
        `create:${join(lock.compatibilityPath, "lease.json")}.tokengraph-write-v2.tmp`;
      runtime.transientFailures.set(event, { remaining: 1, code: "EIO", skip: window.skip });
      let ran = false;

      await expect(runWithFileLockForTesting(lock, async () => { ran = true; }, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), window.name).rejects.toMatchObject({ code: "EIO" });
      expect(ran, window.name).toBe(false);
      expect(runtime.directories.has(lock.compatibilityPath), window.name).toBe(false);
      expect(runtime.activeAnchors.size, window.name).toBe(0);
      expect(sameProcessLockQueueSizeForTesting(), window.name).toBe(0);
    }
  });

  it("preserves the exact recoverable residue after each cleanup flush boundary fails", async () => {
    const windows = [
      { name: "cleanup-journal", event: "journal", skip: 6, expectLease: true, expectBarrier: true },
      { name: "lease-unlink", event: "unlink", skip: 0, expectLease: true, expectBarrier: true },
      { name: "barrier-rmdir", event: "rmdir", skip: 0, expectLease: false, expectBarrier: true },
      { name: "journal-clear", event: "journal", skip: 8, expectLease: false, expectBarrier: false }
    ] as const;
    for (const window of windows) {
      const root = await temporaryWorkspace();
      const lock = await canonicalPersistenceLock(root, "wiki", `${window.name}.json`);
      const runtime = new FakeLockRuntime();
      const leasePath = join(lock.compatibilityPath, "lease.json");
      const event = window.event === "journal" ? `create:${lock.journalPath}.tokengraph-write-v2.tmp` :
        window.event === "unlink" ? `unlink:${leasePath}` : `rmdir:${lock.compatibilityPath}`;
      runtime.transientFailures.set(event, { remaining: 1, code: "EIO", skip: window.skip });

      await expect(runWithFileLockForTesting(lock, async () => "operation-complete", {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
        runtime,
        policy: TEST_POLICY
      }), window.name).rejects.toMatchObject({ code: "EIO" });
      expect(runtime.files.has(leasePath), window.name).toBe(window.expectLease);
      expect(runtime.directories.has(lock.compatibilityPath), window.name).toBe(window.expectBarrier);
      expect(runtime.activeAnchors.size, window.name).toBe(0);
    }
  });
});

describe("same-process and domain serialization", () => {
  it("physically removes many canceled waiters behind one hung owner", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "canceled-retention.json");
    const runtime = new FakeLockRuntime();
    const gate = deferred();
    let firstEntered = false;
    const first = runWithFileLockForTesting(lock, async () => {
      firstEntered = true;
      await gate.promise;
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => firstEntered);

    const canceled = Array.from({ length: 200 }, () => {
      const controller = new AbortController();
      controller.abort();
      return runWithFileLockForTesting(lock, async () => "unexpected", { signal: controller.signal }, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
      }).catch((error: unknown) => (error as { code?: unknown }).code);
    });
    await expect(Promise.all(canceled)).resolves.toEqual(Array.from({ length: 200 }, () => "LOCK_ABORTED"));
    expect(sameProcessLockQueueEntryCountForTesting()).toBe(1);

    let successorEntered = false;
    const successor = runWithFileLockForTesting(lock, async () => { successorEntered = true; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    expect(successorEntered).toBe(false);
    expect(sameProcessLockQueueEntryCountForTesting()).toBe(2);
    gate.resolve();
    await Promise.all([first, successor]);
    await until(() => sameProcessLockQueueSizeForTesting() === 0);
    expect(sameProcessLockQueueEntryCountForTesting()).toBe(0);
  });

  it("rejects an already-aborted queued owner before its predecessor settles", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "queued-pre-abort.json");
    const runtime = new FakeLockRuntime();
    const gate = deferred();
    let firstEntered = false;
    let secondRan = false;
    const first = runWithFileLockForTesting(lock, async () => {
      firstEntered = true;
      await gate.promise;
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => firstEntered);
    const controller = new AbortController();
    controller.abort();
    let queuedOutcome = "pending";
    const second = runWithFileLockForTesting(lock, async () => { secondRan = true; }, {
      signal: controller.signal
    }, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    }).then(
      () => { queuedOutcome = "fulfilled"; },
      (error: unknown) => { queuedOutcome = String((error as { code?: unknown }).code); }
    );
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const promptOutcome = queuedOutcome;
    gate.resolve();
    await Promise.all([first, second]);
    await until(() => sameProcessLockQueueSizeForTesting() === 0);

    expect(promptOutcome).toBe("LOCK_ABORTED");
    expect(secondRan).toBe(false);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });

  it("rejects a queued owner promptly when its signal aborts during the wait", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "queued-abort.json");
    const runtime = new FakeLockRuntime();
    const gate = deferred();
    let firstEntered = false;
    let secondRan = false;
    const first = runWithFileLockForTesting(lock, async () => {
      firstEntered = true;
      await gate.promise;
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => firstEntered);
    const controller = new AbortController();
    let queuedOutcome = "pending";
    const second = runWithFileLockForTesting(lock, async () => { secondRan = true; }, {
      signal: controller.signal
    }, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    }).then(
      () => { queuedOutcome = "fulfilled"; },
      (error: unknown) => { queuedOutcome = String((error as { code?: unknown }).code); }
    );
    controller.abort();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const promptOutcome = queuedOutcome;
    gate.resolve();
    await Promise.all([first, second]);
    await until(() => sameProcessLockQueueSizeForTesting() === 0);

    expect(promptOutcome).toBe("LOCK_ABORTED");
    expect(secondRan).toBe(false);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });

  it("times out a queued owner without letting its successor overlap the predecessor", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "queued-timeout.json");
    const runtime = new FakeLockRuntime();
    runtime.queueTimeouts = 1;
    const gate = deferred();
    let firstEntered = false;
    let secondRan = false;
    let thirdEntered = false;
    const first = runWithFileLockForTesting(lock, async () => {
      firstEntered = true;
      await gate.promise;
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => firstEntered);
    let queuedOutcome = "pending";
    const second = runWithFileLockForTesting(lock, async () => { secondRan = true; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    }).then(
      () => { queuedOutcome = "fulfilled"; },
      (error: unknown) => { queuedOutcome = String((error as { code?: unknown }).code); }
    );
    const third = runWithFileLockForTesting(lock, async () => { thirdEntered = true; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    const promptOutcome = queuedOutcome;
    expect(thirdEntered).toBe(false);
    gate.resolve();
    await Promise.all([first, second, third]);
    await until(() => sameProcessLockQueueSizeForTesting() === 0);

    expect(promptOutcome).toBe("LOCK_TIMEOUT");
    expect(secondRan).toBe(false);
    expect(thirdEntered).toBe(true);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });

  it("never overlaps the same exact path and removes a settled queue", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "serialized.json");
    const runtime = new FakeLockRuntime();
    const gate = deferred();
    let active = 0;
    let maximum = 0;
    const enter = async (name: string, waitForGate: boolean): Promise<string> => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (waitForGate) await gate.promise;
      active -= 1;
      return name;
    };

    const first = runWithFileLockForTesting(lock, () => enter("first", true), {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => active === 1);
    const second = runWithFileLockForTesting(lock, () => enter("second", false), {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await Promise.resolve();
    expect(active).toBe(1);
    expect(sameProcessLockQueueSizeForTesting()).toBe(1);
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(maximum).toBe(1);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });

  it("continues the exact-path queue after a rejected owner", async () => {
    const root = await temporaryWorkspace();
    const lock = await canonicalPersistenceLock(root, "runs", "rejected.json");
    const runtime = new FakeLockRuntime();
    const firstError = new Error("first rejected");
    const first = runWithFileLockForTesting(lock, async () => { throw firstError; }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    const second = runWithFileLockForTesting(lock, async () => "second", {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });

    await expect(first).rejects.toBe(firstError);
    await expect(second).resolves.toBe("second");
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });

  it("serializes different keys in one domain on its fixed anchor", async () => {
    const root = await temporaryWorkspace();
    const firstLock = await canonicalPersistenceLock(root, "tasks", "one.json");
    const secondLock = await canonicalPersistenceLock(root, "tasks", "two.json");
    expect(firstLock.anchorPath).toBe(secondLock.anchorPath);
    const runtime = new FakeLockRuntime();
    const gate = deferred();
    let firstEntered = false;
    let secondEntered = false;
    const first = runWithFileLockForTesting(firstLock, async () => {
      firstEntered = true;
      await gate.promise;
      return "first";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => firstEntered);
    runtime.waitHook = () => gate.resolve();
    const second = runWithFileLockForTesting(secondLock, async () => {
      secondEntered = true;
      return "second";
    }, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }),
      runtime,
      policy: { ...TEST_POLICY, attempts: 20 }
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(secondEntered).toBe(true);
    expect(runtime.maxNativeOwners).toBe(1);
  });

  it("allows different registered domains to overlap", async () => {
    const root = await temporaryWorkspace();
    const runLock = await canonicalPersistenceLock(root, "runs", "one.json");
    const taskLock = await canonicalPersistenceLock(root, "tasks", "one.json");
    const runtime = new FakeLockRuntime();
    const gate = deferred();
    let entered = 0;
    const operation = async (): Promise<void> => {
      entered += 1;
      await gate.promise;
    };
    const first = runWithFileLockForTesting(runLock, operation, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    const second = runWithFileLockForTesting(taskLock, operation, {}, {
      capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
    });
    await until(() => entered === 2);
    expect(runtime.maxNativeOwners).toBe(2);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("keeps infrastructure bounded across 1,000 unique run task and artifact keys", async () => {
    const root = await temporaryWorkspace();
    const runtime = new FakeLockRuntime();
    const domains = ["runs", "tasks", "artifacts"] as const;
    for (let index = 0; index < 1_000; index += 1) {
      const domain = domains[index % domains.length];
      const lock = await canonicalPersistenceLock(root, domain, `key-${index}.json`);
      await runWithFileLockForTesting(lock, async () => undefined, {}, {
        capability: activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true }), runtime, policy: TEST_POLICY
      });
    }
    for (const domain of domains) {
      const example = await canonicalPersistenceLock(root, domain, "example.json");
      expect(runtime.entries(example.domainRoot)).toEqual([
        ".tokengraph-native-anchor-v2.lock",
        ".tokengraph-native-journal-v2.lock"
      ]);
      expect(parseLockRecoveryJournalForTesting(runtime.files.get(example.journalPath)!.text))
        .toMatchObject({ schemaVersion: 2, phase: "idle", predecessor: expect.any(Object) });
    }
    expect([...runtime.directories.keys()].filter((path) => path.endsWith(".lock"))).toEqual([]);
    expect(sameProcessLockQueueSizeForTesting()).toBe(0);
  });
});
