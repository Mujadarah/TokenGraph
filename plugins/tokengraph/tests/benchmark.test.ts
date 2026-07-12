import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BENCHMARK_CATEGORIES,
  buildCalibration,
  evaluateBenchmark,
  evaluateReleaseGate,
  median,
  stableBenchmarkJson,
  validateCorpus
} from "../scripts/benchmark-lib.js";

const corpusPath = resolve("scripts", "benchmark-corpus-v1.json");

async function corpus() {
  return JSON.parse(await readFile(corpusPath, "utf8"));
}

describe("evidence benchmark", () => {
  it("validates a versioned corpus with 30 distinct tasks and four per category", async () => {
    const loaded = await corpus();
    const result = validateCorpus(loaded);

    expect(result.errors).toEqual([]);
    expect(result.tasks).toHaveLength(30);
    expect(new Set(result.tasks.map((task) => task.query)).size).toBe(30);
    for (const category of BENCHMARK_CATEGORIES) {
      expect(result.tasks.filter((task) => task.category === category).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("evaluates distinct scenarios through real core routing functions", async () => {
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "next-supabase"));

    expect(report.tasks).toHaveLength(30);
    expect(new Set(report.tasks.map((task) => JSON.stringify(task.metrics))).size).toBeGreaterThan(10);
    expect(report.tasks[0]?.metrics).toMatchObject({
      requiredFileRecall: expect.any(Number),
      falsePositives: expect.any(Array),
      falseNegatives: expect.any(Array),
      criticalConstraintPreservation: expect.any(Number),
      recommendedTests: expect.any(Array),
      rawTokens: expect.any(Number),
      compactTokens: expect.any(Number),
      toolOverheadTokens: expect.any(Number),
      netEstimatedSavings: expect.any(Number),
      qualityResult: expect.stringMatching(/^(passed|failed)$/),
      failureReasons: expect.any(Array)
    });
  });

  it("fails and passes release gates for the documented deterministic conditions", () => {
    const passing = {
      taskCount: 30,
      categoryCounts: Object.fromEntries(BENCHMARK_CATEGORIES.map((category) => [category, 4])),
      criticalConstraintPreservationRate: 1,
      criticalFalseNegativeCount: 0,
      requiredFileRecall: 1,
      medianNetSavings: 1,
      baselineRequiredFileRecall: 0.9
    };

    expect(evaluateReleaseGate(passing)).toEqual({ passed: true, failureReasons: [] });
    expect(evaluateReleaseGate({ ...passing, medianNetSavings: 0, criticalFalseNegativeCount: 1 })).toEqual({
      passed: false,
      failureReasons: expect.arrayContaining([
        expect.stringMatching(/median net savings/i),
        expect.stringMatching(/critical false negatives/i)
      ])
    });
  });

  it("calculates medians deterministically for odd and even samples", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([10, 2, 8, 4])).toBe(6);
    expect(median([])).toBe(0);
  });

  it("emits versioned per-category residual calibration without overstating confidence", () => {
    const calibration = buildCalibration([
      ...Array.from({ length: 10 }, (_, index) => ({ category: "compression", residual: index - 5 })),
      ...Array.from({ length: 4 }, (_, index) => ({ category: "debugging", residual: index }))
    ]);

    expect(calibration).toMatchObject({
      schemaVersion: 1,
      estimatorVersion: "task-estimator-v1",
      categories: {
        compression: {
          observations: 10,
          lowResidual: expect.any(Number),
          highResidual: expect.any(Number),
          confidence: "calibrated"
        },
        debugging: { observations: 4, confidence: "low" }
      }
    });
  });

  it("serializes stable JSON when only the generated timestamp changes", async () => {
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "next-supabase"));
    const first = stableBenchmarkJson({ ...report, generatedAt: "2026-01-01T00:00:00.000Z" });
    const second = stableBenchmarkJson({ ...report, generatedAt: "2026-02-01T00:00:00.000Z" });

    expect(first.replace("2026-01-01T00:00:00.000Z", "TIMESTAMP")).toBe(
      second.replace("2026-02-01T00:00:00.000Z", "TIMESTAMP")
    );
  });
});
