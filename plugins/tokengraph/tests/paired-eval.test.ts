import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { counterbalancedConditions, evaluateManifest, evaluatePaired, loadEvaluationManifest, pairedBootstrap, parseEvaluationManifest } from "../src/core/pairedEval.js";
import type { HostTrace } from "../src/core/pairedEval.js";
import { isValidatedPromotion } from "../src/core/routingControl.js";

function completeManifestMetadata() {
  return {
    model: { identifier: "gpt-5", versionOrDate: "2026-07-15" },
    reasoningLevel: "high",
    host: { name: "codex", version: "1.0.0" },
    plugin: { version: "0.21.0", commit: "a".repeat(40) },
    repositoryCommit: "b".repeat(40),
    promptTemplate: "paired-eval-v1",
    toolConfiguration: { surface: "core" },
    cacheState: "empty",
    indexState: "cold" as const,
    protocol: {
      runsPerTask: 1,
      minimumPerCategorySamples: 10,
      qualityNonInferiorityMargin: 0.02,
      tokenSuperiorityMinimum: 1,
      resourceLimit: 2,
      routerRateMaximum: 0.1,
      executionMedianMinimum: 0,
      executionP25Minimum: 0,
      nonNegativeActivatedMinimum: 0.8
    }
  };
}

function passingTasksAndTraces(count = 10) {
  const tasks = Array.from({ length: count }, (_, index) => ({ taskId: `task-${index}`, category: "code" }));
  const traces = tasks.flatMap((task) => [
    {
      taskId: task.taskId, category: task.category, condition: "on" as const, tokens: 80, executionInclusiveTokens: 80,
      quality: 1, timedOut: false, failed: false, resourceUnits: 1,
      routing: { mode: "shadow" as const, decision: "activate" as const, stage: 0 as const, reason: "context-discovery", expectedOverheadTokens: 80, falseBypass: false, falseActivation: false }
    },
    { taskId: task.taskId, category: task.category, condition: "off" as const, tokens: 100, executionInclusiveTokens: 100, quality: 1, timedOut: false, failed: false, resourceUnits: 1 }
  ]);
  return { tasks, traces };
}

describe("paired evaluation", () => {
  it("counterbalances deterministically and bootstraps paired differences", () => {
    const tasks = [{ taskId: "a", category: "code" }, { taskId: "b", category: "sql" }, { taskId: "c", category: "code" }];
    expect(counterbalancedConditions(tasks, "seed")).toEqual(counterbalancedConditions(tasks, "seed"));
    expect(pairedBootstrap([1, 2, 3], 100, 5)).toMatchObject({ estimate: 2, samples: 3 });
  });

  it("keeps enforcement disabled unless all resource and quality gates pass", () => {
    const { tasks, traces } = passingTasksAndTraces();
    const report = evaluatePaired(tasks, traces, { tokenSuperiority: 1, resourceLimit: 2 });
    expect(report.enforcementEnabled).toBe(true);
    expect(report.gates).toMatchObject({ minimumSamples: true, qualityNonInferiority: true, tokenSuperiority: true, resources: true, routerRates: true, executionMedian: true, executionP25: true, nonNegativeActivated: true });
    expect(evaluatePaired(tasks, traces.map((trace) => trace.condition === "on" ? { ...trace, resourceUnits: 3 } : trace), { minimumCategorySamples: 3, tokenSuperiority: 1, resourceLimit: 2 }).enforcementEnabled).toBe(false);
  });

  it("requires ten explicit real shadow observations per category before promotion", () => {
    const { tasks, traces } = passingTasksAndTraces();
    const missingObservation = traces.map((trace, index) => index === 0 ? { ...trace, routing: undefined } : trace);
    expect(evaluatePaired(tasks, missingObservation).gates.routerRates).toBe(false);
    expect(evaluatePaired(tasks, missingObservation).enforcementEnabled).toBe(false);

    const implicitOutcomes = traces.map((trace) => trace.routing ? {
      ...trace,
      routing: { ...trace.routing, falseBypass: undefined, falseActivation: undefined }
    } : trace);
    expect(evaluatePaired(tasks, implicitOutcomes as unknown as HostTrace[]).gates.routerRates).toBe(false);

    const onlyNine = passingTasksAndTraces(9);
    expect(evaluatePaired(onlyNine.tasks, onlyNine.traces, { minimumCategorySamples: 1 }).gates.routerRates).toBe(false);
  });

  it("rejects incomplete run manifests and preserves all reproducibility fields", () => {
    const { tasks, traces } = passingTasksAndTraces();
    expect(() => parseEvaluationManifest({ schemaVersion: 1, generatedAt: new Date().toISOString(), seed: "seed", tasks, traces })).toThrow(/manifest schema/i);
    const manifest = parseEvaluationManifest({
      schemaVersion: 1,
      generatedAt: "2026-07-15T00:00:00.000Z",
      seed: "seed",
      ...completeManifestMetadata(),
      tasks,
      traces
    });
    expect(manifest).toMatchObject(completeManifestMetadata());
  });

  it("rejects forged promotion evidence even when every named gate is true", () => {
    const gates = {
      minimumSamples: true, qualityNonInferiority: true, tokenSuperiority: true, resources: true,
      routerRates: true, executionMedian: true, executionP25: true, nonNegativeActivated: true
    };
    expect(isValidatedPromotion({ schemaVersion: 1, generatedAt: new Date().toISOString(), enforcementEnabled: true, gates, categoryCounts: {} })).toBe(false);
    expect(isValidatedPromotion({
      schemaVersion: 1, generatedAt: new Date().toISOString(), enforcementEnabled: true, gates,
      categoryCounts: { code: 10 }, falseBypassRate: 0, falseActivationRate: 0,
      executionInclusiveMedian: 1, executionInclusiveP25: 0, nonNegativeActivatedRate: 0.8
    })).toBe(true);
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
    expect(evaluateManifest(manifest).gates.minimumSamples).toBe(false);
  });
});
