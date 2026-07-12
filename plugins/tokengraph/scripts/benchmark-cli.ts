import { resolve } from "node:path";

import { BENCHMARK_CATEGORIES, evaluateBenchmark, loadBenchmarkCorpus, median, stableBenchmarkJson } from "./benchmark-lib.js";

export async function runBenchmarkCli(argv: string[]): Promise<void> {
  const json = argv.filter((arg) => arg !== "--").includes("--json");
  const corpus = await loadBenchmarkCorpus(resolve("scripts", "benchmark-corpus-v1.json"));
  const report = await evaluateBenchmark(corpus, resolve("tests", "fixtures", "evidence-project"));
  if (json) {
    process.stdout.write(stableBenchmarkJson(report));
    return;
  }
  process.stdout.write("# TokenGraph Deterministic Evidence Benchmark\n\n");
  process.stdout.write(`Corpus: ${report.corpusVersion}; tasks: ${report.aggregate.taskCount}; release gate: ${report.releaseGate.passed ? "PASS" : "FAIL"}\n\n`);
  for (const category of BENCHMARK_CATEGORIES) {
    const tasks = report.tasks.filter((task) => task.category === category);
    const failures = tasks.filter((task) => task.metrics.qualityResult === "failed");
    process.stdout.write(`- ${category}: ${tasks.length} tasks, median net savings ${median(tasks.map((task) => task.metrics.netEstimatedSavings))}, failures ${failures.length}\n`);
  }
  if (report.aggregate.taskFailures.length) {
    process.stdout.write("\nFailure cases:\n");
    for (const task of report.tasks.filter((candidate) => candidate.metrics.qualityResult === "failed")) {
      process.stdout.write(`- ${task.id}: ${task.metrics.failureReasons.join(" ")}\n`);
    }
  }
}
