import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURRENT_CONFIG_SCHEMA_VERSION, DEFAULT_TOKEN_GRAPH_CONFIG, loadTokenGraphConfig, updateTokenGraphConfig } from "../src/core/config.js";
import { canonicalPersistenceLock } from "../src/core/lockDomain.js";
import { flushBufferedMemoryUses, MemoryStore } from "../src/core/memoryStore.js";
import { configPath } from "../src/core/persistence.js";
import { createTaskLedger, recordTaskEvent } from "../src/core/taskLedger.js";
import {
  flushWriteTelemetry,
  observeSuccessfulWrite,
  readWriteTelemetry,
  withFileLock,
  writeJsonAtomic,
  writeTelemetryPath
} from "../src/core/storage.js";
import { storageClassUsage } from "../src/core/storagePolicy.js";
import { discardTaskMemoryUses, flushTaskReportWrites, withTaskWriteLifecycle } from "../src/core/taskWriteFlush.js";
import { externalCliEntry, externalRuntimeEnvironment } from "./support/externalRuntime.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tg-p6-"));
  roots.push(root);
  return root;
}

function input(title: string) {
  return {
    type: "architecture" as const,
    title,
    body: `${title} body`,
    tags: ["phase6"]
  };
}

function runCli(root: string, script = "process.stdout.write('ok')"): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      externalCliEntry,
      "run",
      "--root", root,
      "--confirm-no-legacy-processes",
      "--",
      process.execPath,
      "--eval", script
    ], {
      env: externalRuntimeEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 6 low-write policy", () => {
  it("migrates schema-v3 storage config to balanced schema-v4 policy", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const legacyStorage: Partial<typeof DEFAULT_TOKEN_GRAPH_CONFIG.storage> = { ...DEFAULT_TOKEN_GRAPH_CONFIG.storage };
    delete legacyStorage.writePolicy;
    await writeFile(configPath(root), `${JSON.stringify({
      schemaVersion: 3,
      config: { ...DEFAULT_TOKEN_GRAPH_CONFIG, storage: legacyStorage }
    })}\n`);

    const config = await loadTokenGraphConfig(root);

    expect(config.storage.writePolicy).toBe("balanced");
    expect(JSON.parse(await readFile(configPath(root), "utf8"))).toMatchObject({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      config: { storage: { writePolicy: "balanced" } }
    });
  });

  it("serializes missing, corrupt, and partial config updates under one lock", async () => {
    const missingRoot = await makeRoot();
    await Promise.all([
      loadTokenGraphConfig(missingRoot),
      updateTokenGraphConfig(missingRoot, { storage: { writePolicy: "minimal" } })
    ]);
    expect((await loadTokenGraphConfig(missingRoot)).storage.writePolicy).toBe("minimal");

    const corruptRoot = await makeRoot();
    await mkdir(join(corruptRoot, ".tokengraph"), { recursive: true });
    await writeFile(configPath(corruptRoot), "{corrupt");
    await Promise.all([
      loadTokenGraphConfig(corruptRoot),
      updateTokenGraphConfig(corruptRoot, { runner: { timeoutMs: 12_345 } })
    ]);
    expect((await loadTokenGraphConfig(corruptRoot)).runner.timeoutMs).toBe(12_345);

    const updateRoot = await makeRoot();
    await Promise.all([
      updateTokenGraphConfig(updateRoot, { storage: { writePolicy: "minimal" } }),
      updateTokenGraphConfig(updateRoot, { runner: { timeoutMs: 23_456 } })
    ]);
    const merged = await loadTokenGraphConfig(updateRoot);
    expect(merged.storage.writePolicy).toBe("minimal");
    expect(merged.runner.timeoutMs).toBe(23_456);
  });

  it("skips an unchanged canonical payload and records only successful writes", async () => {
    const root = await makeRoot();
    const path = join(root, ".tokengraph", "value.json");

    await expect(writeJsonAtomic(path, { alpha: 1, beta: 2 }, { telemetry: { root, storageClass: "durable" } })).resolves.toBe(true);
    await expect(flushWriteTelemetry(root)).resolves.toBe(true);
    await expect(writeJsonAtomic(path, { beta: 2, alpha: 1 }, { telemetry: { root, storageClass: "durable" } })).resolves.toBe(false);
    await expect(flushWriteTelemetry(root)).resolves.toBe(false);

    const telemetry = await readWriteTelemetry(root);
    expect(telemetry.days).toHaveLength(1);
    expect(telemetry.days[0]?.classes.durable).toMatchObject({ operationCount: 1 });
  });

  it("persists bounded privacy-safe aggregates outside storage quotas", async () => {
    const root = await makeRoot();
    observeSuccessfulWrite({ root, storageClass: "runs" }, 17, 4096);
    observeSuccessfulWrite({ root, storageClass: "cache" }, 23);

    await flushWriteTelemetry(root);

    const raw = await readFile(writeTelemetryPath(root), "utf8");
    const telemetry = JSON.parse(raw);
    expect(telemetry).toMatchObject({
      schemaVersion: 1,
      days: [{
        sampledPeakRssBytes: expect.any(Number),
        classes: {
          runs: { operationCount: 1, logicalBytes: 17, physicalBytes: 4096 },
          cache: { operationCount: 1, logicalBytes: 23 }
        }
      }]
    });
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("prompt");
    await expect(storageClassUsage(root)).resolves.toMatchObject({ total: { bytes: 0, files: 0 } });
  });

  it("updates every same-day recall under durable policy", async () => {
    const root = await makeRoot();
    const filePath = join(root, ".tokengraph", "repository", "memory.json");
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const store = new MemoryStore(filePath, lock, { writePolicy: "durable", telemetry: { root, storageClass: "durable" } });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    await store.add(input("Durable recall"));
    await store.recall("durable recall");
    vi.setSystemTime(new Date("2026-09-01T11:00:00.000Z"));
    const recalled = await store.recall("durable recall");

    expect(recalled.memories[0]?.lastUsedAt).toBe("2026-09-01T11:00:00.000Z");
  });

  it("buffers minimal recall usage until task-completion flush", async () => {
    const root = await makeRoot();
    const filePath = join(root, ".tokengraph", "repository", "memory.json");
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const store = new MemoryStore(filePath, lock, { writePolicy: "minimal", telemetry: { root, storageClass: "durable" }, bufferScope: "task-a" });
    const created = await store.add(input("Minimal recall"));
    const before = await readFile(filePath, "utf8");

    await store.recall("minimal recall");
    expect(await readFile(filePath, "utf8")).toBe(before);

    await expect(flushBufferedMemoryUses(filePath, lock, "task-a", { telemetry: { root, storageClass: "durable" } })).resolves.toBe(true);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.memories.find((memory: { id: string }) => memory.id === created.id)?.lastUsedAt).toEqual(expect.any(String));
  });

  it("fails closed and preserves a multiply-linked atomic target", async () => {
    const root = await makeRoot();
    const path = join(root, ".tokengraph", "value.json");
    const alias = join(root, "linked-value.json");
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(path, "evidence\n");
    await link(path, alias);

    await expect(writeJsonAtomic(path, { replacement: true })).rejects.toThrow(/single-link regular file/i);

    await expect(readFile(path, "utf8")).resolves.toBe("evidence\n");
    await expect(readFile(alias, "utf8")).resolves.toBe("evidence\n");
  });

  it("bounds telemetry reads before parsing", async () => {
    const root = await makeRoot();
    const path = writeTelemetryPath(root);
    await mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true });
    const handle = await open(path, "w");
    try {
      await handle.truncate(256 * 1024 + 1);
    } finally {
      await handle.close();
    }

    await expect(readWriteTelemetry(root)).rejects.toThrow(/bounded validation limit/i);
  });

  it("preserves pending counters when malformed or future telemetry blocks a flush", async () => {
    const root = await makeRoot();
    const path = writeTelemetryPath(root);
    await mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true });
    observeSuccessfulWrite({ root, storageClass: "durable" }, 11);
    await writeFile(path, `${JSON.stringify({ schemaVersion: 2, days: [] })}\n`);

    await expect(flushWriteTelemetry(root)).rejects.toThrow(/newer.*refusing to overwrite/i);
    await expect(readFile(path, "utf8")).resolves.toContain('"schemaVersion":2');

    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, days: [] })}\n`);
    await expect(flushWriteTelemetry(root)).resolves.toBe(true);
    await expect(readWriteTelemetry(root)).resolves.toMatchObject({
      days: [{ classes: { durable: { operationCount: 1, logicalBytes: 11 } } }]
    });
  });

  it("observes config updates and migration backup writes", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(configPath(root), `${JSON.stringify({ schemaVersion: 3, config: DEFAULT_TOKEN_GRAPH_CONFIG })}\n`);

    await loadTokenGraphConfig(root);
    await updateTokenGraphConfig(root, { storage: { writePolicy: "minimal" } });
    await flushWriteTelemetry(root);

    const durable = (await readWriteTelemetry(root)).days.at(-1)?.classes.durable;
    expect(durable?.operationCount).toBeGreaterThanOrEqual(3);
    expect(durable?.logicalBytes).toBeGreaterThan(0);
  });

  it("rereads configuration under the migration lock before replacing it", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(configPath(root), `${JSON.stringify({ schemaVersion: 3, config: DEFAULT_TOKEN_GRAPH_CONFIG })}\n`);
    const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");
    let pendingLoad!: ReturnType<typeof loadTokenGraphConfig>;

    await withFileLock(lock, async () => {
      pendingLoad = loadTokenGraphConfig(root);
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      await writeFile(configPath(root), `${JSON.stringify({
        schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
        config: { ...DEFAULT_TOKEN_GRAPH_CONFIG, storage: { ...DEFAULT_TOKEN_GRAPH_CONFIG.storage, writePolicy: "minimal" } }
      })}\n`);
    });

    await expect(pendingLoad).resolves.toMatchObject({ storage: { writePolicy: "minimal" } });
    await expect(access(`${configPath(root)}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges successful write counters from concurrent CLI processes", async () => {
    const root = await makeRoot();

    const codes = await Promise.all([runCli(root), runCli(root)]);

    expect(codes).toEqual([0, 0]);
    const telemetry = await readWriteTelemetry(root);
    expect(telemetry.days.at(-1)?.classes.runs?.operationCount).toBeGreaterThanOrEqual(2);
  });

  it("bounds retention, output size, and the exact privacy schema", async () => {
    const root = await makeRoot();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let day = 1; day <= 20; day += 1) {
      vi.setSystemTime(new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`));
      observeSuccessfulWrite({ root, storageClass: "cache" }, day, day * 2);
      await flushWriteTelemetry(root);
    }

    const raw = await readFile(writeTelemetryPath(root), "utf8");
    const document = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual(["days", "schemaVersion"]);
    expect((document.days as unknown[])).toHaveLength(14);
    for (const day of document.days as Array<Record<string, unknown>>) {
      expect(Object.keys(day).sort()).toEqual(["classes", "date", "sampledPeakRssBytes"]);
      expect(Object.keys(day.classes as object)).toEqual(["cache"]);
      expect(Object.keys((day.classes as { cache: object }).cache).sort()).toEqual([
        "logicalBytes", "operationCount", "physicalBytes"
      ]);
    }
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(256 * 1024);
    expect(raw).not.toMatch(/(?:prompt|command|secret|path|session|taskId)/i);
  });

  it("fails closed instead of saturating an aggregate counter", async () => {
    const root = await makeRoot();
    const path = writeTelemetryPath(root);
    await mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true });
    const persisted = {
      schemaVersion: 1,
      days: [{
        date: new Date().toISOString().slice(0, 10),
        sampledPeakRssBytes: 0,
        classes: { durable: { operationCount: Number.MAX_SAFE_INTEGER, logicalBytes: 1 } }
      }]
    };
    await writeFile(path, `${JSON.stringify(persisted)}\n`);
    observeSuccessfulWrite({ root, storageClass: "durable" }, 1);

    await expect(flushWriteTelemetry(root)).rejects.toThrow(/counter overflow/i);
    await expect(readFile(path, "utf8")).resolves.toBe(`${JSON.stringify(persisted)}\n`);
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, days: [] })}\n`);
    await expect(flushWriteTelemetry(root)).resolves.toBe(true);
  });

  it("rejects impossible telemetry calendar dates", async () => {
    const root = await makeRoot();
    const path = writeTelemetryPath(root);
    await mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      days: [{ date: "2026-02-31", sampledPeakRssBytes: 0, classes: {} }]
    })}\n`);

    await expect(readWriteTelemetry(root)).rejects.toThrow(/malformed/i);
  });

  it.each([true, false])("omits incomplete physical bytes regardless of order (known first: %s)", async (knownFirst) => {
    for (const separateFlushes of [false, true]) {
      const root = await makeRoot();
      observeSuccessfulWrite({ root, storageClass: "cache" }, 11, knownFirst ? 13 : undefined);
      if (separateFlushes) await flushWriteTelemetry(root);
      observeSuccessfulWrite({ root, storageClass: "cache" }, 17, knownFirst ? undefined : 19);
      await flushWriteTelemetry(root);
      expect((await readWriteTelemetry(root)).days.at(-1)?.classes.cache).toEqual({ operationCount: 2, logicalBytes: 28 });
    }
  });

  it("retains a complete physical aggregate when only another class receives a new write", async () => {
    const root = await makeRoot();
    observeSuccessfulWrite({ root, storageClass: "cache" }, 11, 13);
    await flushWriteTelemetry(root);
    observeSuccessfulWrite({ root, storageClass: "runs" }, 7);
    await flushWriteTelemetry(root);
    expect((await readWriteTelemetry(root)).days.at(-1)?.classes.cache?.physicalBytes).toBe(13);
  });

  it("keeps a successful atomic write successful and retains pending overflow", async () => {
    const root = await makeRoot();
    const target = join(root, ".tokengraph", "overflow-value.json");
    observeSuccessfulWrite({ root, storageClass: "durable" }, Number.MAX_SAFE_INTEGER);

    await expect(writeJsonAtomic(target, { committed: true }, { telemetry: { root, storageClass: "durable" } })).resolves.toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ committed: true });
    await expect(flushWriteTelemetry(root)).rejects.toThrow(/overflow.*retained/i);
    await expect(flushWriteTelemetry(root)).rejects.toThrow(/overflow.*retained/i);
  });

  it("excludes only the canonical telemetry artifact from quota accounting", async () => {
    const root = await makeRoot();
    const unrelated = join(root, ".tokengraph", "telemetry", "user.json");
    await mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true });
    await writeFile(unrelated, "user-owned\n");
    observeSuccessfulWrite({ root, storageClass: "durable" }, 7);
    await flushWriteTelemetry(root);

    const usage = await storageClassUsage(root);
    expect(usage.total).toMatchObject({ files: 1, bytes: Buffer.byteLength("user-owned\n") });
  });

  it("does not fail a successful CLI mutation when telemetry is malformed", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true });
    await writeFile(writeTelemetryPath(root), "{malformed");

    await expect(runCli(root)).resolves.toBe(0);
    await expect(readFile(configPath(root), "utf8")).resolves.toContain(`"schemaVersion": ${CURRENT_CONFIG_SCHEMA_VERSION}`);
  });

  it("keeps minimal recall buffers task-owned and persists unscoped recalls immediately", async () => {
    const root = await makeRoot();
    const filePath = join(root, ".tokengraph", "repository", "memory.json");
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const setup = new MemoryStore(filePath, lock, { writePolicy: "durable" });
    const first = await setup.add(input("First task memory"));
    const second = await setup.add(input("Second task memory"));
    const taskA = new MemoryStore(filePath, lock, { writePolicy: "minimal", bufferScope: "task-a" });
    const taskB = new MemoryStore(filePath, lock, { writePolicy: "minimal", bufferScope: "task-b" });

    await taskA.recordUse([first.id]);
    await taskB.recordUse([second.id]);
    await flushBufferedMemoryUses(filePath, lock, "task-a");
    let persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.memories.find((memory: { id: string }) => memory.id === first.id)?.lastUsedAt).toEqual(expect.any(String));
    expect(persisted.memories.find((memory: { id: string }) => memory.id === second.id)?.lastUsedAt).toBeUndefined();

    const unscoped = new MemoryStore(filePath, lock, { writePolicy: "minimal" });
    await unscoped.recall("second task memory");
    persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.memories.find((memory: { id: string }) => memory.id === second.id)?.lastUsedAt).toEqual(expect.any(String));
    const beforeRepeatedRecall = await readFile(filePath, "utf8");
    await unscoped.recall("second task memory");
    expect(await readFile(filePath, "utf8")).toBe(beforeRepeatedRecall);
  });

  it("settles an in-flight recall before reporting and discards failed task usage", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const filePath = join(root, ".tokengraph", "repository", "memory.json");
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const store = new MemoryStore(filePath, lock, { writePolicy: "minimal", bufferScope: ledger.taskId });
    const memory = await store.add(input("In-flight memory"));
    let release!: () => void;
    const held = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const recall = withTaskWriteLifecycle(root, ledger.taskId, async () => { await held; await store.recordUse([memory.id]); });
    const report = withTaskWriteLifecycle(root, ledger.taskId, () => flushTaskReportWrites(root, ledger.taskId));
    release();
    await recall;
    await expect(report).resolves.toEqual([]);
    expect((await store.list())[0]?.lastUsedAt).toEqual(expect.any(String));

    await store.recordUse([memory.id]);
    await discardTaskMemoryUses(root, ledger.taskId);
    await expect(flushBufferedMemoryUses(filePath, lock, ledger.taskId)).resolves.toBe(false);
  });

  it("settles minimal memory ids recorded by another MCP process", async () => {
    const root = await makeRoot();
    const filePath = join(root, ".tokengraph", "repository", "memory.json");
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const store = new MemoryStore(filePath, lock, { writePolicy: "durable" });
    const memory = await store.add(input("Cross-process settlement"));
    const ledger = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, ledger.taskId, {
      id: randomUUID(),
      fingerprint: randomUUID().replaceAll("-", ""),
      category: "memory-recall",
      toolName: "tokengraph_recall",
      originalTokens: 10,
      compactTokens: 5,
      overheadTokens: 1,
      confidence: "low",
      timestamp: new Date().toISOString(),
      qualityChecks: [{ name: "compact-output-produced", passed: true }],
      deferredMemoryUseDigests: [createHash("sha256").update(memory.id).digest("hex")]
    });

    // This process has no local buffer; settlement is reconstructed from the
    // strict task ledger written by the process that served the recall.
    await expect(flushTaskReportWrites(root, ledger.taskId)).resolves.toEqual([]);
    expect((await store.list())[0]?.lastUsedAt).toEqual(expect.any(String));
  });

  it("flushes memory before telemetry and preserves bounded task-report warnings", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const filePath = join(root, ".tokengraph", "repository", "memory.json");
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const store = new MemoryStore(filePath, lock, {
      writePolicy: "minimal",
      bufferScope: ledger.taskId,
      telemetry: { root, storageClass: "durable" }
    });
    await store.add(input("Task report flush"));
    await flushWriteTelemetry(root);
    const before = (await readWriteTelemetry(root)).days.at(-1)?.classes.durable?.operationCount ?? 0;
    await store.recall("task report flush");

    await expect(flushTaskReportWrites(root, ledger.taskId)).resolves.toEqual([]);
    const after = (await readWriteTelemetry(root)).days.at(-1)?.classes.durable?.operationCount ?? 0;
    expect(after).toBe(before + 1);

    const warningMemory = await store.add(input("Task report warning"));
    await store.recall("task report warning");
    await link(filePath, join(root, "memory-hardlink.json"));
    observeSuccessfulWrite({ root, storageClass: "cache" }, 9);
    await expect(flushTaskReportWrites(root, ledger.taskId)).resolves.toEqual(["memory-use-flush-failed"]);
    expect((await readWriteTelemetry(root)).days.at(-1)?.classes.cache?.logicalBytes).toBe(9);
    await rm(join(root, "memory-hardlink.json"));
    await expect(flushTaskReportWrites(root, ledger.taskId)).resolves.toEqual([]);
    expect((await store.list()).find((memory) => memory.id === warningMemory.id)?.lastUsedAt).toEqual(expect.any(String));
  });

  it("defines crash loss as pending telemetry only, never the successful durable write", async () => {
    const root = await makeRoot();
    const child = spawn(process.execPath, [
      externalCliEntry,
      "run", "--root", root, "--confirm-no-legacy-processes", "--",
      process.execPath, "--eval", "setTimeout(() => {}, 30000)"
    ], {
      env: externalRuntimeEnvironment(),
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      stdio: "ignore"
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await access(configPath(root));
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await access(configPath(root));
    if (process.platform === "win32") {
      await new Promise<void>((resolveExit) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", () => resolveExit());
      });
    } else {
      process.kill(-child.pid!, "SIGKILL");
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }

    await expect(readFile(configPath(root), "utf8")).resolves.toContain(`"schemaVersion": ${CURRENT_CONFIG_SCHEMA_VERSION}`);
    await expect(access(writeTelemetryPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
