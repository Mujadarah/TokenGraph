import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BENCHMARK_CATEGORIES,
  buildCalibration,
  evaluateBenchmark,
  evaluateReleaseGate,
  median,
  measureSerializedOutput,
  stableBenchmarkJson,
  validateCorpus
} from "../scripts/benchmark-lib.js";
import * as benchmarkLibrary from "../scripts/benchmark-lib.js";
import { buildTaskReport, TASK_ESTIMATOR_VERSION } from "../src/core/taskEstimator.js";
import type { TaskLedger } from "../src/core/taskLedger.js";
import { estimateTokens } from "../src/core/token.js";

const corpusPath = resolve("scripts", "benchmark-corpus-v1.json");
const evidencePath = resolve("scripts", "benchmark-evidence-v1.json");

async function corpus() {
  return JSON.parse(await readFile(corpusPath, "utf8"));
}

async function evidence() {
  return JSON.parse(await readFile(evidencePath, "utf8"));
}

describe("evidence benchmark", () => {
  it("documents the JSON-only result contract and resource-link exception for generic MCP clients", async () => {
    const guide = await readFile(resolve("..", "..", "docs", "hosts", "generic-mcp.md"), "utf8");
    expect(guide).toMatch(/core tools[\s\S]*one JSON `TextContent` item containing serialized JSON/i);
    expect(guide).not.toMatch(/return structured JSON in `structuredContent`/i);
    expect(guide).toMatch(/export_project_map[\s\S]*resource-link exception[\s\S]*structuredContent/i);
  });

  it("validates a versioned corpus with 30 distinct tasks and four per category", async () => {
    const loaded = await corpus();
    const result = validateCorpus(loaded);

    expect(result.errors).toEqual([]);
    expect(result.tasks).toHaveLength(30);
    expect(new Set(result.tasks.map((task) => task.query)).size).toBe(30);
    for (const task of result.tasks) {
      expect(task.constraints).toEqual(task.criticalConstraints);
      for (const path of task.requiredFiles) {
        await expect(access(resolve("tests", "fixtures", "evidence-project", path))).resolves.toBeUndefined();
      }
    }
    for (const category of BENCHMARK_CATEGORIES) {
      expect(result.tasks.filter((task) => task.category === category).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("evaluates distinct scenarios through real core routing functions", async () => {
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "evidence-project"));

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

  it("keeps core evidence and accounting independent from mutated gold labels", async () => {
    const loaded = await corpus();
    const baseline = await evaluateBenchmark(loaded, resolve("tests", "fixtures", "evidence-project"));
    const mutated = structuredClone(loaded);
    mutated.tasks[0].requiredFiles = ["absent/gold-label.ts"];
    mutated.tasks[0].criticalConstraints = ["Poison gold constraint that is not fixture input."];
    mutated.tasks[0].expectedTests = ["absent/gold-label.test.ts"];
    mutated.tasks[0].forbiddenFalsePositiveFiles = ["absent/forbidden.ts"];
    mutated.tasks[0].targetedRawReadsAllowed = !mutated.tasks[0].targetedRawReadsAllowed;
    const changed = await evaluateBenchmark(mutated, resolve("tests", "fixtures", "evidence-project"));

    expect(changed.tasks[0]).toMatchObject({
      flow: baseline.tasks[0]?.flow,
      coreOutput: baseline.tasks[0]?.coreOutput,
      accounting: baseline.tasks[0]?.accounting
    });
    expect(changed.tasks[0]?.metrics.recommendedTests).toEqual(baseline.tasks[0]?.metrics.recommendedTests);
  });

  it("takes constraints from public task input and fails preservation when one is removed", async () => {
    const loaded = await corpus();
    const baseline = await evaluateBenchmark(loaded, resolve("tests", "fixtures", "evidence-project"));
    expect(baseline.tasks[0]?.metrics.criticalConstraintPreservation).toBe(1);
    expect(JSON.stringify(baseline.tasks[0]?.coreOutput)).toContain(loaded.tasks[0].constraints[0]);

    const removed = structuredClone(loaded);
    removed.tasks[0].constraints = [];
    const changed = await evaluateBenchmark(removed, resolve("tests", "fixtures", "evidence-project"));
    expect(changed.tasks[0]?.metrics.criticalConstraintPreservation).toBe(0);
  });

  it("takes raw-read policy from public input and fails preservation when permissive guidance violates the independent expectation", async () => {
    const loaded = await corpus();
    const taskIndex = loaded.tasks.findIndex((task: { targetedRawReadsAllowed: boolean }) => !task.targetedRawReadsAllowed);
    const baseline = await evaluateBenchmark(loaded, resolve("tests", "fixtures", "evidence-project"));
    expect(JSON.stringify(baseline.tasks[taskIndex]?.coreOutput).match(/Do not perform raw file reads/g)).toHaveLength(2);
    expect(baseline.tasks[taskIndex]?.metrics.criticalConstraintPreservation).toBe(1);

    const unsafe = structuredClone(loaded);
    unsafe.tasks[taskIndex].allowRawReads = true;
    const changed = await evaluateBenchmark(unsafe, resolve("tests", "fixtures", "evidence-project"));
    expect(changed.tasks[taskIndex]?.metrics.criticalConstraintPreservation).toBe(0);
    expect(changed.releaseGate.passed).toBe(false);
  });

  it("keeps corpus ids and independent expected references out of production code", async () => {
    const loaded = await corpus();
    const checkedEvidence = await evidence();
    const files = (await readdir(resolve("src"), { recursive: true })).filter((path) => /\.[cm]?[jt]s$/.test(path));
    const production = (await Promise.all(files.map((path) => readFile(resolve("src", path), "utf8")))).join("\n");
    for (const task of loaded.tasks) {
      expect(production).not.toContain(task.id);
      expect(production).not.toContain(checkedEvidence.tasks[task.id].expectedCompactReference);
    }
  });

  it("keeps benchmark contracts side-effect free and independent from the server module", async () => {
    const source = await readFile(resolve("src", "core", "toolContracts.ts"), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/server/);
    const before = process.listenerCount("uncaughtException");
    const contracts = await import("../src/core/toolContracts.js");
    expect(contracts.benchmarkMcpInputSchemas().planner).toEqual(expect.any(Object));
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("reports an absent required file as a false negative and fails the release gate", async () => {
    const loaded = await corpus();
    loaded.tasks[0].requiredFiles = ["absent/required-file.ts"];

    const report = await evaluateBenchmark(loaded, resolve("tests", "fixtures", "evidence-project"));

    expect(report.tasks[0]?.metrics.falseNegatives).toEqual(["absent/required-file.ts"]);
    expect(report.aggregate.criticalFalseNegativeCount).toBeGreaterThan(0);
    expect(report.releaseGate).toMatchObject({ passed: false, failureReasons: expect.arrayContaining([expect.stringMatching(/false negatives/i)]) });
  });

  it("uses one category flow and accounts its actual serialized output and independent raw baseline", async () => {
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "evidence-project"));
    const expectedFlows: Record<string, string> = {
      "code-routing": "planner",
      "sql-security": "planner",
      debugging: "tracer",
      "change-risk": "risk",
      compression: "compressor",
      "memory-wiki": "wiki-memory",
      "release-packaging": "planner"
    };

    for (const task of report.tasks) {
      expect(task.flow).toBe(expectedFlows[task.category]);
      expect(task.accounting.coreOutputCount).toBe(task.flow === "wiki-memory" ? 2 : 1);
      expect(task.accounting.coreOutputTokens).toHaveLength(task.accounting.coreOutputCount);
      expect(task.accounting.rawBaselineFiles.length).toBeGreaterThan(0);
      expect(task.accounting.rawBaselineFiles.length).toBeLessThan(report.fixtureFileCount);
      expect(task.metrics.compactTokens).toBe(task.accounting.coreOutputTokens.reduce((total, tokens) => total + tokens, 0));
      expect(task.metrics.toolOverheadTokens).toBe(task.accounting.schemaOverheadTokens + task.accounting.footerOverheadTokens);
      expect(task.metrics.rawTokens).toBe(task.accounting.rawBaselineTokens);
      expect(task.accounting.completionFooter).toMatch(/^TokenGraph: ~\d+(?:-\d+)? tokens saved \(estimated, .+ confidence\); quality .+\.$/);
    }
  });

  it("keeps a serialization margin above the release threshold", async () => {
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "evidence-project"));
    expect(report.aggregate.medianNetSavings).toBeGreaterThanOrEqual(25);
  });

  it("charges inflated compact payloads instead of rewarding them", () => {
    const compact = measureSerializedOutput({ rawTokens: 400, serializedOutputs: [{ files: ["src/auth.ts"] }], schemaOverheadTokens: 20, footerOverheadTokens: 10 });
    const inflated = measureSerializedOutput({ rawTokens: 400, serializedOutputs: [{ files: ["src/auth.ts"], padding: "x".repeat(4000) }], schemaOverheadTokens: 20, footerOverheadTokens: 10 });
    expect(compact.netEstimatedSavings).toBeGreaterThan(0);
    expect(inflated.compactTokens).toBeGreaterThan(compact.compactTokens);
    expect(inflated.netEstimatedSavings).toBeLessThan(0);
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

  it("derives one calibration observation per task from reproducible compact references", async () => {
    const checkedEvidence = await evidence();
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "evidence-project"));
    for (const task of report.tasks) {
      const source = checkedEvidence.tasks[task.id];
      const accounting = task.accounting as unknown as { expectedNetSavings: number; expectedReferenceTokens: number };
      const metrics = task.metrics as unknown as { netEstimatedSavings: number; calibrationResidual: number; rawTokens: number; toolOverheadTokens: number };
      expect(source.expectedCompactReference).toEqual(expect.any(String));
      expect(source).not.toHaveProperty("expectedNetSavings");
      expect(accounting.expectedReferenceTokens).toBe(estimateTokens(source.expectedCompactReference));
      expect(accounting.expectedNetSavings).toBe(metrics.rawTokens - accounting.expectedReferenceTokens - metrics.toolOverheadTokens);
      expect(Math.max(0, metrics.netEstimatedSavings) + metrics.calibrationResidual).toBe(accounting.expectedNetSavings);
    }
    for (const category of BENCHMARK_CATEGORIES) {
      expect(report.taskCalibration[category]?.observations).toBe(report.aggregate.categoryCounts[category]);
      expect(report.taskCalibration[category]?.observations).toBeLessThan(10);
      expect(report.calibration.categories[category]?.confidence).toBe("low");
    }
  });

  it("passes low-observation corpus calibration to Task 1A without falsely changing its range or confidence", async () => {
    const report = await evaluateBenchmark(await corpus(), resolve("tests", "fixtures", "evidence-project"));
    const category = "code-routing";
    const event = {
      id: "event-1",
      fingerprint: "fingerprint-1",
      category,
      toolName: "benchmark-tool",
      originalTokens: 200,
      compactTokens: 80,
      overheadTokens: 20,
      confidence: "high" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
      qualityChecks: [{ name: "fixture", passed: true }]
    };
    const ledger = {
      schemaId: "tokengraph-task-ledger",
      schemaVersion: 1,
      taskId: "00000000-0000-4000-8000-000000000001",
      host: "unknown",
      status: "open",
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      estimatorVersion: TASK_ESTIMATOR_VERSION,
      events: [event]
    } satisfies TaskLedger;

    const uncalibrated = buildTaskReport(ledger);
    const accepted = buildTaskReport(ledger, report.taskCalibration);
    expect(accepted.estimate.range).toEqual(uncalibrated.estimate.range);
    expect(accepted.estimate.confidence).toBe("low");
    expect(accepted.estimate.basis).toEqual([`${category}:uncalibrated`]);
  });

  it("uses polarity-safe exact constraint predicates", () => {
    const predicate = (benchmarkLibrary as Record<string, unknown>).constraintPreserved;
    expect(predicate).toBeTypeOf("function");
    const preserved = predicate as (constraint: string, output: string) => boolean;

    expect(preserved("Must not remove the audit call.", "Result: MUST NOT remove the audit call!" )).toBe(true);
    expect(preserved("Must not remove the audit call.", "Result: remove the audit call." )).toBe(false);
    expect(preserved("Must not remove the audit call.", "Result: the audit call must be removed." )).toBe(false);
    expect(preserved("Must not remove the audit call.", "Result: must not remove." )).toBe(false);
  });

  it("evaluates independently twice with only generatedAt allowed to differ", async () => {
    const loaded = await corpus();
    const first = await evaluateBenchmark(loaded, resolve("tests", "fixtures", "evidence-project"));
    const second = await evaluateBenchmark(loaded, resolve("tests", "fixtures", "evidence-project"));
    const firstTimestamp = first.generatedAt;
    const secondTimestamp = second.generatedAt;
    delete (first as { generatedAt?: string }).generatedAt;
    delete (second as { generatedAt?: string }).generatedAt;

    expect(firstTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(secondTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stableBenchmarkJson(first)).toBe(stableBenchmarkJson(second));
  });

  it("rejects the legacy nine-task placeholder report", () => {
    const validateBenchmarkReport = (benchmarkLibrary as Record<string, unknown>).validateBenchmarkReport;
    expect(validateBenchmarkReport).toBeTypeOf("function");
    const legacy = {
      status: "ok",
      claimsPolicy: ["placeholder"],
      tasks: Array.from({ length: 9 }, (_, index) => ({ taskType: `legacy-${index}`, metrics: {} }))
    };

    expect((validateBenchmarkReport as (value: unknown) => { valid: boolean; errors: string[] })(legacy)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/legacy|schema|30/i)])
    });
  });
});
