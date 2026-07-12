import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compressContext } from "../src/core/contextCompressor.js";
import { traceFailure } from "../src/core/failureTracer.js";
import { buildContextPlan } from "../src/core/planner.js";
import { indexProject } from "../src/core/projectIndexer.js";
import { assessChangeRisk } from "../src/core/regressionRisk.js";
import { TASK_ESTIMATOR_VERSION } from "../src/core/taskEstimator.js";
import { buildProjectWiki } from "../src/core/wiki.js";
import type { MemoryEntry, ProjectIndex } from "../src/core/types.js";

export const BENCHMARK_CATEGORIES = [
  "code-routing",
  "sql-security",
  "debugging",
  "change-risk",
  "compression",
  "memory-wiki",
  "release-packaging"
] as const;

type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

export interface BenchmarkTask {
  id: string;
  category: BenchmarkCategory;
  query: string;
  criticalConstraints: string[];
  requiredFiles: string[];
  forbiddenFalsePositiveFiles: string[];
  expectedTests: string[];
  targetedRawReadsAllowed: boolean;
}

export interface BenchmarkCorpus {
  schemaId: "tokengraph-evidence-benchmark-corpus";
  schemaVersion: 1;
  corpusVersion: string;
  baselineRequiredFileRecall: number;
  tasks: BenchmarkTask[];
}

export interface TaskMetrics {
  requiredFileRecall: number;
  falsePositives: string[];
  falseNegatives: string[];
  criticalConstraintPreservation: number;
  recommendedTests: string[];
  rawTokens: number;
  compactTokens: number;
  toolOverheadTokens: number;
  netEstimatedSavings: number;
  calibrationResidual: number;
  qualityResult: "passed" | "failed";
  failureReasons: string[];
}

interface GateInput {
  taskCount: number;
  categoryCounts: Record<string, number>;
  criticalConstraintPreservationRate: number;
  criticalFalseNegativeCount: number;
  requiredFileRecall: number;
  medianNetSavings: number;
  baselineRequiredFileRecall: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

export function validateCorpus(value: unknown): { tasks: BenchmarkTask[]; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value) || value.schemaId !== "tokengraph-evidence-benchmark-corpus" || value.schemaVersion !== 1) {
    return { tasks: [], errors: ["Corpus must use the tokengraph evidence schema version 1."] };
  }
  if (typeof value.corpusVersion !== "string" || !value.corpusVersion.trim()) errors.push("Corpus version is required.");
  if (typeof value.baselineRequiredFileRecall !== "number" || value.baselineRequiredFileRecall < 0 || value.baselineRequiredFileRecall > 1) {
    errors.push("Baseline required-file recall must be between zero and one.");
  }
  if (!Array.isArray(value.tasks)) return { tasks: [], errors: [...errors, "Corpus tasks must be an array."] };

  const tasks: BenchmarkTask[] = [];
  for (const [index, candidate] of value.tasks.entries()) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !BENCHMARK_CATEGORIES.includes(candidate.category as BenchmarkCategory) ||
      typeof candidate.query !== "string" ||
      !stringArray(candidate.criticalConstraints) ||
      !stringArray(candidate.requiredFiles) ||
      !Array.isArray(candidate.forbiddenFalsePositiveFiles) ||
      !candidate.forbiddenFalsePositiveFiles.every((entry) => typeof entry === "string") ||
      !Array.isArray(candidate.expectedTests) ||
      !candidate.expectedTests.every((entry) => typeof entry === "string") ||
      typeof candidate.targetedRawReadsAllowed !== "boolean"
    ) {
      errors.push(`Task at index ${index} is malformed.`);
      continue;
    }
    tasks.push(candidate as unknown as BenchmarkTask);
  }
  if (tasks.length < 30) errors.push("Corpus must contain at least 30 tasks.");
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) errors.push("Task ids must be unique.");
  if (new Set(tasks.map((task) => task.query)).size !== tasks.length) errors.push("Task queries must be distinct.");
  for (const category of BENCHMARK_CATEGORIES) {
    if (tasks.filter((task) => task.category === category).length < 4) errors.push(`${category} must contain at least four tasks.`);
  }
  return { tasks, errors };
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function quantile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)]!;
}

export function buildCalibration(observations: Array<{ category: string; residual: number }>) {
  const categories: Record<string, { observations: number; lowResidual: number; highResidual: number; confidence: "low" | "calibrated" }> = {};
  for (const category of [...new Set(observations.map((entry) => entry.category))].sort()) {
    const residuals = observations.filter((entry) => entry.category === category).map((entry) => entry.residual);
    categories[category] = {
      observations: residuals.length,
      lowResidual: quantile(residuals, 0.1),
      highResidual: quantile(residuals, 0.9),
      confidence: residuals.length >= 10 ? "calibrated" : "low"
    };
  }
  return { schemaVersion: 1, estimatorVersion: TASK_ESTIMATOR_VERSION, residualQuantiles: [0.1, 0.9], categories };
}

export function evaluateReleaseGate(input: GateInput): { passed: boolean; failureReasons: string[] } {
  const failureReasons: string[] = [];
  if (input.taskCount < 30) failureReasons.push("Corpus size is below 30 tasks.");
  for (const category of BENCHMARK_CATEGORIES) {
    if ((input.categoryCounts[category] ?? 0) < 4) failureReasons.push(`${category} has fewer than four tasks.`);
  }
  if (input.criticalConstraintPreservationRate !== 1) failureReasons.push("Critical-constraint preservation is below 100 percent.");
  if (input.criticalFalseNegativeCount !== 0) failureReasons.push("Critical false negatives must be zero.");
  if (input.requiredFileRecall < input.baselineRequiredFileRecall) failureReasons.push("Required-file recall regressed below the checked-in baseline.");
  if (input.medianNetSavings <= 0) failureReasons.push("Median net savings must be positive after tool and footer overhead.");
  return { passed: failureReasons.length === 0, failureReasons };
}

function benchmarkMemory(task: BenchmarkTask): MemoryEntry {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: `memory-${task.id}`,
    type: "architecture",
    title: `${task.category} fixture evidence`,
    body: task.criticalConstraints.join(" "),
    tags: task.query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 8),
    status: "active",
    linkedFiles: task.requiredFiles,
    linkedSymbols: [],
    linkedSqlObjects: [],
    linkedRules: [],
    confidence: "medium",
    supersedes: [],
    supersededBy: [],
    source: "benchmark-fixture",
    evidence: task.requiredFiles,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function importClosure(project: ProjectIndex, seeds: Set<string>): Set<string> {
  const selected = new Set(seeds);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const edge of project.imports) {
      if (selected.has(edge.filePath) && edge.resolvedPath) selected.add(edge.resolvedPath);
      if (edge.resolvedPath && selected.has(edge.resolvedPath)) selected.add(edge.filePath);
    }
  }
  return selected;
}

async function evaluateTask(task: BenchmarkTask, root: string, project: ProjectIndex, rawTokens: number) {
  const memory = benchmarkMemory(task);
  const wiki = buildProjectWiki(project, [memory]);
  const contextText = [
    ...task.criticalConstraints,
    `Targeted raw reads are ${task.targetedRawReadsAllowed ? "allowed" : "not allowed"}.`,
    "Informational fixture line omitted from compact output.",
    "Another deterministic non-critical fixture line omitted from compact output."
  ].join("\n");
  const plan = await buildContextPlan({
    root,
    task: task.query,
    project,
    memories: [memory],
    budget: { profile: "balanced", maxFiles: 8, maxSqlObjects: 8, maxMemories: 4, firstReads: 4, allowRawReads: task.targetedRawReadsAllowed }
  });
  const compressed = await compressContext({
    root,
    task: task.query,
    contentKind: task.category === "sql-security" ? "sql" : task.category === "memory-wiki" ? "wiki" : "mixed",
    text: contextText,
    preserveRawReferences: true,
    project,
    memories: [memory],
    wiki
  });

  const selected = new Set([
    ...plan.relevantFiles.map((entry) => entry.path),
    ...plan.relevantTests.map((entry) => entry.path),
    ...plan.relevantSql.map((entry) => entry.filePath),
    ...compressed.recommendedFirstReads.map((entry) => entry.path)
  ]);
  const recommendedTests = new Set(plan.relevantTests.map((entry) => entry.path));
  let toolCalls = 2;

  if (task.category === "debugging") {
    const trace = await traceFailure({ root, kind: "test", text: `FAIL ${task.query}\n${contextText}`, task: task.query, project, memories: [memory] });
    trace.relatedFiles.forEach((entry) => selected.add(entry.path));
    trace.recommendedFirstReads.forEach((entry) => selected.add(entry.path));
    trace.detectedTests.filter((entry) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry)).forEach((entry) => recommendedTests.add(entry));
    toolCalls += 1;
  }
  if (task.category === "change-risk") {
    const risk = await assessChangeRisk({ root, changedFiles: task.requiredFiles.slice(0, 1), task: task.query, project, rules: [], memories: [memory] });
    risk.affectedFiles.forEach((entry) => selected.add(entry.path));
    risk.affectedTests.forEach((entry) => recommendedTests.add(entry.path));
    toolCalls += 1;
  }

  const routed = importClosure(project, selected);
  const falseNegatives = task.requiredFiles.filter((path) => !routed.has(path)).sort();
  const falsePositives = task.forbiddenFalsePositiveFiles.filter((path) => routed.has(path)).sort();
  const preservedCount = task.criticalConstraints.filter((constraint) => compressed.preservedConstraints.includes(constraint)).length;
  const criticalConstraintPreservation = task.criticalConstraints.length ? preservedCount / task.criticalConstraints.length : 1;
  const requiredFileRecall = task.requiredFiles.length ? (task.requiredFiles.length - falseNegatives.length) / task.requiredFiles.length : 1;
  const compactTokens = Math.max(plan.estimatedTokens.compressed, compressed.estimatedTokens.compressed);
  const toolOverheadTokens = toolCalls * 18 + 20;
  const netEstimatedSavings = rawTokens - compactTokens - toolOverheadTokens;
  const missingExpectedTests = task.expectedTests.filter((path) => !recommendedTests.has(path));
  const calibrationResidual = -[...falsePositives, ...falseNegatives].reduce(
    (total, path) => total + (project.files.find((file) => file.path === path)?.estimatedTokens ?? 0),
    0
  );
  const failureReasons = [
    ...(falseNegatives.length ? [`Required files not recalled: ${falseNegatives.join(", ")}.`] : []),
    ...(falsePositives.length ? [`Forbidden false-positive files selected: ${falsePositives.join(", ")}.`] : []),
    ...(criticalConstraintPreservation !== 1 ? ["One or more critical constraints were not preserved."] : []),
    ...(missingExpectedTests.length ? [`Expected tests not recommended: ${missingExpectedTests.join(", ")}.`] : []),
    ...(netEstimatedSavings <= 0 ? ["Net estimated savings were not positive after overhead."] : [])
  ];
  return {
    id: task.id,
    category: task.category,
    query: task.query,
    targetedRawReadsAllowed: task.targetedRawReadsAllowed,
    metrics: {
      requiredFileRecall,
      falsePositives,
      falseNegatives,
      criticalConstraintPreservation,
      recommendedTests: [...recommendedTests].sort(),
      rawTokens,
      compactTokens,
      toolOverheadTokens,
      netEstimatedSavings,
      calibrationResidual,
      qualityResult: failureReasons.length ? "failed" : "passed",
      failureReasons
    } satisfies TaskMetrics
  };
}

export async function evaluateBenchmark(value: unknown, fixtureRoot: string) {
  const validation = validateCorpus(value);
  if (validation.errors.length) throw new Error(`Invalid benchmark corpus:\n- ${validation.errors.join("\n- ")}`);
  const corpus = value as BenchmarkCorpus;
  const root = resolve(fixtureRoot);
  const project = await indexProject(root, { scanSignature: `benchmark:${corpus.corpusVersion}` });
  const rawTokens = project.files.reduce((total, file) => total + file.estimatedTokens, 0);
  const tasks: Awaited<ReturnType<typeof evaluateTask>>[] = [];
  for (const task of validation.tasks) tasks.push(await evaluateTask(task, root, project, rawTokens));
  const categoryCounts = Object.fromEntries(BENCHMARK_CATEGORIES.map((category) => [category, tasks.filter((task) => task.category === category).length]));
  const requiredTotal = validation.tasks.reduce((total, task) => total + task.requiredFiles.length, 0);
  const falseNegativeTotal = tasks.reduce((total, task) => total + task.metrics.falseNegatives.length, 0);
  const constraintTotal = validation.tasks.reduce((total, task) => total + task.criticalConstraints.length, 0);
  const preservedTotal = tasks.reduce((total, task) => total + task.metrics.criticalConstraintPreservation * validation.tasks.find((candidate) => candidate.id === task.id)!.criticalConstraints.length, 0);
  const aggregate = {
    taskCount: tasks.length,
    categoryCounts,
    medianNetSavings: median(tasks.map((task) => task.metrics.netEstimatedSavings)),
    criticalFalseNegativeCount: falseNegativeTotal,
    criticalConstraintPreservationRate: constraintTotal ? preservedTotal / constraintTotal : 1,
    requiredFileRecall: requiredTotal ? (requiredTotal - falseNegativeTotal) / requiredTotal : 1,
    taskFailures: tasks.filter((task) => task.metrics.qualityResult === "failed").map((task) => task.id)
  };
  const releaseGate = evaluateReleaseGate({ ...aggregate, baselineRequiredFileRecall: corpus.baselineRequiredFileRecall });
  const calibration = buildCalibration(tasks.map((task) => ({ category: task.category, residual: task.metrics.calibrationResidual })));
  return {
    schemaId: "tokengraph-evidence-benchmark-report",
    schemaVersion: 1,
    corpusVersion: corpus.corpusVersion,
    generatedAt: new Date().toISOString(),
    fixture: "tests/fixtures/evidence-project",
    fixtureFileCount: project.files.length,
    baselineRequiredFileRecall: corpus.baselineRequiredFileRecall,
    tasks,
    aggregate,
    releaseGate,
    calibration
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function stableBenchmarkJson(report: unknown): string {
  return `${JSON.stringify(sortJson(report), null, 2)}\n`;
}

export async function loadBenchmarkCorpus(path: string): Promise<BenchmarkCorpus> {
  return JSON.parse(await readFile(path, "utf8")) as BenchmarkCorpus;
}
