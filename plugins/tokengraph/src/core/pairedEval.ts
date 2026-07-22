import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadRoutingControl, saveRoutingControl } from "./routingControl.js";
import type { RoutingPromotionReport } from "./types.js";

export interface EvaluationTask {
  taskId: string;
  category: string;
  expectedQuality?: number;
}

export interface HostTrace {
  taskId: string;
  category: string;
  condition: "on" | "off";
  tokens: number;
  quality: number;
  timedOut: boolean;
  failed: boolean;
  resourceUnits?: number;
  executionInclusiveTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  toolCalls?: number;
  fallbackRawReads?: number;
  repeat?: number;
  conditionOrder?: "on-first" | "off-first";
  usageSource?: "host";
  acceptance?: { status: "passed" | "failed"; commandHash: string };
  routing?: RouterShadowObservation;
}

export interface RouterShadowObservation {
  mode: "shadow";
  decision: "activate" | "bypass";
  stage: 0 | 1;
  reason: string;
  expectedOverheadTokens: number;
  expectedBenefit?: "none" | "low" | "medium" | "high";
  expectedRouting?: "activate" | "bypass";
  routingLatencyMs?: number;
  activationLatencyMs?: number;
  falseBypass: boolean;
  falseActivation: boolean;
}

export interface ConfidenceInterval {
  estimate: number;
  lower: number;
  upper: number;
  samples: number;
}

export interface PairedEvaluationReport {
  schemaVersion: 1 | 2 | 3;
  evidenceSource: "fixture" | "real-host";
  reviewed: boolean;
  promotionEligible: boolean;
  taskCount: number;
  categoryCounts: Record<string, number>;
  tokenDifference: ConfidenceInterval;
  qualityDifference: ConfidenceInterval;
  executionInclusiveSavings: ConfidenceInterval;
  gates: {
    minimumSamples: boolean;
    realHostEvidence: boolean;
    qualityNonInferiority: boolean;
    tokenSuperiority: boolean;
    resources: boolean;
    routerRates: boolean;
    routerLatency: boolean;
    executionMedian: boolean;
    executionP25: boolean;
    nonNegativeActivated: boolean;
  };
  routerRates: {
    falseBypassRate: number | null;
    falseActivationRate: number | null;
    beneficialCount: number;
    boundedCount: number;
    observationCount: number;
    categoryCounts: Record<string, number>;
    stage0LatencyMs: number | null;
    activationLatencyMs: number | null;
    stage0LatencyMaximumMs: number | null;
    stage0WithinBudget: boolean;
    stage0LatencySamples: number;
    activationLatencySamples: number;
    stage0FasterThanActivation: boolean;
  };
  executionInclusive: { median: number; p25: number; nonNegativeActivatedRate: number };
  categoryIntervals: Record<string, { tokenDifference: ConfidenceInterval; qualityDifference: ConfidenceInterval; executionInclusiveSavings: ConfidenceInterval }>;
  enforcementEnabled: boolean;
  failures: string[];
}

export interface PairedEvaluationManifest {
  schemaVersion: 1 | 2 | 3;
  evidenceSource: "fixture" | "real-host";
  reviewed: boolean;
  promptTemplateHash?: string;
  generatedAt: string;
  seed: string;
  model: { identifier: string; versionOrDate: string };
  reasoningLevel: string;
  host: { name: string; version: string };
  plugin: { version: string; commit: string };
  repositoryCommit: string;
  promptTemplate: string;
  toolConfiguration: Record<string, unknown>;
  cacheState: string;
  indexState: "cold" | "warm";
  protocol: PairedEvaluationProtocol;
  tasks: EvaluationTask[];
  traces: HostTrace[];
}

export interface PairedEvaluationProtocol {
  runsPerTask: number;
  minimumPerCategorySamples: number;
  qualityNonInferiorityMargin: number;
  tokenSuperiorityMinimum: number;
  resourceLimit: number;
  routerRateMaximum: number;
  stage0LatencyMaximumMs?: number;
  executionMedianMinimum: number;
  executionP25Minimum: number;
  nonNegativeActivatedMinimum: number;
}

function hashNumber(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 12), 16);
}

export function counterbalancedConditions(tasks: EvaluationTask[], seed = "tokengraph-v4"): Map<string, "on" | "off"> {
  return new Map([...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((task) => [task.taskId, (hashNumber(`${seed}:${task.taskId}`) % 2 === 0 ? "on" : "off")]));
}

function quantile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function random(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function pairedBootstrap(values: number[], iterations = 2000, seed = 17): ConfidenceInterval {
  const estimate = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  if (!values.length) return { estimate: 0, lower: 0, upper: 0, samples: 0 };
  const next = random(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(next() * values.length)]!;
    means.push(total / values.length);
  }
  return { estimate, lower: quantile(means, 0.025), upper: quantile(means, 0.975), samples: values.length };
}

function validateTrace(trace: HostTrace): void {
  if (!trace.taskId || !trace.category || !["on", "off"].includes(trace.condition) || !Number.isFinite(trace.tokens) || trace.tokens < 0 || !Number.isFinite(trace.quality) || (trace.executionInclusiveTokens !== undefined && (!Number.isFinite(trace.executionInclusiveTokens) || trace.executionInclusiveTokens < 0))) throw new Error("Invalid host evaluation trace.");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validShadowObservation(value: unknown): value is RouterShadowObservation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RouterShadowObservation>;
  return candidate.mode === "shadow" &&
    (candidate.decision === "activate" || candidate.decision === "bypass") &&
    (candidate.stage === 0 || candidate.stage === 1) &&
    typeof candidate.reason === "string" && candidate.reason.length > 0 &&
    typeof candidate.expectedOverheadTokens === "number" && Number.isFinite(candidate.expectedOverheadTokens) && candidate.expectedOverheadTokens >= 0 &&
    typeof candidate.falseBypass === "boolean" && typeof candidate.falseActivation === "boolean";
}

function validateRealHostTrace(trace: HostTrace): void {
  validateTrace(trace);
  if (!Number.isInteger(trace.repeat) || trace.repeat! < 1 ||
    (trace.conditionOrder !== "on-first" && trace.conditionOrder !== "off-first") ||
    trace.usageSource !== "host" || !trace.acceptance ||
    (trace.acceptance.status !== "passed" && trace.acceptance.status !== "failed") ||
    !isSha256(trace.acceptance.commandHash)) {
    throw new Error("Real-host trace provenance is invalid.");
  }
  if (![trace.inputTokens, trace.cachedInputTokens, trace.outputTokens, trace.reasoningOutputTokens, trace.toolCalls, trace.fallbackRawReads]
    .every((value) => Number.isSafeInteger(value) && value! >= 0) ||
    trace.cachedInputTokens! > trace.inputTokens! || trace.tokens !== trace.inputTokens! + trace.outputTokens!) {
    throw new Error("Real-host trace requires exact host token and tool counters.");
  }
  if (trace.condition === "off") return;
  if (!validShadowObservation(trace.routing)) throw new Error("Real-host routing observation is invalid.");
  const routing = trace.routing;
  if (!["none", "low", "medium", "high"].includes(routing.expectedBenefit ?? "") ||
    (routing.expectedRouting !== "activate" && routing.expectedRouting !== "bypass") ||
    typeof routing.routingLatencyMs !== "number" || !Number.isFinite(routing.routingLatencyMs) || routing.routingLatencyMs < 0) {
    throw new Error("Real-host routing truth or latency is invalid.");
  }
  if ((routing.expectedRouting === "bypass") !== (routing.expectedBenefit === "none")) {
    throw new Error("Real-host routing benefit does not match its reviewed truth.");
  }
  const falseBypass = routing.expectedRouting === "activate" && routing.decision === "bypass";
  const falseActivation = routing.expectedRouting === "bypass" && routing.decision === "activate";
  if (routing.falseBypass !== falseBypass || routing.falseActivation !== falseActivation) {
    throw new Error("Real-host routing outcome does not match its reviewed truth.");
  }
  if (routing.decision === "activate" &&
    (typeof routing.activationLatencyMs !== "number" || !Number.isFinite(routing.activationLatencyMs) || routing.activationLatencyMs <= routing.routingLatencyMs)) {
    throw new Error("Real-host activation latency must be greater than routing latency.");
  }
  if (routing.decision === "bypass" && routing.activationLatencyMs !== undefined) {
    throw new Error("Bypass traces cannot claim activation latency.");
  }
}

function validProtocol(value: unknown, schemaVersion: 1 | 2 | 3): value is PairedEvaluationProtocol {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PairedEvaluationProtocol>;
  return Number.isInteger(candidate.runsPerTask) && candidate.runsPerTask! >= 1 &&
    Number.isInteger(candidate.minimumPerCategorySamples) && candidate.minimumPerCategorySamples! >= 10 &&
    typeof candidate.qualityNonInferiorityMargin === "number" && Number.isFinite(candidate.qualityNonInferiorityMargin) && candidate.qualityNonInferiorityMargin >= 0 &&
    typeof candidate.tokenSuperiorityMinimum === "number" && Number.isFinite(candidate.tokenSuperiorityMinimum) && candidate.tokenSuperiorityMinimum >= 0 &&
    typeof candidate.resourceLimit === "number" && Number.isFinite(candidate.resourceLimit) && candidate.resourceLimit >= 0 &&
    typeof candidate.routerRateMaximum === "number" && Number.isFinite(candidate.routerRateMaximum) && candidate.routerRateMaximum > 0 && candidate.routerRateMaximum <= 0.1 &&
    (schemaVersion !== 3 || candidate.stage0LatencyMaximumMs === 5) &&
    typeof candidate.executionMedianMinimum === "number" && Number.isFinite(candidate.executionMedianMinimum) && candidate.executionMedianMinimum >= 0 &&
    typeof candidate.executionP25Minimum === "number" && Number.isFinite(candidate.executionP25Minimum) && candidate.executionP25Minimum >= 0 &&
    typeof candidate.nonNegativeActivatedMinimum === "number" && Number.isFinite(candidate.nonNegativeActivatedMinimum) && candidate.nonNegativeActivatedMinimum >= 0.8 && candidate.nonNegativeActivatedMinimum <= 1;
}

interface PairedEvaluationOptions {
  minimumCategorySamples?: number;
  qualityMargin?: number;
  tokenSuperiority?: number;
  resourceLimit?: number;
  routerRateMaximum?: number;
  executionMedianMinimum?: number;
  executionP25Minimum?: number;
  nonNegativeActivatedMinimum?: number;
  schemaVersion?: 1 | 2 | 3;
  evidenceSource?: "fixture" | "real-host";
  reviewed?: boolean;
  runsPerTask?: number;
  stage0LatencyMaximumMs?: number;
}

export function evaluatePaired(tasks: EvaluationTask[], traces: HostTrace[], options: PairedEvaluationOptions = {}): PairedEvaluationReport {
  for (const trace of traces) validateTrace(trace);
  const schemaVersion = options.schemaVersion ?? 1;
  const evidenceSource = options.evidenceSource ?? "fixture";
  const reviewed = options.reviewed === true;
  const promotionEligible = schemaVersion === 3 && evidenceSource === "real-host" && reviewed;
  const runsPerTask = options.runsPerTask ?? 1;
  const byTaskAndRepeat = new Map<string, HostTrace[]>();
  for (const trace of traces) {
    const key = `${trace.taskId}:${trace.repeat ?? 1}`;
    byTaskAndRepeat.set(key, [...(byTaskAndRepeat.get(key) ?? []), trace]);
  }
  const failures: string[] = [];
  const pairs: Array<{ task: EvaluationTask; on: HostTrace; off: HostTrace }> = [];
  for (const task of tasks) {
    for (let repeat = 1; repeat <= runsPerTask; repeat += 1) {
      const pair = byTaskAndRepeat.get(`${task.taskId}:${repeat}`) ?? [];
      const onTraces = pair.filter((trace) => trace.condition === "on");
      const offTraces = pair.filter((trace) => trace.condition === "off");
      const on = onTraces[0];
      const off = offTraces[0];
      if (!on || !off) { failures.push(`${task.taskId}:repeat-${repeat}:missing-pair`); continue; }
      if (onTraces.length !== 1 || offTraces.length !== 1) failures.push(`${task.taskId}:repeat-${repeat}:duplicate-condition`);
      if (on.category !== task.category || off.category !== task.category) failures.push(`${task.taskId}:repeat-${repeat}:category-mismatch`);
      if (schemaVersion >= 2 && (on.conditionOrder !== off.conditionOrder || on.acceptance?.commandHash !== off.acceptance?.commandHash)) failures.push(`${task.taskId}:repeat-${repeat}:provenance-mismatch`);
      if (on.timedOut || off.timedOut || on.failed || off.failed || on.acceptance?.status === "failed" || off.acceptance?.status === "failed") failures.push(`${task.taskId}:failure-or-timeout`);
      pairs.push({ task, on, off });
    }
  }
  const categoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, pairs.filter((pair) => pair.task.category === category).length]));
  const minimumCategorySamples = options.minimumCategorySamples ?? 10;
  const minimumSamples = Object.values(categoryCounts).every((count) => count >= minimumCategorySamples);
  const tokenDifference = pairedBootstrap(pairs.map(({ on, off }) => on.tokens - off.tokens), 2000, 11);
  const qualityDifference = pairedBootstrap(pairs.map(({ on, off }) => on.quality - off.quality), 2000, 13);
  const executionSavingsValues = pairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens));
  const executionInclusiveSavings = pairedBootstrap(executionSavingsValues, 2000, 19);
  const categoryIntervals = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category, index) => {
    const categoryPairs = pairs.filter((pair) => pair.task.category === category);
    return [category, {
      tokenDifference: pairedBootstrap(categoryPairs.map(({ on, off }) => on.tokens - off.tokens), 2000, 101 + index),
      qualityDifference: pairedBootstrap(categoryPairs.map(({ on, off }) => on.quality - off.quality), 2000, 201 + index),
      executionInclusiveSavings: pairedBootstrap(categoryPairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens)), 2000, 301 + index)
    }];
  }));
  const activatedPairs = pairs.filter(({ on }) => validShadowObservation(on.routing) && on.routing.decision === "activate");
  const activatedExecutionSavings = activatedPairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens));
  const executionSorted = [...activatedExecutionSavings].sort((a, b) => a - b);
  const executionMedian = median(executionSorted);
  const executionP25 = executionSorted.length ? executionSorted[Math.floor((executionSorted.length - 1) * 0.25)]! : 0;
  const nonNegativeActivatedRate = activatedExecutionSavings.length ? activatedExecutionSavings.filter((value) => value >= 0).length / activatedExecutionSavings.length : 0;
  const routerObservations = pairs.flatMap(({ on }) => validShadowObservation(on.routing) && on.routing.expectedRouting ? [on.routing] : []);
  const routerObservationCategories = pairs.flatMap(({ task, on }) => validShadowObservation(on.routing) && on.routing.expectedRouting ? [task.category] : []);
  const routerCategoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, routerObservationCategories.filter((candidate) => candidate === category).length]));
  const beneficialObservations = routerObservations.filter((observation) => observation.expectedRouting === "activate");
  const boundedObservations = routerObservations.filter((observation) => observation.expectedRouting === "bypass");
  const falseBypassRate = beneficialObservations.length ? beneficialObservations.filter((observation) => observation.falseBypass).length / beneficialObservations.length : null;
  const falseActivationRate = boundedObservations.length ? boundedObservations.filter((observation) => observation.falseActivation).length / boundedObservations.length : null;
  const stage0Latencies = routerObservations.flatMap((observation) => typeof observation.routingLatencyMs === "number" ? [observation.routingLatencyMs] : []);
  const activationLatencies = routerObservations.flatMap((observation) => typeof observation.activationLatencyMs === "number" ? [observation.activationLatencyMs] : []);
  const stage0LatencyMs = stage0Latencies.length ? median(stage0Latencies) : null;
  const activationLatencyMs = activationLatencies.length ? median(activationLatencies) : null;
  const stage0FasterThanActivation = stage0LatencyMs !== null && activationLatencyMs !== null && stage0LatencyMs < activationLatencyMs;
  const stage0LatencyMaximumMs = schemaVersion === 3 ? options.stage0LatencyMaximumMs ?? null : null;
  const stage0WithinBudget = stage0LatencyMs !== null && stage0LatencyMaximumMs !== null && stage0LatencyMs <= stage0LatencyMaximumMs;
  const qualityMargin = options.qualityMargin ?? 0.02;
  const qualityNonInferiority = qualityDifference.lower >= -qualityMargin;
  const tokenSuperiority = tokenDifference.upper <= -(options.tokenSuperiority ?? 1);
  const resourceLimit = options.resourceLimit;
  const resources = resourceLimit === undefined || pairs.every(({ on, off }) => (on.resourceUnits ?? 0) <= resourceLimit && (off.resourceUnits ?? 0) <= resourceLimit);
  const routerRateMaximum = options.routerRateMaximum ?? 0.1;
  if (promotionEligible && Object.values(routerCategoryCounts).some((count) => count < 10)) failures.push("router-shadow-sample-incomplete");
  const gates = {
    minimumSamples,
    realHostEvidence: promotionEligible,
    qualityNonInferiority,
    tokenSuperiority,
    resources,
    routerRates: beneficialObservations.length > 0 && boundedObservations.length > 0 && Object.values(routerCategoryCounts).every((count) => count >= 10) && falseBypassRate !== null && falseBypassRate < routerRateMaximum && falseActivationRate !== null && falseActivationRate < routerRateMaximum,
    routerLatency: stage0FasterThanActivation && stage0WithinBudget,
    executionMedian: executionMedian > (options.executionMedianMinimum ?? 0),
    executionP25: executionP25 >= (options.executionP25Minimum ?? 0),
    nonNegativeActivated: nonNegativeActivatedRate >= (options.nonNegativeActivatedMinimum ?? 0.8)
  };
  return {
    schemaVersion,
    evidenceSource,
    reviewed,
    promotionEligible,
    taskCount: pairs.length,
    categoryCounts,
    tokenDifference,
    qualityDifference,
    executionInclusiveSavings,
    gates,
    routerRates: {
      falseBypassRate,
      falseActivationRate,
      beneficialCount: beneficialObservations.length,
      boundedCount: boundedObservations.length,
      observationCount: routerObservations.length,
      categoryCounts: routerCategoryCounts,
      stage0LatencyMs,
      activationLatencyMs,
      stage0LatencyMaximumMs,
      stage0WithinBudget,
      stage0LatencySamples: stage0Latencies.length,
      activationLatencySamples: activationLatencies.length,
      stage0FasterThanActivation
    },
    executionInclusive: { median: executionMedian, p25: executionP25, nonNegativeActivatedRate },
    categoryIntervals,
    enforcementEnabled: Object.values(gates).every(Boolean) && failures.length === 0,
    failures
  };
}

export function evaluateManifest(manifest: PairedEvaluationManifest): PairedEvaluationReport {
  const protocol = manifest.protocol;
  return evaluatePaired(manifest.tasks, manifest.traces, {
    schemaVersion: manifest.schemaVersion,
    evidenceSource: manifest.evidenceSource,
    reviewed: manifest.reviewed,
    runsPerTask: protocol.runsPerTask,
    minimumCategorySamples: protocol.minimumPerCategorySamples,
    qualityMargin: protocol.qualityNonInferiorityMargin,
    tokenSuperiority: protocol.tokenSuperiorityMinimum,
    resourceLimit: protocol.resourceLimit,
    routerRateMaximum: protocol.routerRateMaximum,
    stage0LatencyMaximumMs: protocol.stage0LatencyMaximumMs,
    executionMedianMinimum: protocol.executionMedianMinimum,
    executionP25Minimum: protocol.executionP25Minimum,
    nonNegativeActivatedMinimum: protocol.nonNegativeActivatedMinimum
  });
}

export function parseEvaluationManifest(value: unknown): PairedEvaluationManifest {
  if (!value || typeof value !== "object") throw new Error("Evaluation manifest must be an object.");
  const candidate = value as Partial<PairedEvaluationManifest>;
  const model = candidate.model && typeof candidate.model === "object" ? candidate.model : undefined;
  const host = candidate.host && typeof candidate.host === "object" ? candidate.host : undefined;
  const plugin = candidate.plugin && typeof candidate.plugin === "object" ? candidate.plugin : undefined;
  if (
    (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2 && candidate.schemaVersion !== 3) || typeof candidate.generatedAt !== "string" || typeof candidate.seed !== "string" ||
    !model || typeof model.identifier !== "string" || !model.identifier || typeof model.versionOrDate !== "string" || !model.versionOrDate ||
    typeof candidate.reasoningLevel !== "string" || !candidate.reasoningLevel ||
    !host || typeof host.name !== "string" || !host.name || typeof host.version !== "string" || !host.version ||
    !plugin || typeof plugin.version !== "string" || !plugin.version || typeof plugin.commit !== "string" || !plugin.commit ||
    typeof candidate.repositoryCommit !== "string" || !candidate.repositoryCommit ||
    typeof candidate.promptTemplate !== "string" || !candidate.promptTemplate ||
    !candidate.toolConfiguration || typeof candidate.toolConfiguration !== "object" || Array.isArray(candidate.toolConfiguration) ||
    typeof candidate.cacheState !== "string" || !candidate.cacheState ||
    (candidate.indexState !== "cold" && candidate.indexState !== "warm") ||
    !validProtocol(candidate.protocol, candidate.schemaVersion) ||
    !Array.isArray(candidate.tasks) || !Array.isArray(candidate.traces)
  ) throw new Error("Evaluation manifest schema is invalid.");
  const tasks = candidate.tasks.filter((task): task is EvaluationTask => Boolean(task && typeof task.taskId === "string" && typeof task.category === "string"));
  const traces = candidate.traces.filter((trace): trace is HostTrace => Boolean(trace && typeof trace.taskId === "string" && typeof trace.category === "string"));
  if (tasks.length !== candidate.tasks.length || traces.length !== candidate.traces.length) throw new Error("Evaluation manifest contains malformed tasks or traces.");
  if (candidate.schemaVersion >= 2) {
    if ((candidate.evidenceSource !== "fixture" && candidate.evidenceSource !== "real-host") || typeof candidate.reviewed !== "boolean" || !isSha256(candidate.promptTemplateHash)) {
      throw new Error("Evaluation manifest schema-v2 provenance is invalid.");
    }
    for (const trace of traces) validateRealHostTrace(trace);
  } else {
    for (const trace of traces) validateTrace(trace);
  }
  return {
    schemaVersion: candidate.schemaVersion,
    evidenceSource: candidate.schemaVersion >= 2 ? candidate.evidenceSource! : "fixture",
    reviewed: candidate.schemaVersion >= 2 ? candidate.reviewed! : false,
    ...(candidate.schemaVersion >= 2 ? { promptTemplateHash: candidate.promptTemplateHash! } : {}),
    generatedAt: candidate.generatedAt,
    seed: candidate.seed,
    model: { identifier: model.identifier, versionOrDate: model.versionOrDate },
    reasoningLevel: candidate.reasoningLevel,
    host: { name: host.name, version: host.version },
    plugin: { version: plugin.version, commit: plugin.commit },
    repositoryCommit: candidate.repositoryCommit,
    promptTemplate: candidate.promptTemplate,
    toolConfiguration: candidate.toolConfiguration as Record<string, unknown>,
    cacheState: candidate.cacheState,
    indexState: candidate.indexState,
    protocol: candidate.protocol,
    tasks,
    traces
  };
}

export async function loadEvaluationManifest(path: string): Promise<PairedEvaluationManifest> {
  return parseEvaluationManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function persistPromotionReport(root: string, report: PairedEvaluationReport): Promise<RoutingPromotionReport> {
  const promotion: RoutingPromotionReport = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    enforcementEnabled: report.enforcementEnabled,
    ...(report.promotionEligible ? { evidenceSource: "real-host" as const, reviewed: true as const } : {}),
    gates: report.gates,
    ...(report.routerRates.falseBypassRate !== null ? { falseBypassRate: report.routerRates.falseBypassRate } : {}),
    ...(report.routerRates.falseActivationRate !== null ? { falseActivationRate: report.routerRates.falseActivationRate } : {}),
    beneficialCount: report.routerRates.beneficialCount,
    boundedCount: report.routerRates.boundedCount,
    ...(report.routerRates.stage0LatencyMs !== null ? { stage0LatencyMs: report.routerRates.stage0LatencyMs } : {}),
    ...(report.routerRates.activationLatencyMs !== null ? { activationLatencyMs: report.routerRates.activationLatencyMs } : {}),
    ...(report.routerRates.stage0LatencyMaximumMs !== null ? { stage0LatencyMaximumMs: report.routerRates.stage0LatencyMaximumMs } : {}),
    stage0WithinBudget: report.routerRates.stage0WithinBudget,
    stage0LatencySamples: report.routerRates.stage0LatencySamples,
    activationLatencySamples: report.routerRates.activationLatencySamples,
    stage0FasterThanActivation: report.routerRates.stage0FasterThanActivation,
    executionInclusiveMedian: report.executionInclusive.median,
    executionInclusiveP25: report.executionInclusive.p25,
    nonNegativeActivatedRate: report.executionInclusive.nonNegativeActivatedRate,
    categoryCounts: report.routerRates.categoryCounts
  };
  const current = await loadRoutingControl(root);
  if (report.enforcementEnabled) {
    await saveRoutingControl(root, { ...current, promotion });
  } else {
    // A failed evaluation is evidence, not promotion state. Remove any stale
    // promotion so a prior passing report cannot keep enforcement enabled.
    await saveRoutingControl(root, { schemaVersion: current.schemaVersion, killSwitch: current.killSwitch });
  }
  return promotion;
}
