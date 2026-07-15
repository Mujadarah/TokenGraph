import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { counterbalancedConditions, evaluatePaired, loadEvaluationManifest, pairedBootstrap } from "../src/core/pairedEval.js";

describe("paired evaluation", () => {
  it("counterbalances deterministically and bootstraps paired differences", () => {
    const tasks = [{ taskId: "a", category: "code" }, { taskId: "b", category: "sql" }, { taskId: "c", category: "code" }];
    expect(counterbalancedConditions(tasks, "seed")).toEqual(counterbalancedConditions(tasks, "seed"));
    expect(pairedBootstrap([1, 2, 3], 100, 5)).toMatchObject({ estimate: 2, samples: 3 });
  });

  it("keeps enforcement disabled unless all resource and quality gates pass", () => {
    const tasks = ["a", "b", "c"].map((taskId) => ({ taskId, category: "code" }));
    const traces = tasks.flatMap((task) => [
      { taskId: task.taskId, category: task.category, condition: "on" as const, tokens: 80, quality: 1, timedOut: false, failed: false, resourceUnits: 1 },
      { taskId: task.taskId, category: task.category, condition: "off" as const, tokens: 100, quality: 1, timedOut: false, failed: false, resourceUnits: 1 }
    ]);
    const report = evaluatePaired(tasks, traces, { minimumCategorySamples: 3, tokenSuperiority: 1, resourceLimit: 2 });
    expect(report.enforcementEnabled).toBe(true);
    expect(report.gates).toMatchObject({ minimumSamples: true, qualityNonInferiority: true, tokenSuperiority: true, resources: true, routerRates: true, executionMedian: true, executionP25: true, nonNegativeActivated: true });
    expect(evaluatePaired(tasks, traces.map((trace) => trace.condition === "on" ? { ...trace, resourceUnits: 3 } : trace), { minimumCategorySamples: 3, tokenSuperiority: 1, resourceLimit: 2 }).enforcementEnabled).toBe(false);
  });

  it("consumes the checked-in host-trace manifest and retains timed-out pairs", async () => {
    const path = resolve("tests", "fixtures", "paired-eval-v1.json");
    const manifest = await loadEvaluationManifest(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1, tasks: expect.any(Array), traces: expect.any(Array) });
    const report = evaluatePaired(manifest.tasks, manifest.traces, { minimumCategorySamples: 3 });
    expect(report.failures).toContain("fixture-code-3:failure-or-timeout");
    expect(report.enforcementEnabled).toBe(false);
    expect(report.executionInclusiveSavings.samples).toBe(3);
    expect(report.categoryIntervals.code.executionInclusiveSavings.samples).toBe(3);
  });
});
