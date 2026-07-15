import { resolve } from "node:path";

import { BENCHMARK_CATEGORIES, evaluateBenchmark, loadBenchmarkCorpus, median, stableBenchmarkJson } from "./benchmark-lib.js";

interface BenchmarkCliDependencies {
  loadCorpus?: typeof loadBenchmarkCorpus;
  evaluate?: typeof evaluateBenchmark;
  write?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export async function runBenchmarkCli(argv: string[], dependencies: BenchmarkCliDependencies = {}): Promise<void> {
  const json = argv.filter((arg) => arg !== "--").includes("--json");
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  const corpus = await (dependencies.loadCorpus ?? loadBenchmarkCorpus)(resolve("scripts", "benchmark-corpus-v1.json"));
  const report = await (dependencies.evaluate ?? evaluateBenchmark)(corpus, resolve("tests", "fixtures", "evidence-project"));
  if (!report.releaseGate.passed) (dependencies.setExitCode ?? ((code: number) => { process.exitCode = code; }))(1);
  if (json) {
    write(stableBenchmarkJson(report));
    return;
  }
  write("# TokenGraph Deterministic Evidence Benchmark\n\n");
  write(`Corpus: ${report.corpusVersion}; tasks: ${report.aggregate.taskCount}; release gate: ${report.releaseGate.passed ? "PASS" : "FAIL"}\n\n`);
  for (const category of BENCHMARK_CATEGORIES) {
    const tasks = report.tasks.filter((task) => task.category === category);
    const failures = tasks.filter((task) => task.metrics.qualityResult === "failed");
    write(`- ${category}: ${tasks.length} tasks, median net savings ${median(tasks.map((task) => task.metrics.netEstimatedSavings))}, failures ${failures.length}\n`);
  }
  if (report.aggregate.taskFailures.length) {
    write("\nFailure cases:\n");
    for (const task of report.tasks.filter((candidate) => candidate.metrics.qualityResult === "failed")) {
      write(`- ${task.id}: ${task.metrics.failureReasons.join(" ")}\n`);
    }
  }
}
