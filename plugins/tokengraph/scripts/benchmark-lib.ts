import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compressContext } from "../src/core/contextCompressor.js";
import { traceFailure } from "../src/core/failureTracer.js";
import { buildContextPlan } from "../src/core/planner.js";
import { indexProject } from "../src/core/projectIndexer.js";
import { assessChangeRisk } from "../src/core/regressionRisk.js";
import { reviewMemories } from "../src/core/review.js";
import { executeRun, summarizeRun, type SavedRunSummary } from "../src/core/runner.js";
import { deliverDelta, readExactSlice } from "../src/core/retrieval.js";
import { artifactKey, createStableArtifact } from "../src/core/artifact.js";
import { adviseRouting } from "../src/core/routingAdvisor.js";
import { TASK_ESTIMATOR_VERSION, type TaskCalibration } from "../src/core/taskEstimator.js";
import { estimateTokens } from "../src/core/token.js";
import { buildTaskReport, formatTaskReportFooter } from "../src/core/taskEstimator.js";
import type { TaskLedger } from "../src/core/taskLedger.js";
import {
  coreToolsListDefinitions,
  compactCompressionEnvelope,
  compactModeEnvelope,
  compactPrepareEnvelope,
  compactToolResultEnvelope
} from "../src/core/toolContracts.js";
import {
  compactCompressionResponse,
  compactFailureResponse,
  hasSqlIntent,
  NO_RAW_READ_GUIDANCE,
  compactPlanResponse,
  compactRecallResponse,
  compactRiskResponse,
  compactSliceResponse
} from "../src/core/compactResponses.js";
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
  constraints: string[];
  criticalConstraints: string[];
  requiredFiles: string[];
  forbiddenFalsePositiveFiles: string[];
  expectedTests: string[];
  allowRawReads?: boolean;
  targetedRawReadsAllowed: boolean;
  expectedRouting: "activate" | "bypass";
  requiresExactSlice?: boolean;
}

export interface RouterShadowSummary {
  observationCount: number;
  beneficialTaskCount: number;
  boundedTaskCount: number;
  falseBypassCount: number;
  falseActivationCount: number;
  falseBypassRate: number | null;
  falseActivationRate: number | null;
  categoryCounts: Record<string, { observations: number; beneficial: number; bounded: number; activated: number; bypassed: number }>;
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

interface RunnerFixture {
  rawOutput: string;
  summary: SavedRunSummary;
  summaryText: string;
  logicalCommand: string;
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
  executionInclusiveNetSavings: number;
  calibrationResidual: number;
  economicsResult: "positive" | "non-positive";
  qualityResult: "passed" | "failed";
  failureReasons: string[];
}

export interface BenchmarkBaselineArtifact {
  label: "recommended-raw-reads" | "raw-run-output";
  files: string[];
  tokens: number;
  fullIndexDumpTokens: number;
}

export interface DeltaDeliveryBenchmark {
  defaultAssumption: "no-handshake";
  noHandshake: { knownArtifactsProvided: false; deliveredTokens: number; savedTokens: 0 };
  handshake: { knownArtifactsProvided: true; deliveredTokens: number; savedTokens: number };
}

interface GateInput {
  taskCount: number;
  categoryCounts: Record<string, number>;
  criticalConstraintPreservationRate: number;
  criticalFalseNegativeCount: number;
  requiredFileRecall: number;
  medianNetSavings: number;
  executionInclusiveMedian: number;
  executionInclusiveP25: number;
  nonNegativeActivatedRate: number;
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
      !Array.isArray(candidate.constraints) ||
      !candidate.constraints.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
      !stringArray(candidate.criticalConstraints) ||
      !stringArray(candidate.requiredFiles) ||
      !Array.isArray(candidate.forbiddenFalsePositiveFiles) ||
      !candidate.forbiddenFalsePositiveFiles.every((entry) => typeof entry === "string") ||
      !Array.isArray(candidate.expectedTests) ||
      !candidate.expectedTests.every((entry) => typeof entry === "string") ||
      (candidate.expectedRouting !== "activate" && candidate.expectedRouting !== "bypass") ||
      (candidate.allowRawReads !== undefined && typeof candidate.allowRawReads !== "boolean") ||
      (candidate.requiresExactSlice !== undefined && typeof candidate.requiresExactSlice !== "boolean") ||
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

export function summarizeRouterShadow(tasks: Array<{
  category: string;
  expectedRouting: "activate" | "bypass";
  routing: { useTokenGraph: boolean };
}>): RouterShadowSummary {
  const beneficial = tasks.filter((task) => task.expectedRouting === "activate");
  const bounded = tasks.filter((task) => task.expectedRouting === "bypass");
  const falseBypassCount = beneficial.filter((task) => !task.routing.useTokenGraph).length;
  const falseActivationCount = bounded.filter((task) => task.routing.useTokenGraph).length;
  const categories = [...new Set([...BENCHMARK_CATEGORIES, ...tasks.map((task) => task.category)])].sort();
  return {
    observationCount: tasks.length,
    beneficialTaskCount: beneficial.length,
    boundedTaskCount: bounded.length,
    falseBypassCount,
    falseActivationCount,
    falseBypassRate: beneficial.length ? falseBypassCount / beneficial.length : null,
    falseActivationRate: bounded.length ? falseActivationCount / bounded.length : null,
    categoryCounts: Object.fromEntries(categories.map((category) => {
      const categoryTasks = tasks.filter((task) => task.category === category);
      return [category, {
        observations: categoryTasks.length,
        beneficial: categoryTasks.filter((task) => task.expectedRouting === "activate").length,
        bounded: categoryTasks.filter((task) => task.expectedRouting === "bypass").length,
        activated: categoryTasks.filter((task) => task.routing.useTokenGraph).length,
        bypassed: categoryTasks.filter((task) => !task.routing.useTokenGraph).length
      }];
    }))
  };
}

function quantile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)]!;
}

function measureDeltaDelivery(tasks: Array<{ id: string; coreOutput: unknown }>): DeltaDeliveryBenchmark {
  const artifacts = tasks.map((task) => createStableArtifact(`benchmark/${task.id}`, task.coreOutput, 1));
  const expected = { handshakeId: "benchmark", hostContextId: "fixture", sequence: 0 };
  const actual = { ...expected, sequence: 1 };
  const noHandshake = deliverDelta(expected, actual, artifacts);
  const handshake = deliverDelta(expected, actual, artifacts, artifacts.map(artifactKey));
  const noHandshakeTokens = estimateTokens(JSON.stringify(noHandshake));
  const handshakeTokens = estimateTokens(JSON.stringify(handshake));
  return {
    defaultAssumption: "no-handshake",
    noHandshake: { knownArtifactsProvided: false, deliveredTokens: noHandshakeTokens, savedTokens: 0 },
    handshake: { knownArtifactsProvided: true, deliveredTokens: handshakeTokens, savedTokens: noHandshakeTokens - handshakeTokens }
  };
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
  if (input.executionInclusiveMedian <= 0) failureReasons.push("Execution-inclusive median net savings must be positive after targeted reads.");
  if (input.executionInclusiveP25 < 0) failureReasons.push("Execution-inclusive p25 net savings must be non-negative after targeted reads.");
  if (input.nonNegativeActivatedRate < 0.8) failureReasons.push("At least 80 percent of activated tasks must have non-negative execution-inclusive savings.");
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

function canonicalBenchmarkText(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

async function rawBaseline(root: string, files: string[]): Promise<{
  text: string;
  tokens: number;
  files: Array<{ path: string; text: string }>;
}> {
  const parts: Array<{ path: string; text: string }> = [];
  for (const path of files) {
    parts.push({ path, text: canonicalBenchmarkText(await readFile(resolve(root, path), "utf8")) });
  }
  const text = parts.map((part) => part.text).join("\n");
  return { text, tokens: estimateTokens(text), files: parts };
}

async function executeRunnerFixture(task: BenchmarkTask, root: string): Promise<RunnerFixture> {
  const error = `Error: ${task.criticalConstraints.join(" ")}`;
  const tests = task.expectedTests.map((path) => `FAIL ${path}`);
  const frames = task.requiredFiles.map((path, index) => `    at benchmarkFrame${index + 1} (${path}:1:1)`);
  const noise = Array.from({ length: 80 }, () => "debug trace: retrying deterministic fixture step with unchanged intermediate state");
  const rawOutput = canonicalBenchmarkText([error, ...tests, ...frames, ...noise, ""].join("\n"));
  const encoded = Buffer.from(rawOutput, "utf8").toString("base64");
  const run = await executeRun({
    root,
    command: process.execPath,
    args: ["-e", `process.stderr.write(Buffer.from(${JSON.stringify(encoded)}, "base64")); process.exitCode = 1;`],
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
    metadata: { ...(task.expectedTests[0] ? { test: task.expectedTests[0] } : {}), ...(task.requiredFiles[0] ? { file: task.requiredFiles[0] } : {}), errorClass: "Error" }
  });
  const summary = { ...summarizeRun(run), runId: `benchmark-${task.id}` };
  return {
    rawOutput,
    summary,
    summaryText: JSON.stringify({ ...summary, stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated }),
    logicalCommand: `tokengraph run -- benchmark-fixture ${task.id}`
  };
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
}): Promise<{ coreOutput: unknown; serializedOutputs: unknown[]; selectedFiles: string[]; recommendedTests: string[]; rawReadGuidance: Array<string | undefined> }> {
  const { flow, task, evidence, rawText, root, project, memories } = input;
  if (flow === "planner") {
    const verbose = await buildContextPlan({
      root,
      task: task.query,
      project,
      memories,
      budget: { profile: "balanced", maxFiles: 8, maxSqlObjects: 8, maxMemories: 4, firstReads: 4, allowRawReads: true }
    });
    const output = compactPlanResponse(verbose, { constraints: task.constraints, allowRawReads: task.allowRawReads ?? true });
    const response = compactPrepareEnvelope({
      root, taskId: "00000000-0000-4000-8000-000000000000", plan: output
    });
    const wire = compactToolResultEnvelope(response);
    return {
      coreOutput: wire,
      serializedOutputs: [wire],
      selectedFiles: output.files.map((entry) => entry.path),
      recommendedTests: output.tests, rawReadGuidance: [output.rawReadGuidance]
    };
  }
  if (flow === "tracer") {
    const verbose = await traceFailure({ root, kind: "test", text: rawText, task: task.query, project, memories });
    const output = compactFailureResponse(verbose, { constraints: task.constraints, allowRawReads: task.allowRawReads ?? true, includeSql: hasSqlIntent(task.query) });
    const response = compactModeEnvelope("failure", output);
    const wire = compactToolResultEnvelope(response);
    return {
      coreOutput: wire,
      serializedOutputs: [wire],
      selectedFiles: output.files.map((entry) => entry.path),
      recommendedTests: output.tests, rawReadGuidance: [output.rawReadGuidance]
    };
  }
  if (flow === "risk") {
    const verbose = await assessChangeRisk({ root, changedFiles: changedFiles(evidence, project), task: task.query, project, rules: [], memories });
    const output = compactRiskResponse(verbose, { constraints: task.constraints, allowRawReads: task.allowRawReads ?? true });
    const response = compactModeEnvelope("risk", output);
    const wire = compactToolResultEnvelope(response);
    return {
      coreOutput: wire,
      serializedOutputs: [wire],
      selectedFiles: output.files.map((entry) => entry.path),
      recommendedTests: output.tests, rawReadGuidance: [output.rawReadGuidance]
    };
  }
  if (flow === "compressor") {
    const verbose = await compressContext({
      root,
      task: task.query,
      contentKind: task.category === "sql-security" ? "sql" : "mixed",
      text: rawText,
      preserveRawReferences: true,
      project,
      memories
    });
    const output = compactCompressionResponse(verbose, { constraints: task.constraints, allowRawReads: task.allowRawReads ?? true });
    const response = compactCompressionEnvelope("context", output);
    const wire = compactToolResultEnvelope(response);
    return {
      coreOutput: wire,
      serializedOutputs: [wire],
      selectedFiles: output.files.map((entry) => entry.path),
      recommendedTests: output.tests, rawReadGuidance: [output.rawReadGuidance]
    };
  }
  const memoryReview = await reviewMemories({ memories, query: task.query, limit: 4 });
  const compactReview = compactRecallResponse(memoryReview, { constraints: task.constraints, allowRawReads: task.allowRawReads ?? true }, memories, project);
  const memoryResponse = compactModeEnvelope("review", compactReview);
  const memoryWire = compactToolResultEnvelope(memoryResponse);
  return {
    coreOutput: memoryWire,
    serializedOutputs: [memoryWire],
    selectedFiles: compactReview.files.map((entry) => entry.path),
    recommendedTests: compactReview.tests,
    rawReadGuidance: [compactReview.rawReadGuidance]
  };
}

function lifecycleWire(
  wire: unknown,
  taskId: string,
  options: { logicalRoot?: string } = {}
): { content: Array<{ type: "text"; text: string }> } {
  if (!isRecord(wire) || !Array.isArray(wire.content) || wire.content.length !== 1 || !isRecord(wire.content[0]) || typeof wire.content[0].text !== "string") {
    throw new Error("A benchmark intent must return exactly one serialized JSON TextContent item.");
  }
  const parsed = JSON.parse(wire.content[0].text) as unknown;
  if (!isRecord(parsed)) throw new Error("A benchmark intent result must serialize a JSON object.");
  const payload = { ...parsed, ...(options.logicalRoot ? { root: options.logicalRoot } : {}), taskId };
  return compactToolResultEnvelope(payload);
}

function firstReadPaths(wire: { content: Array<{ type: "text"; text: string }> }): string[] {
  const parsed = JSON.parse(wire.content[0]!.text) as unknown;
  if (!isRecord(parsed)) return [];
  const candidate = isRecord(parsed.plan) ? parsed.plan : parsed;
  if (!Array.isArray(candidate.files) || !Array.isArray(candidate.firstReads)) return [];
  const files = candidate.files.filter(isRecord);
  return [...new Set(candidate.firstReads
    .filter((index): index is number => Number.isInteger(index) && index >= 0)
    .map((index) => files[index]?.path)
    .filter((path): path is string => typeof path === "string"))].slice(0, 1);
}

function normalizePredicate(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function constraintPreserved(constraint: string, serializedOutput: string): boolean {
  const predicate = normalizePredicate(constraint);
  if (!predicate) return true;
  return ` ${normalizePredicate(serializedOutput)} `.includes(` ${predicate} `);
}

export function measureSerializedOutput(input: {
  rawTokens: number;
  serializedOutputs: unknown[];
  schemaOverheadTokens: number;
  footerOverheadTokens: number;
}) {
  const coreOutputTokens = input.serializedOutputs.map((output) => estimateTokens(JSON.stringify(output)));
  const compactTokens = coreOutputTokens.reduce((total, tokens) => total + tokens, 0);
  const toolOverheadTokens = input.schemaOverheadTokens + input.footerOverheadTokens;
  return { coreOutputTokens, compactTokens, toolOverheadTokens, netEstimatedSavings: input.rawTokens - compactTokens - toolOverheadTokens };
}

async function evaluateTask(
  task: BenchmarkTask,
  evidence: TaskEvidence,
  root: string,
  project: ProjectIndex,
  memories: MemoryEntry[],
  taskOrdinal: number,
  amortizedDiscoverySetupTokens: number
) {
  const flow = FLOW_BY_CATEGORY[task.category];
  const usesRunner = flow === "tracer" || flow === "compressor";
  const runnerFixture = usesRunner ? await executeRunnerFixture(task, root) : undefined;
  const baseline = runnerFixture
    ? { text: runnerFixture.rawOutput, tokens: estimateTokens(runnerFixture.rawOutput), files: [] as Array<{ path: string; text: string }> }
    : await rawBaseline(root, evidence.rawFiles);
  const flowInputText = runnerFixture?.summaryText ?? baseline.text;
  const result = await runFlow({ flow, task, evidence, rawText: flowInputText, root, project, memories });
  const selected = new Set(result.selectedFiles);
  const recommendedTests = [...new Set(result.recommendedTests)].sort();
  const falseNegatives = task.requiredFiles.filter((path) => !selected.has(path)).sort();
  const falsePositives = task.forbiddenFalsePositiveFiles.filter((path) => selected.has(path)).sort();
  const serializedOutput = JSON.stringify(result.coreOutput);
  const preservedCount = task.criticalConstraints.filter((constraint) => constraintPreserved(constraint, serializedOutput)).length;
  const rawReadPolicyPreserved = task.targetedRawReadsAllowed || result.rawReadGuidance.every((guidance) => guidance === NO_RAW_READ_GUIDANCE);
  const criticalConstraintPreservation = (task.criticalConstraints.length ? preservedCount / task.criticalConstraints.length : 1) * (rawReadPolicyPreserved ? 1 : 0);
  const requiredFileRecall = task.requiredFiles.length ? (task.requiredFiles.length - falseNegatives.length) / task.requiredFiles.length : 1;
  const taskId = `00000000-0000-4000-8000-${String(taskOrdinal + 1).padStart(12, "0")}`;
  const logicalRoot = "tests/fixtures/evidence-project";
  const request = (id: number, tool: string, arguments_: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: arguments_ } });
  const rawBaselineCalls = runnerFixture ? [{
    tool: "shell_command",
    request: request(taskOrdinal * 100 + 1, "shell_command", { command: runnerFixture.logicalCommand }),
    response: { content: [{ type: "text" as const, text: runnerFixture.rawOutput }] },
    requestTokens: estimateTokens(JSON.stringify(request(taskOrdinal * 100 + 1, "shell_command", { command: runnerFixture.logicalCommand }))),
    responseTokens: estimateTokens(JSON.stringify({ content: [{ type: "text" as const, text: runnerFixture.rawOutput }] }))
  }] : baseline.files.map((file, index) => {
    const rawRequest = request(taskOrdinal * 100 + index + 1, "read_file", { path: file.path });
    const response = { content: [{ type: "text" as const, text: file.text }] };
    return {
      tool: "read_file",
      request: rawRequest,
      response,
      requestTokens: estimateTokens(JSON.stringify(rawRequest)),
      responseTokens: estimateTokens(JSON.stringify(response))
    };
  });
  const rawBaselineTokens = rawBaselineCalls.reduce((total, call) => total + call.requestTokens + call.responseTokens, 0);
  const intentResponse = lifecycleWire(result.serializedOutputs[0], taskId);
  const indexedPaths = new Set(project.files.map((file) => file.path));
  const targetedReadCalls = task.allowRawReads === false || task.requiresExactSlice !== true ? [] : await Promise.all(firstReadPaths(intentResponse)
    .filter((path) => indexedPaths.has(path))
    .map(async (path, index) => {
      const indexedFile = project.files.find((file) => file.path === path)!;
      const symbol = project.symbols
        .filter((candidate) => candidate.filePath === path && Number.isInteger(candidate.startLine) && Number.isInteger(candidate.endLine))
        .sort((left, right) => left.startLine! - right.startLine! || left.endLine! - right.endLine!)[0];
      const startLine = symbol?.startLine ?? 1;
      const endLine = symbol?.endLine ?? startLine;
      const slice = await readExactSlice(root, path, startLine, endLine, 64 * 1024, indexedFile.contentHash);
      const targetedRequest = request(taskOrdinal * 100 + 50 + index, "tokengraph_query_context", {
        taskId,
        mode: "slice",
        file: path,
        startLine,
        endLine,
        contentHash: indexedFile.contentHash
      });
      const response = compactToolResultEnvelope(compactModeEnvelope("slice", compactSliceResponse(slice)));
      return {
        tool: "tokengraph_query_context",
        request: targetedRequest,
        response,
        requestTokens: estimateTokens(JSON.stringify(targetedRequest)),
        responseTokens: estimateTokens(JSON.stringify(response))
      };
    }));
  let intentTool: "tokengraph_prepare_context" | "tokengraph_analyze" | "tokengraph_compress" | "tokengraph_recall";
  let intentArguments: object;
  if (flow === "planner") {
    intentTool = "tokengraph_prepare_context";
    intentArguments = {
      task: task.query, constraints: task.constraints,
      ...(task.allowRawReads === false ? { allowRawReads: false } : {})
    };
  } else if (flow === "tracer") {
    intentTool = "tokengraph_analyze";
    intentArguments = { mode: "failure", kind: "test", text: flowInputText, task: task.query, constraints: task.constraints };
  } else if (flow === "risk") {
    intentTool = "tokengraph_analyze";
    intentArguments = { mode: "risk", changedFiles: changedFiles(evidence, project), task: task.query, constraints: task.constraints };
  } else if (flow === "compressor") {
    intentTool = "tokengraph_compress";
    intentArguments = { mode: "context", task: task.query, contentKind: task.category === "sql-security" ? "sql" : "mixed", text: flowInputText, preserveRawReferences: true, constraints: task.constraints };
  } else {
    intentTool = "tokengraph_recall";
    intentArguments = { mode: "review", query: task.query, limit: 4, constraints: task.constraints };
  }
  const intentRequest = request(taskOrdinal * 10 + 1, intentTool, intentArguments);
  const intentRequestTokens = estimateTokens(JSON.stringify(intentRequest));
  const intentResponseTokens = estimateTokens(JSON.stringify(intentResponse));
  const measuredLedger: TaskLedger = {
    schemaId: "tokengraph-task-ledger", schemaVersion: 3, taskId, host: "unknown", status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z",
    estimatorVersion: TASK_ESTIMATOR_VERSION, deliveredArtifacts: [], outcomes: [],
    events: [{
      id: `10000000-0000-4000-8000-${String(taskOrdinal + 1).padStart(12, "0")}`,
      fingerprint: `benchmark-${task.id}`, category: flow, toolName: intentTool,
      originalTokens: rawBaselineTokens, compactTokens: intentResponseTokens,
      overheadTokens: intentRequestTokens + amortizedDiscoverySetupTokens,
      confidence: "low", timestamp: "2026-01-01T00:00:00.000Z",
      qualityChecks: [{ name: "intent-executed", passed: true }]
    }]
  };
  const footer = formatTaskReportFooter(buildTaskReport(measuredLedger));
  const calls: Array<{ tool: string; request: ReturnType<typeof request>; response: { content: Array<{ type: "text"; text: string }> } }> = [];
  if (runnerFixture) calls.push({
    tool: "shell_command",
    request: request(taskOrdinal * 10, "shell_command", { command: runnerFixture.logicalCommand }),
    response: { content: [{ type: "text", text: runnerFixture.summaryText }] }
  });
  calls.push({
    tool: intentTool,
    request: intentRequest,
    response: intentResponse
  });
  const reportResponse = compactToolResultEnvelope({
    status: "completed", taskId, footer, reportingStatus: "ready"
  });
  calls.push({
    tool: "tokengraph_task_report",
    request: request(taskOrdinal * 10 + 9, "tokengraph_task_report", { taskId }),
    response: reportResponse
  });
  const lifecycleCalls = calls.map((call) => ({
    ...call,
    requestTokens: estimateTokens(JSON.stringify(call.request)),
    responseTokens: estimateTokens(JSON.stringify(call.response))
  }));
  const coreOutputTokens = lifecycleCalls.map((call) => call.responseTokens);
  const compactTokens = lifecycleCalls.reduce((total, call) => total + call.requestTokens + call.responseTokens, 0);
  const toolOverheadTokens = amortizedDiscoverySetupTokens;
  const netEstimatedSavings = rawBaselineTokens - compactTokens - toolOverheadTokens;
  const executionInclusiveNetSavings = netEstimatedSavings - targetedReadCalls.reduce((total, call) => total + call.requestTokens + call.responseTokens, 0);
  const expectedReferenceTokens = estimateTokens(evidence.expectedCompactReference);
  const expectedNetSavings = rawBaselineTokens - expectedReferenceTokens - toolOverheadTokens;
  const missingExpectedTests = task.expectedTests.filter((path) => !recommendedTests.includes(path));
  const calibrationResidual = expectedNetSavings - Math.max(0, netEstimatedSavings);
  const failureReasons = [
    ...(falseNegatives.length ? [`Required files not recalled: ${falseNegatives.join(", ")}.`] : []),
    ...(falsePositives.length ? [`Forbidden false-positive files selected: ${falsePositives.join(", ")}.`] : []),
    ...(criticalConstraintPreservation !== 1 ? ["One or more critical constraints were not preserved."] : []),
    ...(!rawReadPolicyPreserved ? ["Raw-read fallback guidance violated the task policy."] : []),
    ...(missingExpectedTests.length ? [`Expected tests not recommended: ${missingExpectedTests.join(", ")}.`] : [])
  ];
  const routing = adviseRouting({ task: task.query });
  return {
    id: task.id,
    category: task.category,
    query: task.query,
    expectedRouting: task.expectedRouting,
    targetedRawReadsAllowed: task.targetedRawReadsAllowed,
    flow,
    routing,
    routingTruth: {
      falseBypass: task.expectedRouting === "activate" && !routing.useTokenGraph,
      falseActivation: task.expectedRouting === "bypass" && routing.useTokenGraph
    },
    coreOutput: result.coreOutput,
    accounting: {
      coreOutputCount: lifecycleCalls.length,
      coreOutputTokens,
      lifecycleCalls,
      rawBaselineFiles: [...evidence.rawFiles],
      rawBaselineCalls,
      rawBaselineContentTokens: baseline.tokens,
      rawBaselineTokens,
      baseline: {
        label: runnerFixture ? "raw-run-output" : "recommended-raw-reads",
        files: runnerFixture ? [] : [...evidence.rawFiles],
        tokens: rawBaselineTokens,
        fullIndexDumpTokens: estimateTokens(JSON.stringify(stableProjectDump(project)))
      } satisfies BenchmarkBaselineArtifact,
      targetedReadsIncluded: targetedReadCalls.length > 0,
      targetedReadCalls,
      amortizedDiscoverySetupTokens,
      completionFooter: footer,
      expectedCompactReference: evidence.expectedCompactReference,
      expectedReferenceTokens,
      expectedNetSavings,
      ...(runnerFixture ? { runnerCapture: {
        executed: true,
        status: runnerFixture.summary.status,
        repeatCount: runnerFixture.summary.repeatCount,
        rawOutputTokens: estimateTokens(runnerFixture.rawOutput),
        summaryTokens: estimateTokens(runnerFixture.summaryText)
      } } : {})
    },
    metrics: {
      requiredFileRecall,
      falsePositives,
      falseNegatives,
      criticalConstraintPreservation,
      recommendedTests,
      rawTokens: rawBaselineTokens,
      compactTokens,
      toolOverheadTokens,
      netEstimatedSavings,
      executionInclusiveNetSavings,
      calibrationResidual,
      economicsResult: netEstimatedSavings > 0 ? "positive" : "non-positive",
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
  const tools = coreToolsListDefinitions();
  const discoveryRequest = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const discoveryResponse = { tools };
  const setupRequest = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tokengraph_setup", arguments: {} } };
  const setupResponse = compactToolResultEnvelope({
    status: "ready", host: "unknown", trustedWorkspace: { source: "injected", root: "tests/fixtures/evidence-project" },
    blockingReason: null, pluginRootLaunch: false, message: "TokenGraph has a safe host-provided workspace boundary.", nextSteps: [],
    surface: "core", capabilities: { taskScoped: true, coreTools: tools.map((tool) => tool.name), legacyCompatibility: false }
  });
  const discoverySetupTokens = [discoveryRequest, discoveryResponse, setupRequest, setupResponse]
    .reduce((total, item) => total + estimateTokens(JSON.stringify(item)), 0);
  const amortizedDiscoverySetupTokens = discoverySetupTokens / validation.tasks.length;
  const sessionAccounting = {
    taskCount: validation.tasks.length,
    toolDefinitionCount: tools.length,
    discovery: discoveryResponse,
    setup: { request: setupRequest, response: setupResponse },
    discoverySetupTokens,
    amortizedDiscoverySetupTokens
  };
  const tasks: Awaited<ReturnType<typeof evaluateTask>>[] = [];
  for (const [taskOrdinal, task] of validation.tasks.entries()) {
    const taskEvidence = evidence.tasks[task.id];
    if (!taskEvidence) throw new Error(`Independent benchmark evidence is missing for ${task.id}.`);
    tasks.push(await evaluateTask(task, taskEvidence, root, project, memories, taskOrdinal, amortizedDiscoverySetupTokens));
  }
  const categoryCounts = Object.fromEntries(BENCHMARK_CATEGORIES.map((category) => [category, tasks.filter((task) => task.category === category).length]));
  const activationCoverage = Object.fromEntries(BENCHMARK_CATEGORIES.map((category) => {
    const categoryTasks = tasks.filter((task) => task.category === category);
    const activated = categoryTasks.filter((task) => task.routing.useTokenGraph).length;
    return [category, { activated, bypassed: categoryTasks.length - activated, total: categoryTasks.length, rate: categoryTasks.length ? activated / categoryTasks.length : 0 }];
  }));
  const requiredTotal = validation.tasks.reduce((total, task) => total + task.requiredFiles.length, 0);
  const falseNegativeTotal = tasks.reduce((total, task) => total + task.metrics.falseNegatives.length, 0);
  const constraintTotal = validation.tasks.reduce((total, task) => total + task.criticalConstraints.length, 0);
  const preservedTotal = tasks.reduce((total, task) => total + task.metrics.criticalConstraintPreservation * validation.tasks.find((candidate) => candidate.id === task.id)!.criticalConstraints.length, 0);
  const aggregate = {
    taskCount: tasks.length,
    categoryCounts,
    activationCoverage,
    medianNetSavings: median(tasks.filter((task) => task.routing.useTokenGraph).map((task) => task.metrics.netEstimatedSavings)),
    medianExecutionInclusiveNetSavings: median(tasks.filter((task) => task.routing.useTokenGraph).map((task) => task.metrics.executionInclusiveNetSavings)),
    primarySavingsMetric: "execution-inclusive" as const,
    primaryMedianNetSavings: median(tasks.filter((task) => task.routing.useTokenGraph).map((task) => task.metrics.executionInclusiveNetSavings)),
    executionInclusiveMedian: median(tasks.filter((task) => task.routing.useTokenGraph).map((task) => task.metrics.executionInclusiveNetSavings)),
    executionInclusiveP25: quantile(tasks.filter((task) => task.routing.useTokenGraph).map((task) => task.metrics.executionInclusiveNetSavings), 0.25),
    nonNegativeActivatedRate: tasks.some((task) => task.routing.useTokenGraph)
      ? tasks.filter((task) => task.routing.useTokenGraph && task.metrics.executionInclusiveNetSavings >= 0).length / tasks.filter((task) => task.routing.useTokenGraph).length
      : 0,
    activatedTaskCount: tasks.filter((task) => task.routing.useTokenGraph).length,
    bypassedTaskCount: tasks.filter((task) => !task.routing.useTokenGraph).length,
    baselineLabel: "category-appropriate" as const,
    criticalFalseNegativeCount: falseNegativeTotal,
    criticalConstraintPreservationRate: constraintTotal ? preservedTotal / constraintTotal : 1,
    requiredFileRecall: requiredTotal ? (requiredTotal - falseNegativeTotal) / requiredTotal : 1,
    taskFailures: tasks.filter((task) => task.metrics.qualityResult === "failed").map((task) => task.id)
  };
  const releaseGate = evaluateReleaseGate({ ...aggregate, baselineRequiredFileRecall: corpus.baselineRequiredFileRecall });
  const routerShadow = summarizeRouterShadow(tasks);
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
    sessionAccounting,
    tasks,
    routerShadow,
    deltaDelivery: measureDeltaDelivery(tasks),
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

function stableProjectDump(project: ProjectIndex): unknown {
  const stableSizes = new Map(project.files.map((file) => [file.path, file.size]));
  return {
    ...project,
    root: undefined,
    scannedAt: undefined,
    repositoryIdentity: undefined,
    scanMetadata: {
      files: Object.fromEntries(Object.entries(project.scanMetadata?.files ?? {}).map(([path, file]) => [path, {
        path: file.path,
        size: stableSizes.get(path),
        contentHash: file.contentHash,
        language: file.language,
        extension: file.extension,
        route: file.route,
        isTest: file.isTest
      }]))
    }
  };
}

export function stableBenchmarkJson(report: unknown): string {
  return `${JSON.stringify(sortJson(report), null, 2)}\n`;
}

export async function loadBenchmarkCorpus(path: string): Promise<BenchmarkCorpus> {
  return JSON.parse(await readFile(path, "utf8")) as BenchmarkCorpus;
}
