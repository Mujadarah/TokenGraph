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
  falseBypass?: boolean;
  falseActivation?: boolean;
}

export interface ConfidenceInterval {
  estimate: number;
  lower: number;
  upper: number;
  samples: number;
}

export interface PairedEvaluationReport {
  taskCount: number;
  categoryCounts: Record<string, number>;
  tokenDifference: ConfidenceInterval;
  qualityDifference: ConfidenceInterval;
  executionInclusiveSavings: ConfidenceInterval;
  gates: {
    minimumSamples: boolean;
    qualityNonInferiority: boolean;
    tokenSuperiority: boolean;
    resources: boolean;
    routerRates: boolean;
    executionMedian: boolean;
    executionP25: boolean;
    nonNegativeActivated: boolean;
  };
  routerRates: { falseBypassRate: number; falseActivationRate: number };
  executionInclusive: { median: number; p25: number; nonNegativeActivatedRate: number };
  categoryIntervals: Record<string, { tokenDifference: ConfidenceInterval; qualityDifference: ConfidenceInterval; executionInclusiveSavings: ConfidenceInterval }>;
  enforcementEnabled: boolean;
  failures: string[];
}

export interface PairedEvaluationManifest {
  schemaVersion: 1;
  generatedAt: string;
  seed: string;
  tasks: EvaluationTask[];
  traces: HostTrace[];
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

export function evaluatePaired(tasks: EvaluationTask[], traces: HostTrace[], options: { minimumCategorySamples?: number; qualityMargin?: number; tokenSuperiority?: number; resourceLimit?: number; routerRateMaximum?: number; executionMedianMinimum?: number; executionP25Minimum?: number; nonNegativeActivatedMinimum?: number } = {}): PairedEvaluationReport {
  for (const trace of traces) validateTrace(trace);
  const byTask = new Map<string, HostTrace[]>();
  for (const trace of traces) byTask.set(trace.taskId, [...(byTask.get(trace.taskId) ?? []), trace]);
  const failures: string[] = [];
  const pairs: Array<{ task: EvaluationTask; on: HostTrace; off: HostTrace }> = [];
  for (const task of tasks) {
    const pair = byTask.get(task.taskId) ?? [];
    const on = pair.find((trace) => trace.condition === "on");
    const off = pair.find((trace) => trace.condition === "off");
    if (!on || !off) { failures.push(`${task.taskId}:missing-pair`); continue; }
    if (on.timedOut || off.timedOut || on.failed || off.failed) failures.push(`${task.taskId}:failure-or-timeout`);
    pairs.push({ task, on, off });
  }
  const categoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, pairs.filter((pair) => pair.task.category === category).length]));
  const minimumCategorySamples = options.minimumCategorySamples ?? 3;
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
  const executionSorted = [...executionSavingsValues].sort((a, b) => a - b);
  const executionMedian = executionSorted.length ? executionSorted[Math.floor((executionSorted.length - 1) * 0.5)]! : 0;
  const executionP25 = executionSorted.length ? executionSorted[Math.floor((executionSorted.length - 1) * 0.25)]! : 0;
  const activated = pairs.filter(({ on }) => on.falseActivation !== true);
  const nonNegativeActivatedRate = activated.length ? activated.filter(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens) >= 0).length / activated.length : 0;
  const falseBypassRate = pairs.length ? pairs.filter(({ off }) => off.falseBypass === true).length / pairs.length : 0;
  const falseActivationRate = pairs.length ? pairs.filter(({ on }) => on.falseActivation === true).length / pairs.length : 0;
  const qualityMargin = options.qualityMargin ?? 0.02;
  const qualityNonInferiority = qualityDifference.lower >= -qualityMargin;
  const tokenSuperiority = tokenDifference.upper <= -(options.tokenSuperiority ?? 1);
  const resourceLimit = options.resourceLimit;
  const resources = resourceLimit === undefined || pairs.every(({ on, off }) => (on.resourceUnits ?? 0) <= resourceLimit && (off.resourceUnits ?? 0) <= resourceLimit);
  const routerRateMaximum = options.routerRateMaximum ?? 0.1;
  const gates = {
    minimumSamples,
    qualityNonInferiority,
    tokenSuperiority,
    resources,
    routerRates: falseBypassRate < routerRateMaximum && falseActivationRate < routerRateMaximum,
    executionMedian: executionMedian > (options.executionMedianMinimum ?? 0),
    executionP25: executionP25 >= (options.executionP25Minimum ?? 0),
    nonNegativeActivated: nonNegativeActivatedRate >= (options.nonNegativeActivatedMinimum ?? 0.8)
  };
  return {
    taskCount: pairs.length,
    categoryCounts,
    tokenDifference,
    qualityDifference,
    executionInclusiveSavings,
    gates,
    routerRates: { falseBypassRate, falseActivationRate },
    executionInclusive: { median: executionMedian, p25: executionP25, nonNegativeActivatedRate },
    categoryIntervals,
    enforcementEnabled: Object.values(gates).every(Boolean) && failures.length === 0,
    failures
  };
}

export function parseEvaluationManifest(value: unknown): PairedEvaluationManifest {
  if (!value || typeof value !== "object") throw new Error("Evaluation manifest must be an object.");
  const candidate = value as Partial<PairedEvaluationManifest>;
  if (candidate.schemaVersion !== 1 || typeof candidate.generatedAt !== "string" || typeof candidate.seed !== "string" || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.traces)) throw new Error("Evaluation manifest schema is invalid.");
  const tasks = candidate.tasks.filter((task): task is EvaluationTask => Boolean(task && typeof task.taskId === "string" && typeof task.category === "string"));
  const traces = candidate.traces.filter((trace): trace is HostTrace => Boolean(trace && typeof trace.taskId === "string" && typeof trace.category === "string"));
  if (tasks.length !== candidate.tasks.length || traces.length !== candidate.traces.length) throw new Error("Evaluation manifest contains malformed tasks or traces.");
  return { schemaVersion: 1, generatedAt: candidate.generatedAt, seed: candidate.seed, tasks, traces };
}

export async function loadEvaluationManifest(path: string): Promise<PairedEvaluationManifest> {
  return parseEvaluationManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function persistPromotionReport(root: string, report: PairedEvaluationReport): Promise<RoutingPromotionReport> {
  const promotion: RoutingPromotionReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    enforcementEnabled: report.enforcementEnabled,
    gates: report.gates,
    falseBypassRate: report.routerRates.falseBypassRate,
    falseActivationRate: report.routerRates.falseActivationRate,
    executionInclusiveMedian: report.executionInclusive.median,
    executionInclusiveP25: report.executionInclusive.p25,
    nonNegativeActivatedRate: report.executionInclusive.nonNegativeActivatedRate,
    categoryCounts: report.categoryCounts
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
