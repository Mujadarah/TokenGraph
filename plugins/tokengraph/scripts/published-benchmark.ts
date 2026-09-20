import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { evaluateManifest, parseEvaluationManifest, type PairedEvaluationManifest, type PairedEvaluationReport } from "../src/core/pairedEval.js";
import { DEFAULT_TOKEN_GRAPH_CONFIG } from "../src/core/config.js";
import { evaluateBenchmark, loadBenchmarkCorpus, stableBenchmarkJson } from "./benchmark-lib.js";

interface HostEvidenceDescriptor {
  repository: string;
  category: string;
  manifestPath: string;
  reportPath: string;
}

interface LoadedHostEvidence extends HostEvidenceDescriptor {
  manifest: PairedEvaluationManifest;
  report: PairedEvaluationReport;
}

const HOST_EVIDENCE: HostEvidenceDescriptor[] = [
  {
    repository: "Mujadarah/TokenGraph",
    category: "code",
    manifestPath: "docs/benchmarks/host-evaluations/2026-07-22-tokengraph-codex-manifest.json",
    reportPath: "docs/benchmarks/host-evaluations/2026-07-22-tokengraph-codex-report.json"
  },
  {
    repository: "mattpocock/ts-reset",
    category: "type-system",
    manifestPath: "docs/benchmarks/host-evaluations/2026-07-22-ts-reset-codex-manifest.json",
    reportPath: "docs/benchmarks/host-evaluations/2026-07-22-ts-reset-codex-report.json"
  },
  {
    repository: "imbhargav5/nextbase-nextjs-supabase-starter",
    category: "frontend",
    manifestPath: "docs/benchmarks/host-evaluations/2026-07-22-nextbase-codex-manifest.json",
    reportPath: "docs/benchmarks/host-evaluations/2026-07-22-nextbase-codex-report.json"
  }
];

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function retainedFailureCount(manifest: PairedEvaluationManifest): number {
  return manifest.traces.filter((trace) => trace.failed || trace.timedOut || trace.acceptance?.status === "failed").length;
}

async function loadHostEvidence(repositoryRoot: string, descriptor: HostEvidenceDescriptor): Promise<LoadedHostEvidence> {
  const manifest = parseEvaluationManifest(JSON.parse(await readFile(join(repositoryRoot, descriptor.manifestPath), "utf8")));
  if (manifest.schemaVersion !== 3 || manifest.evidenceSource !== "real-host" || !manifest.reviewed) {
    throw new Error(`Host evidence is not reviewed schema-v3 real-host evidence: ${descriptor.manifestPath}`);
  }
  const checkedReport = JSON.parse(await readFile(join(repositoryRoot, descriptor.reportPath), "utf8")) as unknown;
  const report = evaluateManifest(manifest);
  if (stableBenchmarkJson(report) !== stableBenchmarkJson(checkedReport)) {
    throw new Error(`Checked host report does not reproduce from its manifest: ${descriptor.reportPath}`);
  }
  return { ...descriptor, manifest, report };
}

function realHostEvaluation(evidence: LoadedHostEvidence) {
  const { manifest, report } = evidence;
  const traces = manifest.traces;
  return {
    manifestPath: evidence.manifestPath,
    reportPath: evidence.reportPath,
    schemaVersion: manifest.schemaVersion,
    evidenceSource: manifest.evidenceSource,
    reviewed: manifest.reviewed,
    scope: {
      repositoryCount: 1,
      categoryCount: new Set(manifest.tasks.map((task) => task.category)).size,
      taskCount: manifest.tasks.length,
      pairCount: report.tokenDifference.samples,
      traceCount: traces.length,
      retainedFailureCount: retainedFailureCount(manifest)
    },
    model: manifest.model,
    host: manifest.host,
    plugin: manifest.plugin,
    repositoryCommit: manifest.repositoryCommit,
    hostUsage: {
      inputTokens: sum(traces.map((trace) => trace.inputTokens ?? 0)),
      cachedInputTokens: sum(traces.map((trace) => trace.cachedInputTokens ?? 0)),
      outputTokens: sum(traces.map((trace) => trace.outputTokens ?? 0)),
      reasoningOutputTokens: sum(traces.map((trace) => trace.reasoningOutputTokens ?? 0)),
      onTokens: sum(traces.filter((trace) => trace.condition === "on").map((trace) => trace.tokens)),
      offTokens: sum(traces.filter((trace) => trace.condition === "off").map((trace) => trace.tokens))
    },
    routerRates: {
      falseBypassRate: report.routerRates.falseBypassRate,
      falseActivationRate: report.routerRates.falseActivationRate,
      beneficialCount: report.routerRates.beneficialCount,
      boundedCount: report.routerRates.boundedCount,
      stage0LatencyMs: report.routerRates.stage0LatencyMs,
      activationLatencyMs: report.routerRates.activationLatencyMs,
      stage0LatencyMaximumMs: report.routerRates.stage0LatencyMaximumMs,
      stage0WithinBudget: report.routerRates.stage0WithinBudget
    },
    pairedIntervals: {
      tokenDifference: report.tokenDifference,
      qualityDifference: report.qualityDifference,
      executionInclusiveSavings: report.executionInclusiveSavings
    },
    promotion: {
      enforcementEnabled: report.enforcementEnabled,
      gates: report.gates,
      executionInclusiveMedian: report.executionInclusive.median,
      executionInclusiveP25: report.executionInclusive.p25,
      nonNegativeActivatedRate: report.executionInclusive.nonNegativeActivatedRate,
      failureReasons: report.failures
    }
  };
}

function multiRepositoryCoverage(evidence: LoadedHostEvidence[]) {
  const evaluations = evidence.map(({ repository, category, manifestPath, reportPath, manifest, report }) => ({
    repository,
    category,
    manifestPath,
    reportPath,
    pairCount: report.tokenDifference.samples,
    traceCount: manifest.traces.length,
    acceptancePassed: manifest.traces.filter((trace) => trace.acceptance?.status === "passed").length,
    acceptanceFailed: manifest.traces.filter((trace) => trace.acceptance?.status === "failed").length,
    enforcementEnabled: report.enforcementEnabled
  }));
  const completed = evaluations.filter((evaluation) => evaluation.traceCount === evaluation.pairCount * 2 && evaluation.acceptanceFailed === 0);
  const targetRepositoryCount = HOST_EVIDENCE.length;
  const coverageComplete = completed.length === targetRepositoryCount;
  const promotionComplete = coverageComplete && completed.every((evaluation) => evaluation.enforcementEnabled);
  return {
    targetRepositoryCount,
    completedRepositoryCount: completed.length,
    completedCategoryCount: new Set(completed.map((evaluation) => evaluation.category)).size,
    completedPairCount: sum(completed.map((evaluation) => evaluation.pairCount)),
    completedTraceCount: sum(completed.map((evaluation) => evaluation.traceCount)),
    coverageComplete,
    promotionComplete,
    evaluations,
    finalDecision: {
      routingMode: "shadow",
      b7PolyglotIndexing: DEFAULT_TOKEN_GRAPH_CONFIG.parser.polyglotEnabled ? "active-by-default" : "dark",
      reason: coverageComplete
        ? "The three-repository coverage target is met, but the frozen promotion gates do not all pass."
        : "The three-repository coverage target is incomplete."
    },
    remaining: coverageComplete
      ? "No repository coverage gap; frozen promotion gates still fail."
      : `${targetRepositoryCount - completed.length} repository evaluation(s) remain.`
  };
}

export async function generatePublishedBenchmarkResults(repositoryRoot: string) {
  const pluginRoot = join(repositoryRoot, "plugins", "tokengraph");
  const corpus = await loadBenchmarkCorpus(join(pluginRoot, "scripts", "benchmark-corpus-v1.json"));
  const report = await evaluateBenchmark(corpus, join(pluginRoot, "tests", "fixtures", "evidence-project"));
  if (!report.releaseGate.passed) {
    throw new Error(`Refusing to publish benchmark evidence because the release gate failed: ${report.releaseGate.failureReasons.join(" ")}`);
  }
  const hostEvidence = await Promise.all(HOST_EVIDENCE.map((descriptor) => loadHostEvidence(repositoryRoot, descriptor)));
  return {
    schemaId: "tokengraph-published-benchmark-results",
    schemaVersion: 1,
    corpusVersion: report.corpusVersion,
    evidenceVersion: report.evidenceVersion,
    aggregate: {
      taskCount: report.aggregate.taskCount,
      activatedTaskCount: report.aggregate.activatedTaskCount,
      bypassedTaskCount: report.aggregate.bypassedTaskCount,
      categoryCounts: report.aggregate.categoryCounts,
      medianNetSavings: report.aggregate.medianNetSavings,
      medianExecutionInclusiveNetSavings: report.aggregate.medianExecutionInclusiveNetSavings,
      primarySavingsMetric: report.aggregate.primarySavingsMetric,
      primaryMedianNetSavings: report.aggregate.primaryMedianNetSavings,
      executionInclusiveMedian: report.aggregate.executionInclusiveMedian,
      executionInclusiveP25: report.aggregate.executionInclusiveP25,
      nonNegativeActivatedRate: report.aggregate.nonNegativeActivatedRate,
      criticalConstraintPreservationRate: report.aggregate.criticalConstraintPreservationRate,
      requiredFileRecall: report.aggregate.requiredFileRecall,
      baselineLabel: report.aggregate.baselineLabel
    },
    exactSliceAccounting: report.exactSliceAccounting,
    routerShadow: report.routerShadow,
    deltaDelivery: report.deltaDelivery,
    realHostEvaluation: realHostEvaluation(hostEvidence[0]!),
    multiRepositoryRealHostCoverage: multiRepositoryCoverage(hostEvidence),
    releaseGate: report.releaseGate
  };
}

export function publishedBenchmarkJson(results: unknown): string {
  return stableBenchmarkJson(results);
}

export async function runPublishedBenchmarkCli(argv: string[]): Promise<void> {
  const check = argv.filter((argument) => argument !== "--").includes("--check");
  const repositoryRoot = resolve("..", "..");
  const outputPath = join(repositoryRoot, "docs", "benchmarks", "results-current.json");
  const serialized = publishedBenchmarkJson(await generatePublishedBenchmarkResults(repositoryRoot));
  if (check) {
    const checked = await readFile(outputPath, "utf8");
    if (checked !== serialized) throw new Error("Published benchmark evidence is stale. Run pnpm benchmark:publish.");
    process.stdout.write("Published benchmark evidence is current.\n");
    return;
  }
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(`Published benchmark evidence to ${outputPath}.\n`);
}
