import { createHash } from "node:crypto";

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
  gates: { minimumSamples: boolean; qualityNonInferiority: boolean; tokenSuperiority: boolean; resources: boolean };
  enforcementEnabled: boolean;
  failures: string[];
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
  if (!trace.taskId || !trace.category || !["on", "off"].includes(trace.condition) || !Number.isFinite(trace.tokens) || trace.tokens < 0 || !Number.isFinite(trace.quality)) throw new Error("Invalid host evaluation trace.");
}

export function evaluatePaired(tasks: EvaluationTask[], traces: HostTrace[], options: { minimumCategorySamples?: number; qualityMargin?: number; tokenSuperiority?: number; resourceLimit?: number } = {}): PairedEvaluationReport {
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
  const qualityMargin = options.qualityMargin ?? 0.02;
  const qualityNonInferiority = qualityDifference.lower >= -qualityMargin;
  const tokenSuperiority = tokenDifference.upper <= -(options.tokenSuperiority ?? 1);
  const resourceLimit = options.resourceLimit;
  const resources = resourceLimit === undefined || pairs.every(({ on }) => (on.resourceUnits ?? 0) <= resourceLimit);
  const gates = { minimumSamples, qualityNonInferiority, tokenSuperiority, resources };
  return { taskCount: pairs.length, categoryCounts, tokenDifference, qualityDifference, gates, enforcementEnabled: Object.values(gates).every(Boolean) && failures.length === 0, failures };
}
