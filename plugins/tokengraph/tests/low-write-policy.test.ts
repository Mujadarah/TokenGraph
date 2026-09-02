import { link, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURRENT_CONFIG_SCHEMA_VERSION, DEFAULT_TOKEN_GRAPH_CONFIG, loadTokenGraphConfig } from "../src/core/config.js";
import { canonicalPersistenceLock } from "../src/core/lockDomain.js";
import { flushBufferedMemoryUses, MemoryStore } from "../src/core/memoryStore.js";
import { configPath } from "../src/core/persistence.js";
import {
  flushWriteTelemetry,
  observeSuccessfulWrite,
  readWriteTelemetry,
  writeJsonAtomic,
  writeTelemetryPath
} from "../src/core/storage.js";
import { storageClassUsage } from "../src/core/storagePolicy.js";

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
    const store = new MemoryStore(filePath, lock, { writePolicy: "minimal", telemetry: { root, storageClass: "durable" } });
    const created = await store.add(input("Minimal recall"));
    const before = await readFile(filePath, "utf8");

    await store.recall("minimal recall");
    expect(await readFile(filePath, "utf8")).toBe(before);

    await expect(flushBufferedMemoryUses(filePath, lock, { telemetry: { root, storageClass: "durable" } })).resolves.toBe(true);
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
});
