import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { externalRuntimeEnvironment } from "./support/externalRuntime.js";
import { canonicalPersistenceLock, type LockDomain } from "../src/core/lockDomain.js";
import { getRepositoryIdentity, getRepositorySetupWarnings, LOCAL_EXCLUDE_WARNING } from "../src/core/repositoryIdentity.js";
import { withFileLock } from "../src/core/storage.js";

interface ProbeRecord {
  status: string;
  owner: number;
  maxOwners: number;
}

interface ProbeRequest {
  operation: "hold" | "try" | "crash" | "release";
  workspaceRoot: string;
  domain: LockDomain;
  key: string;
  coordinationRoot: string;
  timeoutMs: number;
  holdMs?: number;
  clockOffsetMs?: number;
  cancelMs?: number;
  failOperation?: boolean;
  pauseAt?: "after-barrier-create" | "after-journal-barrier-created" | "after-journal-lease-created";
  activate: boolean;
}

const probePath = resolve("scripts", "native-lock-probe.mjs");
const legacyWorkerPath = resolve("tests", "fixtures", "legacy-file-lock-worker.mjs");
const execFile = promisify(execFileCallback);
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function waitForExists(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for native lock probe state.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function expectRenameRefused(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch {
    return;
  }
  await rename(destination, source);
  throw new Error("A live native lock allowed its anchor or domain root to be renamed.");
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectExit(new Error("Native lock probe did not exit before its deadline."));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectExit(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      resolveExit(code);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function runProbe(request: ProbeRequest): Promise<{ records: ProbeRecord[]; code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [probePath], {
    cwd: process.cwd(),
    env: externalRuntimeEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 8_192) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 8_192) child.kill("SIGKILL");
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  try {
    const code = await waitForExit(child, request.timeoutMs + 5_000);
    const records = stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as ProbeRecord);
    return { records, code, stderr };
  } finally {
    children.delete(child);
  }
}

function startKillableProbe(request: ProbeRequest): {
  child: ChildProcessWithoutNullStreams;
  records: ProbeRecord[];
  waitForStatus(status: string, timeoutMs?: number): Promise<void>;
  completion: Promise<{ code: number | null; stderr: string }>;
} {
  const child = spawn(process.execPath, [probePath], {
    cwd: process.cwd(),
    env: externalRuntimeEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const records: ProbeRecord[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 8_192) child.kill("SIGKILL");
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) records.push(JSON.parse(line) as ProbeRecord);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 8_192) child.kill("SIGKILL");
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const completion = waitForExit(child, request.timeoutMs + 5_000).then((code) => {
    children.delete(child);
    return { code, stderr };
  }, (error) => {
    children.delete(child);
    throw error;
  });
  return {
    child,
    records,
    async waitForStatus(status: string, timeoutMs = 2_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!records.some((record) => record.status === status)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for probe status ${status}.`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    },
    completion
  };
}

async function runLegacyWorker(request: { lockPath: string; markerPath: string; holdMs: number }): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [legacyWorkerPath], {
    cwd: process.cwd(),
    env: externalRuntimeEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  try {
    return { code: await waitForExit(child, 5_000), stdout, stderr };
  } finally {
    children.delete(child);
  }
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native lock process integration", () => {
  it("allows exactly one native owner across six processes", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-process-");
    const coordinationRoot = await temporaryRoot("tg-lock-counter-");
    const runs = await Promise.all(Array.from({ length: 6 }, () => runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot,
      timeoutMs: 10_000,
      holdMs: 100,
      activate: true
    })));
    const records = runs.flatMap((run) => run.records);
    expect(runs.every((run) => run.code === 0), JSON.stringify(runs)).toBe(true);
    expect(Math.max(...records.map((record) => record.maxOwners))).toBe(1);
    expect(records.filter((record) => record.status === "acquired")).toHaveLength(6);
  }, 30_000);

  it("reacquires within two seconds after the owning process aborts", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-crash-");
    const coordinationRoot = await temporaryRoot("tg-lock-counter-");
    const crashed = await runProbe({
      operation: "crash",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot,
      timeoutMs: 10_000,
      clockOffsetMs: -31_000,
      activate: true
    });
    expect(crashed.records).toContainEqual(expect.objectContaining({ status: "acquired" }));

    const startedAt = Date.now();
    const recovered = await runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-recovered-counter-"),
      timeoutMs: 2_000,
      activate: true
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.records).toContainEqual(expect.objectContaining({ status: "acquired" }));
  }, 30_000);

  it("keeps an upgraded nonempty compatibility directory intact against the frozen v0.23.1 worker", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-upgrade-");
    const markerPath = join(workspaceRoot, "legacy-entered.txt");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    await withFileLock(lock, async () => {
      const legacy = await runLegacyWorker({ lockPath: lock.compatibilityPath, markerPath, holdMs: 0 });
      expect(legacy.code, legacy.stderr).toBe(1);
      expect(JSON.parse(legacy.stdout)).toEqual({ status: "timeout" });
      await expect(access(join(lock.compatibilityPath, "lease.json"))).resolves.toBeUndefined();
      await expect(access(markerPath)).rejects.toThrow();
    });
    await expect(access(lock.compatibilityPath)).rejects.toThrow();
    expect(await readFile(lock.journalPath, "utf8")).toMatch(/"phase":\s*"idle"/u);
  }, 30_000);

  it("cancels a real child promptly while it waits for a native anchor", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-cancel-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    const holder = runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-holder-counter-"),
      timeoutMs: 8_000,
      holdMs: 3_500,
      activate: true
    });
    await waitForExists(lock.compatibilityPath);
    const startedAt = Date.now();
    const canceled = await runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-waiter-counter-"),
      timeoutMs: 5_000,
      cancelMs: 100,
      activate: true
    });
    const canceledElapsed = Date.now() - startedAt;
    const held = await holder;
    expect(canceledElapsed).toBeLessThan(2_000);
    expect(canceled.code).toBe(1);
    expect(canceled.records).toContainEqual(expect.objectContaining({ status: "LOCK_ABORTED" }));
    expect(held.code, held.stderr).toBe(0);
  }, 30_000);

  it("cleans the real barrier and lease after a child operation throws", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-exception-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    const failed = await runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-exception-counter-"),
      timeoutMs: 5_000,
      failOperation: true,
      activate: true
    });
    expect(failed.code).toBe(1);
    expect(failed.records).toContainEqual(expect.objectContaining({ status: "PROBE_OPERATION_FAILURE" }));
    await expect(access(lock.compatibilityPath)).rejects.toThrow();
    expect(await readFile(lock.journalPath, "utf8")).toMatch(/"phase":\s*"idle"/u);
  }, 30_000);

  it("refuses an unactivated child before creating lock state", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-unactivated-");
    const refused = await runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-unactivated-counter-"),
      timeoutMs: 2_000,
      activate: false
    });
    expect(refused.code).toBe(1);
    expect(refused.records).toEqual([expect.objectContaining({ status: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" })]);
    await expect(access(join(workspaceRoot, ".tokengraph"))).rejects.toThrow();
  });

  it("serializes different keys in one domain and overlaps different domains", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-domains-");
    const sameCounter = await temporaryRoot("tg-lock-same-counter-");
    const sameDomain = await Promise.all(["config.json", "routing.json"].map((key) => runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key,
      coordinationRoot: sameCounter,
      timeoutMs: 5_000,
      holdMs: 400,
      activate: true
    })));
    expect(sameDomain.every((run) => run.code === 0), JSON.stringify(sameDomain)).toBe(true);
    expect(Math.max(...sameDomain.flatMap((run) => run.records).map((record) => record.maxOwners))).toBe(1);

    const differentCounter = await temporaryRoot("tg-lock-different-counter-");
    const differentDomains = await Promise.all([
      runProbe({ operation: "try", workspaceRoot, domain: "workspace-state", key: "config.json", coordinationRoot: differentCounter, timeoutMs: 5_000, holdMs: 400, activate: true }),
      runProbe({ operation: "try", workspaceRoot, domain: "runs", key: "run.json", coordinationRoot: differentCounter, timeoutMs: 5_000, holdMs: 400, activate: true })
    ]);
    expect(differentDomains.every((run) => run.code === 0), JSON.stringify(differentDomains)).toBe(true);
    expect(Math.max(...differentDomains.flatMap((run) => run.records).map((record) => record.maxOwners))).toBe(2);
  }, 30_000);

  it("times out a real contender without disturbing the live owner", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-timeout-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    const holder = runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-timeout-holder-"),
      timeoutMs: 8_000,
      holdMs: 3_500,
      clockOffsetMs: -31_000,
      activate: true
    });
    await waitForExists(lock.compatibilityPath);
    const timedOut = await runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-timeout-waiter-"),
      timeoutMs: 5_000,
      activate: true
    });
    const held = await holder;
    expect(timedOut.code).toBe(1);
    expect(timedOut.records).toContainEqual(expect.objectContaining({ status: "LOCK_TIMEOUT" }));
    expect(held.code, held.stderr).toBe(0);
    await expect(access(lock.compatibilityPath)).rejects.toThrow();
  }, 30_000);

  it("preserves an existing legacy lock file and fails the upgraded owner closed", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-legacy-file-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    await mkdir(lock.domainRoot, { recursive: true });
    await writeFile(lock.compatibilityPath, "legacy-owner\n", { flag: "wx", mode: 0o600 });
    const before = await lstat(lock.compatibilityPath, { bigint: true });
    await expect(withFileLock(lock, async () => undefined)).rejects.toMatchObject({ code: "LEGACY_LOCK_BLOCKED" });
    const after = await lstat(lock.compatibilityPath, { bigint: true });
    expect(`${after.dev}:${after.ino}:${after.birthtimeNs}`).toBe(`${before.dev}:${before.ino}:${before.birthtimeNs}`);
    expect(await readFile(lock.compatibilityPath, "utf8")).toBe("legacy-owner\n");
  });

  it("uses the exact Git common-directory exclude barrier and updates the exclude once", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-git-info-");
    await execFile("git", ["init", "-q", workspaceRoot]);
    await getRepositoryIdentity(workspaceRoot);
    await getRepositoryIdentity(workspaceRoot);
    const lock = await canonicalPersistenceLock(workspaceRoot, "git-info", "exclude");
    const exclude = join(workspaceRoot, ".git", "info", "exclude");
    expect(lock.compatibilityPath).toBe(`${exclude}.lock`);
    expect((await readFile(exclude, "utf8")).split(/\r?\n/u).filter((line) => line.trim() === ".tokengraph/")).toHaveLength(1);
    await expect(access(lock.compatibilityPath)).rejects.toThrow();
    await expect(access(lock.anchorPath)).resolves.toBeUndefined();
    await expect(access(lock.journalPath)).resolves.toBeUndefined();
  }, 30_000);

  it("warns and preserves Git exclude when a legacy exclude lock file exists", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-git-legacy-");
    await execFile("git", ["init", "-q", workspaceRoot]);
    const exclude = join(workspaceRoot, ".git", "info", "exclude");
    const original = await readFile(exclude, "utf8");
    await writeFile(`${exclude}.lock`, "legacy-owner\n", { flag: "wx", mode: 0o600 });
    await getRepositoryIdentity(workspaceRoot);
    expect(getRepositorySetupWarnings(workspaceRoot)).toEqual([LOCAL_EXCLUDE_WARNING]);
    expect(await readFile(exclude, "utf8")).toBe(original);
    expect(await readFile(`${exclude}.lock`, "utf8")).toBe("legacy-owner\n");
  }, 30_000);

  it("preserves a legacy creator that enters after upgraded cleanup and blocks the next upgraded owner", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-cleanup-race-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    await withFileLock(lock, async () => undefined);
    const markerPath = join(workspaceRoot, "legacy-entered.txt");
    const legacy = runLegacyWorker({ lockPath: lock.compatibilityPath, markerPath, holdMs: 1_000 });
    await waitForExists(lock.compatibilityPath);
    await expect(withFileLock(lock, async () => undefined)).rejects.toMatchObject({ code: "LEGACY_LOCK_BLOCKED" });
    await expect(access(markerPath)).resolves.toBeUndefined();
    expect((await lstat(lock.compatibilityPath)).isFile()).toBe(true);
    const legacyResult = await legacy;
    expect(legacyResult.code, legacyResult.stderr).toBe(0);
    expect(JSON.parse(legacyResult.stdout)).toEqual({ status: "acquired" });
    await expect(access(lock.compatibilityPath)).rejects.toThrow();
  }, 30_000);

  it("releases kernel ownership when the parent terminates a live child and leaves no process behind", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-parent-kill-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    const owned = startKillableProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-parent-kill-counter-"),
      timeoutMs: 15_000,
      holdMs: 10_000,
      clockOffsetMs: -31_000,
      activate: true
    });
    await owned.waitForStatus("acquired");
    const pid = owned.child.pid!;
    expect(owned.child.kill("SIGKILL")).toBe(true);
    const terminated = await owned.completion;
    expect(terminated.code).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));

    const recovered = await runProbe({
      operation: "try",
      workspaceRoot,
      domain: "workspace-state",
      key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-parent-recovered-counter-"),
      timeoutMs: 2_000,
      activate: true
    });
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.records).toContainEqual(expect.objectContaining({ status: "acquired" }));
    await expect(access(lock.compatibilityPath)).rejects.toThrow();
  }, 30_000);

  it("kills recovery after stale intent adoption without creating the dead callback lease", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-adoption-kill-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    const first = startKillableProbe({
      operation: "try", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-adoption-first-"), timeoutMs: 15_000,
      clockOffsetMs: -31_000, pauseAt: "after-barrier-create", activate: true
    });
    await first.waitForStatus("paused");
    expect(first.child.kill("SIGKILL")).toBe(true);
    await first.completion;

    const recovery = startKillableProbe({
      operation: "try", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-adoption-recovery-"), timeoutMs: 15_000,
      pauseAt: "after-journal-barrier-created", activate: true
    });
    await recovery.waitForStatus("paused");
    await expect(access(join(lock.compatibilityPath, "lease.json"))).rejects.toThrow();
    expect(recovery.child.kill("SIGKILL")).toBe(true);
    await recovery.completion;

    const next = await runProbe({
      operation: "try", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-adoption-next-"), timeoutMs: 2_000, activate: true
    });
    expect(next.code, next.stderr).toBe(0);
    expect(next.records).toContainEqual(expect.objectContaining({ status: "acquired" }));
  }, 30_000);

  it("kills after lease finalization and recovers without running the dead callback", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-lease-kill-");
    const killed = startKillableProbe({
      operation: "try", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-lease-killed-"), timeoutMs: 15_000,
      clockOffsetMs: -31_000, pauseAt: "after-journal-lease-created", activate: true
    });
    await killed.waitForStatus("paused");
    expect(killed.records.some((record) => record.status === "acquired")).toBe(false);
    expect(killed.child.kill("SIGKILL")).toBe(true);
    await killed.completion;

    const recovered = await runProbe({
      operation: "try", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-lease-recovered-"), timeoutMs: 2_000, activate: true
    });
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.records.filter((record) => record.status === "acquired")).toHaveLength(1);
  }, 30_000);

  it.runIf(process.platform === "win32")("refuses anchor and domain-root rename while the Windows lock is live", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-rename-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    await withFileLock(lock, async () => {
      await expectRenameRefused(lock.anchorPath, `${lock.anchorPath}.moved`);
      await expectRenameRefused(lock.domainRoot, `${lock.domainRoot}-moved`);
    });
  });

  it("supports the bounded hold and release lifecycle operations", async () => {
    const workspaceRoot = await temporaryRoot("tg-lock-protocol-");
    const lock = await canonicalPersistenceLock(workspaceRoot, "workspace-state", "config.json");
    const holder = runProbe({
      operation: "hold", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-protocol-holder-"), timeoutMs: 5_000,
      holdMs: 500, activate: true
    });
    await waitForExists(lock.compatibilityPath);
    const released = await runProbe({
      operation: "release", workspaceRoot, domain: "workspace-state", key: "config.json",
      coordinationRoot: await temporaryRoot("tg-lock-protocol-release-"), timeoutMs: 5_000, activate: true
    });
    const held = await holder;
    expect(held.code, held.stderr).toBe(0);
    expect(released.code, released.stderr).toBe(0);
    expect(held.records.map((record) => record.status)).toEqual(["acquired", "released"]);
    expect(released.records.map((record) => record.status)).toEqual(["acquired", "released"]);
  }, 30_000);
});
