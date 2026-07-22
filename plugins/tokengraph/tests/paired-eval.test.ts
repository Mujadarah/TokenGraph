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
      stage0LatencyMaximumMs: 5,
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

function realHostManifest() {
  const tasks = Array.from({ length: 20 }, (_, index) => ({ taskId: `real-${index}`, category: "code" }));
  const traces = tasks.flatMap((task, index) => {
    const expectedRouting = index < 10 ? "activate" as const : "bypass" as const;
    const decision = expectedRouting;
    const routing = {
      mode: "shadow" as const,
      decision,
      stage: 0 as const,
      reason: decision === "activate" ? "context-discovery" : "bounded-task",
      expectedOverheadTokens: decision === "activate" ? 80 : 0,
      expectedBenefit: decision === "activate" ? "medium" as const : "none" as const,
      expectedRouting,
      routingLatencyMs: 0.2,
      ...(decision === "activate" ? { activationLatencyMs: 5 } : {}),
      falseBypass: false,
      falseActivation: false
    };
    const shared = {
      taskId: task.taskId,
      category: task.category,
      repeat: 1,
      conditionOrder: index % 2 === 0 ? "on-first" as const : "off-first" as const,
      usageSource: "host" as const,
      acceptance: { status: "passed" as const, commandHash: "c".repeat(64) },
      quality: 1,
      timedOut: false,
      failed: false,
      resourceUnits: 1
    };
    return [
      { ...shared, condition: "on" as const, tokens: 80, executionInclusiveTokens: 80, inputTokens: 70, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2, toolCalls: 1, fallbackRawReads: 0, routing },
      { ...shared, condition: "off" as const, tokens: 100, executionInclusiveTokens: 100, inputTokens: 90, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2, toolCalls: 1, fallbackRawReads: 1 }
    ];
  });
  return {
    schemaVersion: 3,
    evidenceSource: "real-host",
    reviewed: true,
    generatedAt: "2026-07-19T00:00:00.000Z",
    seed: "real-seed",
    ...completeManifestMetadata(),
    promptTemplateHash: "d".repeat(64),
    tasks,
    traces
  };
}

describe("paired evaluation", () => {
  it("counterbalances deterministically and bootstraps paired differences", () => {
    const tasks = [{ taskId: "a", category: "code" }, { taskId: "b", category: "sql" }, { taskId: "c", category: "code" }];
    expect(counterbalancedConditions(tasks, "seed")).toEqual(counterbalancedConditions(tasks, "seed"));
    expect(pairedBootstrap([1, 2, 3], 100, 5)).toMatchObject({ estimate: 2, samples: 3 });
  });

  it("keeps direct fixture evaluation ineligible even when resource and quality gates pass", () => {
    const { tasks, traces } = passingTasksAndTraces();
    const report = evaluatePaired(tasks, traces, { tokenSuperiority: 1, resourceLimit: 2 });
    expect(report.enforcementEnabled).toBe(false);
    expect(report).toMatchObject({ evidenceSource: "fixture", promotionEligible: false });
    expect(report.gates).toMatchObject({ realHostEvidence: false });
    expect(evaluatePaired(tasks, traces.map((trace) => trace.condition === "on" ? { ...trace, resourceUnits: 3 } : trace), { minimumCategorySamples: 3, tokenSuperiority: 1, resourceLimit: 2 }).enforcementEnabled).toBe(false);
  });

  it("accepts only reviewed schema-v3 real-host evidence and applies both latency gates", () => {
    const manifest = parseEvaluationManifest(realHostManifest());
    expect(manifest).toMatchObject({ schemaVersion: 3, evidenceSource: "real-host", reviewed: true });
    const report = evaluateManifest(manifest);
    expect(report).toMatchObject({
      evidenceSource: "real-host",
      promotionEligible: true,
      enforcementEnabled: true,
      routerRates: {
        beneficialCount: 10,
        boundedCount: 10,
        falseBypassRate: 0,
        falseActivationRate: 0,
        stage0LatencyMs: 0.2,
        activationLatencyMs: 5,
        stage0LatencySamples: 20,
        activationLatencySamples: 10,
        stage0FasterThanActivation: true,
        stage0LatencyMaximumMs: 5,
        stage0WithinBudget: true
      },
      gates: { realHostEvidence: true, routerLatency: true, routerRates: true }
    });

    const historicalV2 = parseEvaluationManifest({ ...realHostManifest(), schemaVersion: 2 });
    expect(historicalV2).toMatchObject({ schemaVersion: 2, evidenceSource: "real-host", reviewed: true });
    expect(evaluateManifest(historicalV2)).toMatchObject({ promotionEligible: false, enforcementEnabled: false });
  });

  it("fails the latency gate above the five millisecond ceiling even when Stage-0 is faster", () => {
    const manifest = realHostManifest();
    for (const trace of manifest.traces) {
      if (trace.condition === "on" && "routing" in trace && trace.routing) {
        trace.routing.routingLatencyMs = 5.01;
        if (trace.routing.decision === "activate") trace.routing.activationLatencyMs = 6;
      }
    }
    const report = evaluateManifest(parseEvaluationManifest(manifest));
    expect(report.routerRates).toMatchObject({
      stage0LatencyMs: 5.01,
      activationLatencyMs: 6,
      stage0FasterThanActivation: true,
      stage0LatencyMaximumMs: 5,
      stage0WithinBudget: false
    });
    expect(report.gates.routerLatency).toBe(false);
    expect(report.enforcementEnabled).toBe(false);
  });

  it("keeps schema-v1 and schema-v2 fixture evidence non-promoting", () => {
    const legacy = parseEvaluationManifest({
      schemaVersion: 1,
      generatedAt: "2026-07-15T00:00:00.000Z",
      seed: "seed",
      ...completeManifestMetadata(),
      ...passingTasksAndTraces()
    });
    expect(legacy).toMatchObject({ schemaVersion: 1, evidenceSource: "fixture", reviewed: false });
    expect(evaluateManifest(legacy)).toMatchObject({ promotionEligible: false, enforcementEnabled: false });

    const fixture = { ...realHostManifest(), evidenceSource: "fixture" };
    expect(evaluateManifest(parseEvaluationManifest(fixture))).toMatchObject({ promotionEligible: false, enforcementEnabled: false });
  });

  it("rejects non-monotonic real-host activation latency", () => {
    const manifest = realHostManifest();
    const firstOn = manifest.traces.find((trace) => trace.condition === "on" && "routing" in trace && trace.routing?.decision === "activate");
    if (!firstOn || !("routing" in firstOn) || !firstOn.routing) throw new Error("Expected an activated trace.");
    firstOn.routing.activationLatencyMs = 0.1;
    expect(() => parseEvaluationManifest(manifest)).toThrow(/latency/i);
  });

  it("fails router gates when reviewed truth lacks either denominator", () => {
    const manifest = realHostManifest();
    for (const trace of manifest.traces) {
      if (trace.condition === "on" && "routing" in trace && trace.routing) {
        trace.routing.expectedRouting = "activate";
        trace.routing.decision = "activate";
        trace.routing.expectedBenefit = "medium";
        trace.routing.activationLatencyMs = 5;
      }
    }
    const report = evaluateManifest(parseEvaluationManifest(manifest));
    expect(report.routerRates).toMatchObject({ beneficialCount: 20, boundedCount: 0, falseActivationRate: null });
    expect(report.gates.routerRates).toBe(false);
    expect(report.enforcementEnabled).toBe(false);
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
      minimumSamples: true, realHostEvidence: true, qualityNonInferiority: true, tokenSuperiority: true, resources: true,
      routerRates: true, routerLatency: true, executionMedian: true, executionP25: true, nonNegativeActivated: true
    };
    expect(isValidatedPromotion({ schemaVersion: 1, generatedAt: new Date().toISOString(), enforcementEnabled: true, gates, categoryCounts: {} })).toBe(false);
    expect(isValidatedPromotion({
      schemaVersion: 1, generatedAt: new Date().toISOString(), enforcementEnabled: true, gates,
      categoryCounts: { code: 10 }, falseBypassRate: 0, falseActivationRate: 0,
      executionInclusiveMedian: 1, executionInclusiveP25: 0, nonNegativeActivatedRate: 0.8
    })).toBe(false);
    expect(isValidatedPromotion({
      schemaVersion: 2, generatedAt: new Date().toISOString(), enforcementEnabled: true, gates,
      evidenceSource: "real-host", reviewed: true, categoryCounts: { code: 20 },
      beneficialCount: 10, boundedCount: 10, falseBypassRate: 0, falseActivationRate: 0,
      stage0LatencyMs: 0.2, activationLatencyMs: 5, stage0FasterThanActivation: true,
      stage0LatencySamples: 20, activationLatencySamples: 10,
      executionInclusiveMedian: 1, executionInclusiveP25: 0, nonNegativeActivatedRate: 0.8
    })).toBe(false);
    expect(isValidatedPromotion({
      schemaVersion: 3, generatedAt: new Date().toISOString(), enforcementEnabled: true, gates,
      evidenceSource: "real-host", reviewed: true, categoryCounts: { code: 20 },
      beneficialCount: 10, boundedCount: 10, falseBypassRate: 0, falseActivationRate: 0,
      stage0LatencyMs: 0.2, activationLatencyMs: 5, stage0FasterThanActivation: true,
      stage0LatencyMaximumMs: 5, stage0WithinBudget: true,
      stage0LatencySamples: 20, activationLatencySamples: 10,
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

    const v2 = await loadEvaluationManifest(resolve("tests", "fixtures", "paired-eval-v2.json"));
    expect(v2).toMatchObject({ schemaVersion: 2, evidenceSource: "real-host", reviewed: true });
    expect(evaluateManifest(v2)).toMatchObject({ promotionEligible: false, enforcementEnabled: false });
  });

  it("keeps checked-in schema-v2 real-host evidence parseable but historical and non-promoting", async () => {
    const evidenceRoot = resolve("..", "..", "docs", "benchmarks", "host-evaluations");
    const manifest = await loadEvaluationManifest(resolve(evidenceRoot, "2026-07-19-tokengraph-codex-manifest.json"));
    const checkedReport = JSON.parse(await readFile(resolve(evidenceRoot, "2026-07-19-tokengraph-codex-report.json"), "utf8"));

    expect(manifest).toMatchObject({ schemaVersion: 2, evidenceSource: "real-host", reviewed: true });
    expect(evaluateManifest(manifest)).toMatchObject({ schemaVersion: 2, promotionEligible: false, enforcementEnabled: false });
    expect(checkedReport).toMatchObject({ promotionEligible: true, enforcementEnabled: false });
  });
});
