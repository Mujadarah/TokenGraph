import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LOCK_DOMAINS, canonicalPersistenceLock, type LockDomain } from "../src/core/lockDomain.js";
import { canonicalMaintenanceLocks, withFileLock } from "../src/core/storage.js";
import { saveTokenGraphConfig, DEFAULT_TOKEN_GRAPH_CONFIG } from "../src/core/config.js";
import { createTaskLedger, setTaskDisposition, pruneTaskLedgers, recordTaskEvent } from "../src/core/taskLedger.js";
import { MemoryStore } from "../src/core/memoryStore.js";
import { saveRun, purgeRuns, type SavedRun } from "../src/core/runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-domain-regression-"));
  roots.push(root);
  return root;
}

// The native anchor persists at the acquired domain root after release, so its
// presence pins which branded domain a public operation acquired.
async function acquiredDomains(root: string): Promise<Set<LockDomain>> {
  const acquired = new Set<LockDomain>();
  for (const domain of LOCK_DOMAINS) {
    if (domain === "git-info") continue;
    const lock = await canonicalPersistenceLock(root, domain, "probe.json").catch(() => undefined);
    if (!lock) continue;
    const present = await access(lock.anchorPath).then(() => true, () => false);
    if (present) acquired.add(domain);
  }
  return acquired;
}

function savedRun(root: string, runId: string): SavedRun {
  return {
    runId, root, command: "echo", args: ["hi"], startedAt: "2026-07-12T12:00:00.000Z",
    finishedAt: "2026-07-12T12:00:01.000Z", status: "completed", exitCode: 0, signal: null, timedOut: false,
    stdout: "hi", stderr: "", stdoutTruncated: false, stderrTruncated: false
  };
}

describe("task 7: caller-to-branded-domain mapping", () => {
  it("config write acquires only the workspace-state domain", async () => {
    const root = await makeRoot();
    await saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
    expect(await acquiredDomains(root)).toEqual(new Set<LockDomain>(["workspace-state"]));
  });

  it("task ledger create and disposition acquire the tasks domain (plus repository-state for identity)", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    // createTaskLedger reads the repository identity, which persists the
    // repository id under the repository-state domain the first time.
    expect(await acquiredDomains(root)).toEqual(new Set<LockDomain>(["tasks", "repository-state"]));
    await recordTaskEvent(root, ledger.taskId, {
      id: "e1", fingerprint: "f1", category: "context", toolName: "t", originalTokens: 100,
      compactTokens: 40, overheadTokens: 10, confidence: "medium", timestamp: "2026-07-12T12:00:00.000Z", qualityChecks: []
    });
    await setTaskDisposition(root, ledger.taskId, "complete");
    // The ledger writes stay in the tasks domain; no new domain is acquired.
    expect(await acquiredDomains(root)).toEqual(new Set<LockDomain>(["tasks", "repository-state"]));
  });

  it("task ledger prune acquires the tasks domain", async () => {
    const root = await makeRoot();
    // Pre-create the repository id so the pass isolates prune's own acquisition.
    await createTaskLedger(root, { host: "codex" });
    const before = await acquiredDomains(root);
    await pruneTaskLedgers(root);
    const after = await acquiredDomains(root);
    // Prune adds no domain beyond what was already present, and tasks is held.
    expect(after).toEqual(before);
    expect(after.has("tasks")).toBe(true);
  });

  it("run save and purge acquire only the runs domain", async () => {
    const root = await makeRoot();
    await saveRun(root, savedRun(root, "11111111-1111-4111-8111-111111111111"));
    await purgeRuns(root, new Date("2099-01-01T00:00:00.000Z"));
    expect(await acquiredDomains(root)).toEqual(new Set<LockDomain>(["runs"]));
  });

  it("memory store write acquires only the repository-state domain", async () => {
    const root = await makeRoot();
    // The production server constructs the vault-facing MemoryStore with the
    // repository-state domain lock, not the vault domain.
    const lock = await canonicalPersistenceLock(root, "repository-state", "memory.json");
    const store = new MemoryStore(join(root, ".tokengraph", "repository", "memory.json"), lock);
    await mkdir(join(root, ".tokengraph", "repository"), { recursive: true });
    await store.add({ type: "convention", title: "t", body: "b", tags: [] });
    expect(await acquiredDomains(root)).toEqual(new Set<LockDomain>(["repository-state"]));
  });
});

describe("task 7: retention deletion serializes under the canonical domain lock", () => {
  it("purgeRuns blocks while a concurrent writer holds the runs domain anchor", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph", "runs"), { recursive: true });
    await saveRun(root, savedRun(root, "22222222-2222-4222-8222-222222222222"));
    const lock = await canonicalPersistenceLock(root, "runs", "run.json");
    let releaseWriter!: () => void;
    const held = new Promise<void>((resolveHeld) => { releaseWriter = resolveHeld; });
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { writerEntered = resolveEntered; });
    const writer = withFileLock(lock, async () => { writerEntered(); await held; });
    await entered;

    let purgeFinished = false;
    const purge = purgeRuns(root, new Date("2099-01-01T00:00:00.000Z")).then((removed) => { purgeFinished = true; return removed; });
    await new Promise((wait) => setTimeout(wait, 25));
    expect(purgeFinished).toBe(false);
    releaseWriter();
    await writer;
    await expect(purge).resolves.toContain("22222222-2222-4222-8222-222222222222");
  });

  it("pruneTaskLedgers blocks while a concurrent writer holds the tasks domain anchor", async () => {
    const root = await makeRoot();
    await createTaskLedger(root, { host: "codex" });
    const lock = await canonicalPersistenceLock(root, "tasks", "concurrent.json");
    let releaseWriter!: () => void;
    const held = new Promise<void>((resolveHeld) => { releaseWriter = resolveHeld; });
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { writerEntered = resolveEntered; });
    const writer = withFileLock(lock, async () => { writerEntered(); await held; });
    await entered;

    let pruneFinished = false;
    const prune = pruneTaskLedgers(root).then((result) => { pruneFinished = true; return result; });
    await new Promise((wait) => setTimeout(wait, 25));
    expect(pruneFinished).toBe(false);
    releaseWriter();
    await writer;
    await expect(prune).resolves.toMatchObject({ pruned: expect.any(Array) });
  });
});

describe("task 7: multi-domain maintenance acquisition order", () => {
  it("observes sorted anchor acquisition and reverse release for canonical maintenance", async () => {
    const root = await makeRoot();
    const locks = await canonicalMaintenanceLocks(root, ["wiki", "workspace-state", "runs", "tasks"]);
    const anchors = locks.map((lock) => lock.anchorPath);
    // canonicalMaintenanceLocks returns locks pre-sorted by anchor path.
    expect(anchors).toEqual([...anchors].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const events: string[] = [];
    const acquire = async (index: number): Promise<void> => {
      if (index === locks.length) return;
      await withFileLock(locks[index]!, async () => {
        events.push(`acquire:${index}`);
        await acquire(index + 1);
        events.push(`release:${index}`);
      });
    };
    await acquire(0);
    // Sorted acquisition then reverse release.
    expect(events).toEqual([
      "acquire:0", "acquire:1", "acquire:2", "acquire:3",
      "release:3", "release:2", "release:1", "release:0"
    ]);
  });
});

describe("task 7: storage accounting with a live compatibility barrier", () => {
  it("does not bill a live barrier to the user and still succeeds", async () => {
    const { storageUsage } = await import("../src/core/storagePolicy.js");
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(join(root, ".tokengraph", "state.json"), "user-bytes");
    // A live journal-authorized compatibility barrier sits at a domain root
    // during an operation as a `.lock` directory holding the lease payload.
    const barrier = join(root, ".tokengraph", "config.json.lock");
    await mkdir(barrier, { recursive: true });
    await writeFile(join(barrier, "lease.json"), "lease-payload");

    const usage = await storageUsage(root);
    expect(usage.files).toBe(1);
    expect(usage.bytes).toBe(10);
  });
});
