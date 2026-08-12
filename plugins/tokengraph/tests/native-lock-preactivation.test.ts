import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalPersistenceLock } from "../src/core/lockDomain.js";
import { runWithFileLock } from "../src/core/fileLockLease.js";
import { withFileLock } from "../src/core/storage.js";
import { enforceStorageClassQuotas } from "../src/core/storagePolicy.js";
import { loadTokenGraphConfig } from "../src/core/config.js";
import { listAppliedKnowledge } from "../src/core/knowledgeReviewQueue.js";
import { MemoryStore } from "../src/core/memoryStore.js";
import { loadTaskLedger, listCompletedTaskOutcomes } from "../src/core/taskLedger.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else snapshot.set(relative(root, absolute), await readFile(absolute, "utf8"));
    }
  }
  await walk(root);
  return snapshot;
}

function expectSameTree(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);
}

describe("native lock preactivation boundary", () => {
  it("refuses a branded production lock before addon loading or domain mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-"));
    roots.push(root);
    const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");

    await expect(runWithFileLock(lock, async () => undefined)).rejects.toMatchObject({
      code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED"
    });
    await expect(access(join(root, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes the public storage boundary through the same branded preactivation refusal", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-storage-"));
    roots.push(root);
    const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");

    await expect(withFileLock(lock, async () => undefined)).rejects.toMatchObject({
      code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED"
    });
    await expect(access(join(root, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses automatic quota cleanup before process activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-quota-"));
    roots.push(root);
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const index = join(root, ".tokengraph", "index.json");
    await writeFile(index, "cache");

    await expect(enforceStorageClassQuotas(root, {
      maxBytes: 1024,
      runsMaxBytes: 1024,
      cacheMaxBytes: 1,
      vaultMaxBytes: 1024,
      durableMaxBytes: 1024
    })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" });
    await expect(access(index)).resolves.toBeUndefined();
    await expect(access(join(root, ".tokengraph", ".tokengraph-native-anchor-v2.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not migrate, back up, or quarantine config on a pure read before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-config-"));
    roots.push(root);
    const stateDirectory = join(root, ".tokengraph");
    await mkdir(stateDirectory, { recursive: true });
    // A legacy, schema-drifting config that a read would normally re-persist and back up.
    await writeFile(join(stateDirectory, "config.json"), `${JSON.stringify({ tokenSavingProfile: "aggressive" })}\n`);
    const before = await snapshotTree(stateDirectory);

    const config = await loadTokenGraphConfig(root);
    expect(config.tokenSavingProfile).toBe("aggressive");

    expectSameTree(before, await snapshotTree(stateDirectory));
    await expect(access(join(stateDirectory, "config.json.bak"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not quarantine a corrupt config on a pure read before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-config-corrupt-"));
    roots.push(root);
    const stateDirectory = join(root, ".tokengraph");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "config.json"), "{not json\n");
    const before = await snapshotTree(stateDirectory);

    const config = await loadTokenGraphConfig(root);
    expect(config.tokenSavingProfile).toBe("balanced");

    expectSameTree(before, await snapshotTree(stateDirectory));
  });

  it("does not quarantine a corrupt review queue on a pure read before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-queue-"));
    roots.push(root);
    const stateDirectory = join(root, ".tokengraph");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "review-queue.json"), "{broken\n");
    await writeFile(join(stateDirectory, "knowledge-applications.json"), "{broken\n");
    const before = await snapshotTree(stateDirectory);

    await expect(listAppliedKnowledge(root)).resolves.toEqual([]);

    expectSameTree(before, await snapshotTree(stateDirectory));
  });

  it("does not quarantine a corrupt memory store on a pure read before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-memory-"));
    roots.push(root);
    const stateDirectory = join(root, ".tokengraph");
    await mkdir(stateDirectory, { recursive: true });
    const memoryPath = join(stateDirectory, "memory.json");
    await writeFile(memoryPath, "{broken\n");
    const lock = await canonicalPersistenceLock(root, "vault", "memory.json");
    const store = new MemoryStore(memoryPath, lock);
    const before = await snapshotTree(stateDirectory);

    await expect(store.list()).resolves.toEqual([]);

    expectSameTree(before, await snapshotTree(stateDirectory));
  });

  it("does not quarantine or migrate a task ledger on a pure read before activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-ledger-"));
    roots.push(root);
    const tasksDirectory = join(root, ".tokengraph", "tasks");
    await mkdir(tasksDirectory, { recursive: true });
    const taskId = "00000000-0000-4000-8000-000000000001";
    // A legacy schema-v1 ledger that a read would normally rewrite in place.
    await writeFile(join(tasksDirectory, `${taskId}.json`), `${JSON.stringify({
      schemaId: "tokengraph-task-ledger",
      schemaVersion: 1,
      taskId,
      host: "codex",
      status: "open",
      createdAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
      estimatorVersion: "task-estimator-v1",
      events: []
    })}\n`);
    const corruptId = "00000000-0000-4000-8000-000000000002";
    await writeFile(join(tasksDirectory, `${corruptId}.json`), "{broken\n");
    const outcomesPath = join(tasksDirectory, "completed-outcomes.json");
    await writeFile(outcomesPath, "{broken\n");
    const before = await snapshotTree(tasksDirectory);

    await loadTaskLedger(root, taskId).catch(() => undefined);
    await loadTaskLedger(root, corruptId).catch(() => undefined);
    await listCompletedTaskOutcomes(root).catch(() => undefined);

    expectSameTree(before, await snapshotTree(tasksDirectory));
  });
});
