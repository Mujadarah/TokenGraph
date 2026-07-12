import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTaskReport } from "../src/core/taskEstimator.js";
import {
  createTaskLedger,
  loadTaskLedger,
  pruneTaskLedgers,
  recordTaskEvent,
  setTaskDisposition
} from "../src/core/taskLedger.js";
import type { TaskEvent } from "../src/core/taskLedger.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-task-ledger-"));
  roots.push(root);
  return root;
}

function event(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: crypto.randomUUID(),
    fingerprint: crypto.randomUUID(),
    category: "context",
    toolName: "tokengraph_context",
    originalTokens: 100,
    compactTokens: 40,
    overheadTokens: 10,
    confidence: "medium",
    timestamp: "2026-07-12T12:00:00.000Z",
    qualityChecks: [],
    ...overrides
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task ledger persistence", () => {
  it("creates a UUID-named, schema-versioned task ledger", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex", sessionId: "session-1", turnId: "turn-1" });

    expect(ledger).toMatchObject({
      schemaId: "tokengraph-task-ledger",
      schemaVersion: 1,
      host: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "open",
      estimatorVersion: "task-estimator-v1",
      events: []
    });
    expect(ledger.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(JSON.parse(await readFile(join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`), "utf8"))).toEqual(ledger);
  });

  it("rejects non-UUID task ids before path construction", async () => {
    const root = await makeRoot();
    await expect(loadTaskLedger(root, "../../outside")).rejects.toThrow(/uuid/i);
    await expect(recordTaskEvent(root, "not-a-uuid", event())).rejects.toThrow(/uuid/i);
    await expect(setTaskDisposition(root, "../escape", "pause")).rejects.toThrow(/uuid/i);
    expect(await readdir(root)).toEqual([]);
  });

  it("serializes only privacy-minimal derived event metadata", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "claude" });
    const unsafeEvent = {
      ...event(),
      prompt: "secret prompt",
      rawSource: "private source",
      rawToolInput: { token: "secret" },
      rawToolOutput: "secret output",
      secret: "password",
      absolutePath: "C:\\Users\\private\\secret.ts"
    } as TaskEvent;

    await recordTaskEvent(root, ledger.taskId, unsafeEvent);
    const serialized = await readFile(join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`), "utf8");
    const stored = JSON.parse(serialized) as { events: Array<Record<string, unknown>> };

    expect(Object.keys(stored.events[0] ?? {}).sort()).toEqual([
      "category",
      "compactTokens",
      "confidence",
      "fingerprint",
      "id",
      "originalTokens",
      "overheadTokens",
      "qualityChecks",
      "timestamp",
      "toolName"
    ]);
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("C:\\\\Users");
  });

  it("deduplicates by fingerprint and retains the largest non-negative net estimate", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "same", originalTokens: 100 }));
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "same", originalTokens: 150 }));
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "same", originalTokens: 80 }));

    const stored = await loadTaskLedger(root, ledger.taskId);
    expect(stored?.events).toHaveLength(1);
    expect(stored?.events[0]?.originalTokens).toBe(150);
  });
});

describe("task savings estimator", () => {
  it("builds conservative uncalibrated ranges from unique events", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "one", originalTokens: 100, compactTokens: 40, overheadTokens: 10 }));
    const stored = await recordTaskEvent(
      root,
      ledger.taskId,
      event({ fingerprint: "two", category: "sql", originalTokens: 50, compactTokens: 60, overheadTokens: 5 })
    );

    expect(buildTaskReport(stored)).toMatchObject({
      eventCount: 2,
      estimate: {
        range: { low: 0, likely: 50, high: 60, unit: "estimated_tokens" },
        confidence: "low",
        overhead: 15,
        estimatorVersion: "task-estimator-v1"
      },
      quality: { status: "not_evaluated", checks: [] }
    });
  });

  it("applies category residual calibration deterministically and clamps the aggregate range", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const stored = await recordTaskEvent(
      root,
      ledger.taskId,
      event({ originalTokens: 100, compactTokens: 40, overheadTokens: 10, confidence: "high" })
    );

    expect(
      buildTaskReport(stored, {
        context: { observations: 10, lowResidual: -20, highResidual: 30 }
      })
    ).toMatchObject({
      estimate: { range: { low: 30, likely: 50, high: 80 }, confidence: "high" }
    });

    expect(
      buildTaskReport(stored, {
        context: { observations: 10, lowResidual: 100, highResidual: -100 }
      })
    ).toMatchObject({ estimate: { range: { low: 50, likely: 50, high: 60 } } });
  });

  it("aggregates quality checks as warning, passed, or not_evaluated", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const passed = await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "pass", qualityChecks: [{ name: "tests", passed: true }] }));
    expect(buildTaskReport(passed).quality.status).toBe("passed");
    const warned = await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "fail", qualityChecks: [{ name: "typecheck", passed: false }] }));
    expect(buildTaskReport(warned).quality.status).toBe("warning");
  });
});

describe("task lifecycle and retention", () => {
  it("stores an idempotent canonical completion report and rejects later events", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, ledger.taskId, event({ qualityChecks: [{ name: "tests", passed: true }] }));

    const first = await setTaskDisposition(root, ledger.taskId, "complete", "turn-2");
    const second = await setTaskDisposition(root, ledger.taskId, "complete", "turn-3", {
      context: { observations: 100, lowResidual: 20, highResidual: 40 }
    });

    expect(first.report).toBeDefined();
    expect(second.report).toEqual(first.report);
    expect(second.ledger).toEqual(first.ledger);
    await expect(recordTaskEvent(root, ledger.taskId, event())).rejects.toThrow(/completed/i);
  });

  it("prunes only paused and completed ledgers older than 30 days while preserving open ledgers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const root = await makeRoot();
    const open = await createTaskLedger(root, { host: "codex" });
    const paused = await createTaskLedger(root, { host: "codex" });
    const completed = await createTaskLedger(root, { host: "codex" });
    await setTaskDisposition(root, paused.taskId, "pause");
    await setTaskDisposition(root, completed.taskId, "complete");

    const result = await pruneTaskLedgers(root, new Date("2026-06-01T00:00:00.001Z"));

    expect(result.pruned.sort()).toEqual([completed.taskId, paused.taskId].sort());
    expect(await loadTaskLedger(root, open.taskId)).toBeDefined();
    expect(await loadTaskLedger(root, paused.taskId)).toBeUndefined();
    expect(await loadTaskLedger(root, completed.taskId)).toBeUndefined();
  });

  it("quarantines corrupt ledgers without preventing other ledgers from loading or pruning", async () => {
    const root = await makeRoot();
    const valid = await createTaskLedger(root, { host: "codex" });
    const corruptId = crypto.randomUUID();
    const corruptPath = join(root, ".tokengraph", "tasks", `${corruptId}.json`);
    await writeFile(corruptPath, "{ not json");

    expect(await loadTaskLedger(root, corruptId)).toBeUndefined();
    expect(await loadTaskLedger(root, valid.taskId)).toBeDefined();
    const files = await readdir(join(root, ".tokengraph", "tasks"));
    expect(files.some((name) => name.startsWith(`${corruptId}.json.quarantine-`))).toBe(true);
    await expect(pruneTaskLedgers(root)).resolves.toBeDefined();
  });
});
