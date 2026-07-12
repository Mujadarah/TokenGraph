import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compressContext } from "../src/core/contextCompressor.js";
import { traceFailure } from "../src/core/failureTracer.js";
import { buildContextPlan } from "../src/core/planner.js";
import { indexProject } from "../src/core/projectIndexer.js";
import { assessChangeRisk } from "../src/core/regressionRisk.js";
import { reviewMemories } from "../src/core/review.js";
import { TASK_ESTIMATOR_VERSION, type TaskCalibration } from "../src/core/taskEstimator.js";
import { estimateTokens } from "../src/core/token.js";
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
type BenchmarkFlow = "planner" | "tracer" | "risk" | "compressor" | "wiki-memory";

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

interface EvidenceMemory {
  id: string;
  type: MemoryEntry["type"];
  title: string;
  body: string;
  tags: string[];
  linkedFiles: string[];
  confidence: MemoryEntry["confidence"];
}

interface TaskEvidence {
  rawFiles: string[];
  expectedCompactReference: string;
}

interface BenchmarkEvidence {
  schemaId: "tokengraph-benchmark-evidence";
  schemaVersion: 1;
  evidenceVersion: string;
  memories: EvidenceMemory[];
  tasks: Record<string, TaskEvidence>;
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

const FLOW_BY_CATEGORY: Record<BenchmarkCategory, BenchmarkFlow> = {
  "code-routing": "planner",
  "sql-security": "planner",
  debugging: "tracer",
  "change-risk": "risk",
  compression: "compressor",
  "memory-wiki": "wiki-memory",
  "release-packaging": "planner"
};

const SCHEMA_BY_FLOW: Record<BenchmarkFlow, unknown> = {
  planner: { task: "string", profile: "balanced", allowRawReads: "boolean" },
  tracer: { kind: "test", text: "string", task: "string", profile: "balanced" },
  risk: { changedFiles: "string[]", task: "string", profile: "balanced" },
  compressor: { task: "string", contentKind: "mixed", text: "string", preserveRawReferences: true },
  "wiki-memory": [{ tool: "wiki", input: "project-index" }, { tool: "memory-review", query: "string", limit: "number" }]
};

const FOOTER = "Token estimates are deterministic fixture estimates; inspect failure reasons and use targeted raw reads when allowed.";
const EVIDENCE_PATH = resolve("scripts", "benchmark-evidence-v1.json");

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

export function validateBenchmarkReport(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value) || value.schemaId !== "tokengraph-evidence-benchmark-report" || value.schemaVersion !== 1) {
    return { valid: false, errors: ["Legacy or unknown benchmark report schema; evidence report version 1 is required."] };
  }
  const reportTasks = Array.isArray(value.tasks) ? value.tasks : [];
  if (reportTasks.length < 30) errors.push("Benchmark report must contain at least 30 tasks.");
  if (!isRecord(value.aggregate) || value.aggregate.taskCount !== reportTasks.length) errors.push("Benchmark aggregate task count is invalid.");
  if (!isRecord(value.releaseGate) || typeof value.releaseGate.passed !== "boolean") errors.push("Benchmark release gate is invalid.");
  return { valid: errors.length === 0, errors };
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

function evidenceMemory(entry: EvidenceMemory): MemoryEntry {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    ...entry,
    status: "active",
    linkedSymbols: [],
    linkedSqlObjects: [],
    linkedRules: [],
    supersedes: [],
    supersededBy: [],
    source: "benchmark-evidence-v1",
    evidence: entry.linkedFiles,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function loadEvidence(): Promise<BenchmarkEvidence> {
  const evidence = JSON.parse(await readFile(EVIDENCE_PATH, "utf8")) as BenchmarkEvidence;
  if (evidence.schemaId !== "tokengraph-benchmark-evidence" || evidence.schemaVersion !== 1) throw new Error("Benchmark evidence schema is invalid.");
  return evidence;
}

async function rawBaseline(root: string, files: string[]): Promise<{ text: string; tokens: number }> {
  const parts: string[] = [];
  for (const path of files) parts.push(await readFile(resolve(root, path), "utf8"));
  const text = parts.join("\n");
  return { text, tokens: estimateTokens(text) };
}

function changedFiles(evidence: TaskEvidence, project: ProjectIndex): string[] {
  const indexed = new Set(project.files.map((file) => file.path));
  const candidate = evidence.rawFiles.find((path) => indexed.has(path) && !/\.(?:md|test\.[cm]?[jt]sx?)$/.test(path));
  return candidate ? [candidate] : [];
}

async function runFlow(input: {
  flow: BenchmarkFlow;
  task: BenchmarkTask;
  evidence: TaskEvidence;
  rawText: string;
  root: string;
  project: ProjectIndex;
  memories: MemoryEntry[];
}): Promise<{ coreOutput: unknown; serializedOutputs: unknown[]; selectedFiles: string[]; recommendedTests: string[] }> {
  const { flow, task, evidence, rawText, root, project, memories } = input;
  if (flow === "planner") {
    const output = await buildContextPlan({
      root,
      task: task.query,
      project,
      memories,
      budget: { profile: "balanced", maxFiles: 8, maxSqlObjects: 8, maxMemories: 4, firstReads: 4, allowRawReads: true }
    });
    return {
      coreOutput: output,
      serializedOutputs: [output],
      selectedFiles: [...output.relevantFiles, ...output.relevantTests].map((entry) => entry.path).concat(output.relevantSql.map((entry) => entry.filePath)),
      recommendedTests: output.relevantTests.map((entry) => entry.path)
    };
  }
  if (flow === "tracer") {
    const output = await traceFailure({ root, kind: "test", text: rawText, task: task.query, project, memories });
    return {
      coreOutput: output,
      serializedOutputs: [output],
      selectedFiles: [...output.relatedFiles, ...output.recommendedFirstReads].map((entry) => entry.path).concat(output.relatedSql.map((entry) => entry.filePath)),
      recommendedTests: [
        ...output.detectedTests.filter((entry) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry)),
        ...output.recommendedCommands.flatMap((command) => command.match(/(?:^|\s)([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s|$)/)?.[1] ?? [])
      ]
    };
  }
  if (flow === "risk") {
    const output = await assessChangeRisk({ root, changedFiles: changedFiles(evidence, project), task: task.query, project, rules: [], memories });
    return {
      coreOutput: output,
      serializedOutputs: [output],
      selectedFiles: output.affectedFiles.map((entry) => entry.path).concat(output.affectedTests.map((entry) => entry.path), output.affectedSql.map((entry) => entry.filePath)),
      recommendedTests: output.affectedTests.map((entry) => entry.path)
    };
  }
  if (flow === "compressor") {
    const output = await compressContext({
      root,
      task: task.query,
      contentKind: task.category === "sql-security" ? "sql" : "mixed",
      text: rawText,
      preserveRawReferences: true,
      project,
      memories
    });
    return {
      coreOutput: output,
      serializedOutputs: [output],
      selectedFiles: output.recommendedFirstReads.map((entry) => entry.path),
      recommendedTests: output.recommendedFirstReads.map((entry) => entry.path).filter((path) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path))
    };
  }
  const wiki = buildProjectWiki(project, memories);
  const memoryReview = await reviewMemories({ memories, query: task.query, limit: 4 });
  const matchedIds = new Set(memoryReview.matches.filter((match) => match.score > 0).map((match) => match.id));
  return {
    coreOutput: { wiki, memoryReview },
    serializedOutputs: [wiki, memoryReview],
    selectedFiles: memories.filter((memory) => matchedIds.has(memory.id)).flatMap((memory) => memory.linkedFiles),
    recommendedTests: []
  };
}

function normalizePredicate(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function constraintPreserved(constraint: string, serializedOutput: string): boolean {
  const predicate = normalizePredicate(constraint);
  if (!predicate) return true;
  return ` ${normalizePredicate(serializedOutput)} `.includes(` ${predicate} `);
}

async function evaluateTask(task: BenchmarkTask, evidence: TaskEvidence, root: string, project: ProjectIndex, memories: MemoryEntry[]) {
  const flow = FLOW_BY_CATEGORY[task.category];
  const baseline = await rawBaseline(root, evidence.rawFiles);
  const result = await runFlow({ flow, task, evidence, rawText: baseline.text, root, project, memories });
  const selected = new Set(result.selectedFiles);
  const recommendedTests = [...new Set(result.recommendedTests)].sort();
  const falseNegatives = task.requiredFiles.filter((path) => !selected.has(path)).sort();
  const falsePositives = task.forbiddenFalsePositiveFiles.filter((path) => selected.has(path)).sort();
  const serializedOutput = JSON.stringify(result.coreOutput);
  const preservedCount = task.criticalConstraints.filter((constraint) => constraintPreserved(constraint, serializedOutput)).length;
  const criticalConstraintPreservation = task.criticalConstraints.length ? preservedCount / task.criticalConstraints.length : 1;
  const requiredFileRecall = task.requiredFiles.length ? (task.requiredFiles.length - falseNegatives.length) / task.requiredFiles.length : 1;
  const coreOutputTokens = result.serializedOutputs.map((output) => estimateTokens(JSON.stringify(output)));
  const compactTokens = coreOutputTokens.reduce((total, tokens) => total + tokens, 0);
  const schemaOverheadTokens: number = flow === "wiki-memory"
    ? (SCHEMA_BY_FLOW[flow] as unknown[]).reduce<number>((total, schema) => total + estimateTokens(JSON.stringify(schema)), 0)
    : estimateTokens(JSON.stringify({ tool: `tokengraph_${flow}`, inputSchema: SCHEMA_BY_FLOW[flow] }));
  const footerOverheadTokens = estimateTokens(FOOTER);
  const toolOverheadTokens = schemaOverheadTokens + footerOverheadTokens;
  const netEstimatedSavings = baseline.tokens - compactTokens - toolOverheadTokens;
  const expectedReferenceTokens = estimateTokens(evidence.expectedCompactReference);
  const expectedNetSavings = baseline.tokens - expectedReferenceTokens - toolOverheadTokens;
  const missingExpectedTests = task.expectedTests.filter((path) => !recommendedTests.includes(path));
  const calibrationResidual = expectedNetSavings - Math.max(0, netEstimatedSavings);
  const failureReasons = [
    ...(falseNegatives.length ? [`Required files not recalled: ${falseNegatives.join(", ")}.`] : []),
    ...(falsePositives.length ? [`Forbidden false-positive files selected: ${falsePositives.join(", ")}.`] : []),
    ...(criticalConstraintPreservation !== 1 ? ["One or more critical constraints were not preserved."] : []),
    ...(missingExpectedTests.length ? [`Expected tests not recommended: ${missingExpectedTests.join(", ")}.`] : []),
    ...(netEstimatedSavings <= 0 ? ["Net estimated savings were not positive after schema, tool, and footer overhead."] : [])
  ];
  return {
    id: task.id,
    category: task.category,
    query: task.query,
    targetedRawReadsAllowed: task.targetedRawReadsAllowed,
    flow,
    coreOutput: result.coreOutput,
    accounting: {
      coreOutputCount: result.serializedOutputs.length,
      coreOutputTokens,
      rawBaselineFiles: [...evidence.rawFiles],
      rawBaselineTokens: baseline.tokens,
      schemaOverheadTokens,
      footerOverheadTokens,
      expectedCompactReference: evidence.expectedCompactReference,
      expectedReferenceTokens,
      expectedNetSavings
    },
    metrics: {
      requiredFileRecall,
      falsePositives,
      falseNegatives,
      criticalConstraintPreservation,
      recommendedTests,
      rawTokens: baseline.tokens,
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
  const evidence = await loadEvidence();
  const root = resolve(fixtureRoot);
  const project = await indexProject(root, { scanSignature: `benchmark:${corpus.corpusVersion}:${evidence.evidenceVersion}` });
  const memories = evidence.memories.map(evidenceMemory);
  const tasks: Awaited<ReturnType<typeof evaluateTask>>[] = [];
  for (const task of validation.tasks) {
    const taskEvidence = evidence.tasks[task.id];
    if (!taskEvidence) throw new Error(`Independent benchmark evidence is missing for ${task.id}.`);
    tasks.push(await evaluateTask(task, taskEvidence, root, project, memories));
  }
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
  const observations = tasks.map((task) => ({ category: task.category, residual: task.metrics.calibrationResidual }));
  const calibration = buildCalibration(observations);
  const taskCalibration: TaskCalibration = Object.fromEntries(
    Object.entries(calibration.categories).map(([category, entry]) => [category, { observations: entry.observations, lowResidual: entry.lowResidual, highResidual: entry.highResidual }])
  );
  return {
    schemaId: "tokengraph-evidence-benchmark-report",
    schemaVersion: 1,
    corpusVersion: corpus.corpusVersion,
    evidenceVersion: evidence.evidenceVersion,
    generatedAt: new Date().toISOString(),
    fixture: "tests/fixtures/evidence-project",
    fixtureFileCount: project.files.length,
    baselineRequiredFileRecall: corpus.baselineRequiredFileRecall,
    tasks,
    aggregate,
    releaseGate,
    calibration,
    taskCalibration
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
