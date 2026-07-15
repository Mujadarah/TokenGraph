import { describe, expect, it } from "vitest";
import { counterbalancedConditions, evaluatePaired, pairedBootstrap } from "../src/core/pairedEval.js";

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
    expect(report.gates).toEqual({ minimumSamples: true, qualityNonInferiority: true, tokenSuperiority: true, resources: true });
    expect(evaluatePaired(tasks, traces.map((trace) => trace.condition === "on" ? { ...trace, resourceUnits: 3 } : trace), { minimumCategorySamples: 3, tokenSuperiority: 1, resourceLimit: 2 }).enforcementEnabled).toBe(false);
  });
});
