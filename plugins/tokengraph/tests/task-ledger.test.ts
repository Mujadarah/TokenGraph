import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTaskReport, formatTaskReportFooter } from "../src/core/taskEstimator.js";
import {
  __getTaskLedgerWriteQueueSizeForTests,
  attachTaskHostContext,
  createTaskLedger,
  discardEmptyTaskLedger,
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

function ledgerPath(root: string, taskId: string): string {
  return join(root, ".tokengraph", "tasks", `${taskId}.json`);
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

  it("serializes only host association identifiers and derived ledger metadata", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const unsafeContext = {
      host: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      transcript: "private transcript",
      message: "private message",
      toolPayload: { secret: true }
    } as Parameters<typeof attachTaskHostContext>[2];

    await attachTaskHostContext(root, ledger.taskId, unsafeContext);
    const serialized = await readFile(ledgerPath(root, ledger.taskId), "utf8");
    const stored = JSON.parse(serialized) as Record<string, unknown>;

    expect(stored).toMatchObject({ host: "codex", sessionId: "session-1", turnId: "turn-1" });
    expect(serialized).not.toContain("private transcript");
    expect(serialized).not.toContain("private message");
    expect(serialized).not.toContain("toolPayload");
  });

  it("reconstructs persisted ledgers from strict allowlists and strips raw fields on the next write", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const storedEvent = event();
    const unsafe = {
      ...ledger,
      prompt: "top-level prompt",
      absolutePath: "C:\\private\\task.json",
      events: [
        {
          ...storedEvent,
          rawToolInput: { secret: true },
          rawToolOutput: "private output",
          qualityChecks: [{ name: "tests", passed: true, rawSource: "private source" }]
        }
      ]
    };
    await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(unsafe));

    const reconstructed = await loadTaskLedger(root, ledger.taskId);
    expect(reconstructed).toBeDefined();
    expect(reconstructed).not.toHaveProperty("prompt");
    expect(reconstructed?.events[0]).not.toHaveProperty("rawToolInput");
    expect(reconstructed?.events[0]?.qualityChecks[0]).toEqual({ name: "tests", passed: true });

    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "second" }));
    const rewritten = await readFile(ledgerPath(root, ledger.taskId), "utf8");
    expect(rewritten).not.toContain("top-level prompt");
    expect(rewritten).not.toContain("rawToolInput");
    expect(rewritten).not.toContain("rawToolOutput");
    expect(rewritten).not.toContain("rawSource");
    expect(rewritten).not.toContain("C:\\\\private");
  });

  it("quarantines deeply malformed events, timestamps, quality checks, and completion reports", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        (value.events as Array<Record<string, unknown>>)[0]!.originalTokens = "100";
      },
      (value) => {
        (value.events as Array<Record<string, unknown>>)[0]!.timestamp = "not-a-timestamp";
      },
      (value) => {
        (value.events as Array<Record<string, unknown>>)[0]!.qualityChecks = [{ name: "tests", passed: "yes" }];
      },
      (value) => {
        const report = value.completedReport as Record<string, unknown>;
        (report.estimate as Record<string, unknown>).range = { low: 90, likely: 50, high: 60, unit: "estimated_tokens" };
      }
    ];

    for (const mutate of mutations) {
      const root = await makeRoot();
      const ledger = await createTaskLedger(root, { host: "codex" });
      await recordTaskEvent(root, ledger.taskId, event());
      const completed = await setTaskDisposition(root, ledger.taskId, "complete");
      const persisted = structuredClone(completed.ledger) as unknown as Record<string, unknown>;
      mutate(persisted);
      await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(persisted));

      expect(await loadTaskLedger(root, ledger.taskId)).toBeUndefined();
      const files = await readdir(join(root, ".tokengraph", "tasks"));
      expect(files.some((name) => name.startsWith(`${ledger.taskId}.json.quarantine-`))).toBe(true);
    }
  });

  it("quarantines invalid host identifiers and impossible lifecycle timestamps", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.host = "vscode"; },
      (value) => { value.sessionId = ""; },
      (value) => { value.turnId = 42; },
      (value) => { value.updatedAt = "2020-01-01T00:00:00.000Z"; },
      (value) => { value.pausedAt = value.createdAt; }
    ];

    for (const mutate of mutations) {
      const root = await makeRoot();
      const ledger = await createTaskLedger(root, { host: "codex", sessionId: "session-1", turnId: "turn-1" });
      const persisted = structuredClone(ledger) as unknown as Record<string, unknown>;
      mutate(persisted);
      await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(persisted));

      expect(await loadTaskLedger(root, ledger.taskId)).toBeUndefined();
    }
  });

  it("quarantines lifecycle timestamps that occur after the last ledger update", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const completed = await setTaskDisposition(root, ledger.taskId, "complete");
    const persisted = structuredClone(completed.ledger) as unknown as Record<string, unknown>;
    persisted.completedAt = "2099-01-01T00:00:00.000Z";
    await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(persisted));

    expect(await loadTaskLedger(root, ledger.taskId)).toBeUndefined();
  });

  it("strictly reconstructs a valid canonical report without retaining extra raw fields", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, ledger.taskId, event());
    const completed = await setTaskDisposition(root, ledger.taskId, "complete");
    const unsafe = {
      ...completed.ledger,
      completedReport: {
        ...completed.report,
        rawPrompt: "private",
        estimate: { ...completed.report!.estimate, rawToolOutput: "private" },
        quality: { ...completed.report!.quality, absolutePath: "C:\\private\\report" }
      }
    };
    await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(unsafe));

    const reconstructed = await loadTaskLedger(root, ledger.taskId);
    expect(reconstructed?.completedReport).toEqual(completed.report);
    expect(reconstructed?.completedReport).not.toHaveProperty("rawPrompt");
    expect(reconstructed?.completedReport?.estimate).not.toHaveProperty("rawToolOutput");
    expect(reconstructed?.completedReport?.quality).not.toHaveProperty("absolutePath");
  });

  it("quarantines ledgers whose lifecycle fields contradict their status", async () => {
    const mutations: Array<(value: Record<string, unknown>, report: unknown) => void> = [
      (value) => {
        value.lastDisposition = "complete";
      },
      (value, report) => {
        value.completedAt = "2026-07-12T12:00:00.000Z";
        value.completedReport = report;
      },
      (value) => {
        value.status = "paused";
        value.pausedAt = "2026-07-12T12:00:00.000Z";
      },
      (value, report) => {
        value.status = "paused";
        value.pausedAt = "2026-07-12T12:00:00.000Z";
        value.lastDisposition = "pause";
        value.completedAt = "2026-07-12T12:00:00.000Z";
        value.completedReport = report;
      },
      (value, report) => {
        value.status = "completed";
        value.completedAt = "2026-07-12T12:00:00.000Z";
        value.completedReport = report;
        value.lastDisposition = "pause";
      }
    ];

    for (const mutate of mutations) {
      const root = await makeRoot();
      const ledger = await createTaskLedger(root, { host: "codex" });
      const report = buildTaskReport(ledger);
      const inconsistent = structuredClone(ledger) as unknown as Record<string, unknown>;
      mutate(inconsistent, report);
      await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(inconsistent));

      expect(await loadTaskLedger(root, ledger.taskId)).toBeUndefined();
      const files = await readdir(join(root, ".tokengraph", "tasks"));
      expect(files.some((name) => name.startsWith(`${ledger.taskId}.json.quarantine-`))).toBe(true);
    }

    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const completed = await setTaskDisposition(root, ledger.taskId, "complete");
    const missingDisposition = structuredClone(completed.ledger) as unknown as Record<string, unknown>;
    delete missingDisposition.lastDisposition;
    await writeFile(ledgerPath(root, ledger.taskId), JSON.stringify(missingDisposition));
    expect(await loadTaskLedger(root, ledger.taskId)).toBeUndefined();
  });

  it("deduplicates by fingerprint and preserves a negative net estimate", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "same", originalTokens: 100 }));
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "same", originalTokens: 150 }));
    await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "same", originalTokens: 80 }));

    const stored = await loadTaskLedger(root, ledger.taskId);
    expect(stored?.events).toHaveLength(1);
    expect(stored?.events[0]?.originalTokens).toBe(150);
  });

  it("keeps execution overhead in a negative task total instead of clamping it to zero", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const stored = await recordTaskEvent(root, ledger.taskId, event({ originalTokens: 10, compactTokens: 40, overheadTokens: 5 }));
    expect(buildTaskReport(stored).estimate.range.likely).toBe(-35);
  });

  it("treats a paused task id as terminal for events, host attachment, and dispositions", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    await setTaskDisposition(root, ledger.taskId, "pause");
    const terminal = /paused task.*terminal.*new task.*tokengraph_prepare_context/i;

    await expect(recordTaskEvent(root, ledger.taskId, event())).rejects.toThrow(terminal);
    await expect(attachTaskHostContext(root, ledger.taskId, {
      host: "codex", sessionId: "new-session", turnId: "new-turn"
    })).rejects.toThrow(terminal);
    await expect(setTaskDisposition(root, ledger.taskId, "pause")).rejects.toThrow(terminal);
    await expect(setTaskDisposition(root, ledger.taskId, "complete")).rejects.toThrow(terminal);
  });
});

describe("task savings estimator", () => {
  it("formats exact honest footer strings for unmeasured, singular, range, and quality states", async () => {
    const root = await makeRoot();
    const empty = await createTaskLedger(root, { host: "codex" });
    expect(formatTaskReportFooter(buildTaskReport(empty))).toBe(
      "TokenGraph: savings not measured (no qualifying task events)."
    );

    const ledger = await createTaskLedger(root, { host: "codex" });
    const singular = await recordTaskEvent(root, ledger.taskId, event({ compactTokens: 50, overheadTokens: 0, qualityChecks: [{ name: "tests", passed: true }] }));
    expect(formatTaskReportFooter(buildTaskReport(singular, { context: { observations: 10, lowResidual: 0, highResidual: -10 } }))).toBe(
      "TokenGraph: ~50 tokens saved (estimated, medium confidence); quality passed."
    );

    const warning = await recordTaskEvent(root, ledger.taskId, event({ fingerprint: "warning", qualityChecks: [{ name: "tests", passed: false }] }));
    expect(formatTaskReportFooter(buildTaskReport(warning))).toBe(
      "TokenGraph: ~0-110 tokens saved (estimated, low confidence); quality warning."
    );

    const noChecks = await createTaskLedger(root, { host: "codex" });
    const measured = await recordTaskEvent(root, noChecks.taskId, event());
    expect(formatTaskReportFooter(buildTaskReport(measured))).toBe(
      "TokenGraph: ~0-60 tokens saved (estimated, low confidence); quality not evaluated."
    );
  });

  it("charges fixed report overhead once after aggregation and clamps an ordered range", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const stored = await recordTaskEvent(
      root,
      ledger.taskId,
      event({ originalTokens: 100, compactTokens: 40, overheadTokens: 10 })
    );

    expect(buildTaskReport(stored, {}, 20).estimate).toMatchObject({
      range: { low: 0, likely: 30, high: 40 },
      overhead: 30
    });
    expect(buildTaskReport(stored, {}, 80).estimate).toMatchObject({
      range: { low: -30, likely: -30, high: -20 },
      overhead: 90
    });
  });

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
        range: { low: -15, likely: 35, high: 60, unit: "estimated_tokens" },
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

  it("changes from uncalibrated to calibrated exactly at the 10-observation boundary", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const stored = await recordTaskEvent(
      root,
      ledger.taskId,
      event({ originalTokens: 100, compactTokens: 40, overheadTokens: 10, confidence: "high" })
    );

    const nine = buildTaskReport(stored, { context: { observations: 9, lowResidual: -20, highResidual: 30 } });
    const ten = buildTaskReport(stored, { context: { observations: 10, lowResidual: -20, highResidual: 30 } });

    expect(nine.estimate).toMatchObject({
      range: { low: 0, likely: 50, high: 60 },
      confidence: "low",
      basis: ["context:uncalibrated"]
    });
    expect(ten.estimate).toMatchObject({
      range: { low: 30, likely: 50, high: 80 },
      confidence: "high",
      basis: ["context:calibrated:10"]
    });
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
  it("attaches and updates serialized host context while rejecting known conflicts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    vi.setSystemTime(new Date("2026-07-12T12:01:00.000Z"));

    const attached = await attachTaskHostContext(root, ledger.taskId, {
      host: "codex", sessionId: "session-1", turnId: "turn-1"
    });
    expect(attached).toMatchObject({ host: "codex", sessionId: "session-1", turnId: "turn-1", updatedAt: "2026-07-12T12:01:00.000Z" });

    const updated = await attachTaskHostContext(root, ledger.taskId, {
      host: "codex", sessionId: "session-1", turnId: "turn-2"
    });
    expect(updated.turnId).toBe("turn-2");
    await expect(attachTaskHostContext(root, ledger.taskId, {
      host: "claude", sessionId: "session-1", turnId: "turn-3"
    })).rejects.toThrow(/host.*conflict/i);
    await expect(attachTaskHostContext(root, ledger.taskId, {
      host: "codex", sessionId: "session-2", turnId: "turn-3"
    })).rejects.toThrow(/session.*conflict/i);
  });

  it("rejects an unsupported runtime host without mutating or quarantining the ledger", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const invalidContext = {
      host: "vscode",
      sessionId: "session-1",
      turnId: "turn-1"
    } as unknown as Parameters<typeof attachTaskHostContext>[2];

    await expect(attachTaskHostContext(root, ledger.taskId, invalidContext)).rejects.toThrow(/host.*codex.*claude/i);
    expect(await loadTaskLedger(root, ledger.taskId)).toEqual(ledger);
    expect(await readdir(join(root, ".tokengraph", "tasks"))).toEqual([`${ledger.taskId}.json`]);
  });

  it("serializes concurrent host-context updates without losing association invariants", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const settled = await Promise.allSettled([
      attachTaskHostContext(root, ledger.taskId, { host: "codex", sessionId: "session-1", turnId: "turn-1" }),
      attachTaskHostContext(root, ledger.taskId, { host: "codex", sessionId: "session-1", turnId: "turn-2" })
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await loadTaskLedger(root, ledger.taskId)).toMatchObject({
      host: "codex",
      sessionId: "session-1",
      turnId: expect.stringMatching(/^turn-[12]$/)
    });
    expect(__getTaskLedgerWriteQueueSizeForTests()).toBe(0);
  });

  it("pauses without a report and completes with a charged canonical report", async () => {
    const root = await makeRoot();
    const pausedLedger = await createTaskLedger(root, { host: "codex" });
    const paused = await setTaskDisposition(root, pausedLedger.taskId, "pause");
    expect(paused).toEqual({ ledger: expect.objectContaining({ status: "paused" }) });

    const completedLedger = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, completedLedger.taskId, event());
    const first = await setTaskDisposition(root, completedLedger.taskId, "complete", undefined, undefined, 12);
    const second = await setTaskDisposition(root, completedLedger.taskId, "complete", "ignored", undefined, 999);
    expect(first.report?.estimate).toMatchObject({ range: { low: 0, likely: 38, high: 48 }, overhead: 22 });
    expect(second).toEqual(first);
  });

  it("rejects pausing a completed ledger without changing its canonical completion", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const completed = await setTaskDisposition(root, ledger.taskId, "complete");

    await expect(setTaskDisposition(root, ledger.taskId, "pause")).rejects.toThrow(/completed.*cannot.*pause/i);
    expect(await loadTaskLedger(root, ledger.taskId)).toEqual(completed.ledger);
    await expect(setTaskDisposition(root, ledger.taskId, "complete")).resolves.toEqual(completed);
  });

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

  it("serializes concurrent event updates without losing unique events", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const events = Array.from({ length: 25 }, (_, index) =>
      event({ id: crypto.randomUUID(), fingerprint: `concurrent-${index}`, originalTokens: 100 + index })
    );

    await Promise.all(events.map((item) => recordTaskEvent(root, ledger.taskId, item)));

    const stored = await loadTaskLedger(root, ledger.taskId);
    expect(stored?.events).toHaveLength(events.length);
    expect(new Set(stored?.events.map((item) => item.fingerprint))).toEqual(new Set(events.map((item) => item.fingerprint)));
  });

  it("atomically persists every concurrently auto-started task as a distinct open ledger", async () => {
    const root = await makeRoot();

    const created = await Promise.all(Array.from({ length: 25 }, () =>
      createTaskLedger(root, { host: "unknown" })
    ));

    expect(new Set(created.map((ledger) => ledger.taskId)).size).toBe(created.length);
    await expect(Promise.all(created.map((ledger) => loadTaskLedger(root, ledger.taskId)))).resolves.toEqual(created);
    expect(created.every((ledger) => ledger.status === "open")).toBe(true);
  });

  it("discards only a pristine auto-started ledger under the shared ledger lock", async () => {
    const root = await makeRoot();
    const pristine = await createTaskLedger(root, { host: "codex" });
    await expect(discardEmptyTaskLedger(root, pristine.taskId)).resolves.toBe(true);
    expect(await loadTaskLedger(root, pristine.taskId)).toBeUndefined();

    const active = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, active.taskId, event());
    await expect(discardEmptyTaskLedger(root, active.taskId)).resolves.toBe(false);
    expect(await loadTaskLedger(root, active.taskId)).toBeDefined();
  });

  it("keeps a newer queued chain registered when an older operation settles, then cleans up after success", async () => {
    const root = await makeRoot();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const initial = Array.from({ length: 40 }, (_, index) =>
      recordTaskEvent(root, ledger.taskId, event({ fingerprint: `queued-${index}` }))
    );

    await initial[0];
    const late = recordTaskEvent(root, ledger.taskId, event({ fingerprint: "late" }));
    await Promise.all([...initial.slice(1), late]);

    expect((await loadTaskLedger(root, ledger.taskId))?.events).toHaveLength(41);
    expect(__getTaskLedgerWriteQueueSizeForTests()).toBe(0);
  });

  it.runIf(process.platform === "win32")("serializes concurrent event updates across Windows case-alias roots", async () => {
    const root = await makeRoot();
    const aliasRoot = root.toUpperCase();
    const ledger = await createTaskLedger(root, { host: "codex" });
    const settled = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        recordTaskEvent(
          index % 2 === 0 ? root : aliasRoot,
          ledger.taskId,
          event({ id: crypto.randomUUID(), fingerprint: `alias-${index}` })
        )
      )
    );

    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    expect((await loadTaskLedger(root, ledger.taskId))?.events).toHaveLength(32);
    expect(__getTaskLedgerWriteQueueSizeForTests()).toBe(0);
  });

  it("cleans up a rejected ledger operation without blocking the next operation", async () => {
    const root = await makeRoot();
    const completed = await createTaskLedger(root, { host: "codex" });
    await setTaskDisposition(root, completed.taskId, "complete");

    await expect(recordTaskEvent(root, completed.taskId, event())).rejects.toThrow(/completed/i);
    expect(__getTaskLedgerWriteQueueSizeForTests()).toBe(0);

    const open = await createTaskLedger(root, { host: "codex" });
    await expect(recordTaskEvent(root, open.taskId, event())).resolves.toBeDefined();
  });

  it("prunes terminal and unreachable empty ledgers older than 30 days while preserving active open ledgers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const root = await makeRoot();
    const open = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, open.taskId, event());
    const abandoned = await createTaskLedger(root, { host: "codex" });
    const paused = await createTaskLedger(root, { host: "codex" });
    const completed = await createTaskLedger(root, { host: "codex" });
    await setTaskDisposition(root, paused.taskId, "pause");
    await setTaskDisposition(root, completed.taskId, "complete");

    const result = await pruneTaskLedgers(root, new Date("2026-06-01T00:00:00.001Z"));

    expect(result.pruned.sort()).toEqual([abandoned.taskId, completed.taskId, paused.taskId].sort());
    expect(await loadTaskLedger(root, open.taskId)).toBeDefined();
    expect(await loadTaskLedger(root, abandoned.taskId)).toBeUndefined();
    expect(await loadTaskLedger(root, paused.taskId)).toBeUndefined();
    expect(await loadTaskLedger(root, completed.taskId)).toBeUndefined();
  });

  it("quarantines a corrupt ledger during pruning and continues pruning another eligible ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const root = await makeRoot();
    const eligible = await createTaskLedger(root, { host: "codex" });
    await setTaskDisposition(root, eligible.taskId, "pause");
    const corruptId = crypto.randomUUID();
    const corruptPath = join(root, ".tokengraph", "tasks", `${corruptId}.json`);
    await writeFile(corruptPath, "{ not json");

    const result = await pruneTaskLedgers(root, new Date("2026-06-01T00:00:00.001Z"));

    expect(result.quarantined).toContain(corruptId);
    expect(result.pruned).toContain(eligible.taskId);
    expect(await loadTaskLedger(root, eligible.taskId)).toBeUndefined();
    const files = await readdir(join(root, ".tokengraph", "tasks"));
    expect(files.some((name) => name.startsWith(`${corruptId}.json.quarantine-`))).toBe(true);
  });
});
