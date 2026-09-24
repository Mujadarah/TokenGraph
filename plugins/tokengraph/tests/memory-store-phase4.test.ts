import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPersistenceLock } from "../src/core/lockDomain.js";
import { __getMemoryStoreWriteQueueSizeForTests, MemoryStore } from "../src/core/memoryStore.js";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-memory-phase4-"));
  temporaryRoots.push(root);
  return root;
}

async function memoryStore(root: string, name = "memory.json", filePath = join(root, ".tokengraph", "repository", name)): Promise<MemoryStore> {
  return new MemoryStore(filePath, await canonicalPersistenceLock(root, "repository-state", name));
}

function memoryInput(title: string) {
  return {
    type: "architecture" as const,
    title,
    body: `${title} body`,
    tags: ["phase4"]
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MemoryStore Phase 4 memory-write efficiency", () => {
  it("coalesces same-day recalls and updates usage on the next UTC day", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "repository", "memory.json");
    const store = await memoryStore(root, "memory.json", storePath);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T10:00:00.000Z"));
    try {
      const created = await store.add(memoryInput("Daily recall"));
      const first = await store.recall("daily recall");
      const firstRaw = await readFile(storePath, "utf8");
      const firstLastUsedAt = first.memories.find((memory) => memory.id === created.id)?.lastUsedAt;

      vi.setSystemTime(new Date("2026-08-07T18:30:00.000Z"));
      const sameDay = await store.recall("daily recall");
      const sameDayRaw = await readFile(storePath, "utf8");

      expect(sameDayRaw).toBe(firstRaw);
      expect(sameDay.memories.find((memory) => memory.id === created.id)?.lastUsedAt).toBe(firstLastUsedAt);

      vi.setSystemTime(new Date("2026-08-08T00:01:00.000Z"));
      const nextDay = await store.recall("daily recall");
      const nextDayLastUsedAt = nextDay.memories.find((memory) => memory.id === created.id)?.lastUsedAt;

      expect(nextDayLastUsedAt).toBe("2026-08-08T00:01:00.000Z");
      expect(nextDayLastUsedAt).not.toBe(firstLastUsedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps legacy lastUsedAt values readable while coalescing by their UTC day", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "repository", "memory.json");
    const store = await memoryStore(root, "memory.json", storePath);

    await mkdir(join(root, ".tokengraph", "repository"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: 1,
        memories: [{
          id: "mem_legacy_last-used",
          type: "architecture",
          title: "Legacy usage",
          body: "Legacy usage body",
          tags: ["phase4"],
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
          lastUsedAt: "2026-08-06T23:30:00-02:00"
        }]
      })
    );
    const legacyRaw = await readFile(storePath, "utf8");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T01:30:00.000Z"));
    try {
      const recalled = await store.recall("legacy usage");
      expect(recalled.memories[0]?.lastUsedAt).toBe("2026-08-06T23:30:00-02:00");
      expect(await readFile(storePath, "utf8")).toBe(legacyRaw);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent same-day recalls and cleans queues for many memory paths", async () => {
    const root = await makeRoot();
    const store = await memoryStore(root);
    const created = await store.add(memoryInput("Concurrent recall"));

    const recalls = await Promise.all(
      Array.from({ length: 12 }, () => store.recall("concurrent recall"))
    );

    expect(recalls.every((recall) => recall.memories[0]?.id === created.id)).toBe(true);
    expect(new Set(recalls.map((recall) => recall.memories[0]?.lastUsedAt)).size).toBe(1);

    await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        // Each repository-state root has its own native domain anchor. Keeping
        // these paths independent exercises queue cleanup without turning the
        // test into an unrelated native-lock contention timeout.
        const distinctRoot = await makeRoot();
        const distinctStore = await memoryStore(distinctRoot, `memory-${index}.json`);
        await distinctStore.add(memoryInput(`Distinct memory ${index}`));
      })
    );

    expect(__getMemoryStoreWriteQueueSizeForTests()).toBe(0);
  });

  it("cleans the write queue after both successful and rejected operations", async () => {
    const root = await makeRoot();
    const successfulStore = await memoryStore(root);

    await successfulStore.add(memoryInput("Successful operation"));
    expect(__getMemoryStoreWriteQueueSizeForTests()).toBe(0);

    const blockedParent = join(root, "blocked-parent");
    await writeFile(blockedParent, "not a directory");
    const rejectedStore = await memoryStore(root, "rejected.json", join(blockedParent, "memory.json"));

    await expect(rejectedStore.add(memoryInput("Rejected operation"))).rejects.toThrow();
    expect(__getMemoryStoreWriteQueueSizeForTests()).toBe(0);
  });
});
