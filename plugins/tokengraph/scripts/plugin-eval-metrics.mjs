import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(scriptDirectory, "..", ".plugin-eval", "benchmark.json");
const MAX_BENCHMARK_BYTES = 16 * 1024 * 1024;
const MAX_VERIFIER_BYTES = 256 * 1024;

function check(id, status, message, evidence = [], remediation = []) {
  return { id, category: "tokengraph", severity: status === "fail" ? "error" : status === "warn" ? "warning" : "info", status, message, evidence, remediation };
}

function metric(id, value, unit, band = "info") {
  return { id, category: "tokengraph", value, unit, band };
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

async function readJson(path, maxBytes, label) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) throw new Error(`${label} must be a bounded regular file.`);
  return JSON.parse(await readFile(path, "utf8"));
}

function within(root, target) {
  const value = relative(root, target);
  return value && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value);
}

async function verifierPayloads(benchmark) {
  const runRoot = await realpath(benchmark.runDirectory);
  const payloads = [];
  for (const scenario of benchmark.scenarios ?? []) {
    const result = scenario.verifierResults?.[0];
    if (result?.status !== "passed" || !result.stdoutPath) continue;
    const originalStats = await lstat(result.stdoutPath);
    if (!originalStats.isFile() || originalStats.isSymbolicLink() || originalStats.size > MAX_VERIFIER_BYTES) throw new Error("Verifier output must be a bounded regular file.");
    const outputPath = await realpath(result.stdoutPath);
    if (!within(runRoot, outputPath)) throw new Error("Verifier output resolves outside the benchmark run directory.");
    const lines = (await readFile(outputPath, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const payload = JSON.parse(lines.at(-1));
    if (payload?.schemaVersion !== 2 || payload.scenario !== scenario.id) throw new Error("Verifier output does not match its benchmark scenario.");
    for (const key of ["requiredFileCount", "recalledFileCount", "passedTestCommands", "workspaceWriteOperationCount", "workspaceWriteLogicalBytes", "workspaceSampledPeakRssBytes"]) {
      nonNegativeInteger(payload[key], `Verifier ${scenario.id} ${key}`);
    }
    if (payload.recalledFileCount > payload.requiredFileCount || payload.taskSuccess !== true || ![null, true, false].includes(payload.patchCorrect)) {
      throw new Error("Verifier output contains inconsistent scenario evidence.");
    }
    payloads.push(payload);
  }
  return payloads;
}

async function main() {
  const targetPath = resolve(process.argv[2] ?? process.env.PLUGIN_EVAL_TARGET ?? "");
  const targetKind = process.argv[3] ?? process.env.PLUGIN_EVAL_TARGET_KIND;
  if (!targetPath || targetKind !== "plugin") throw new Error("TokenGraph metrics require a plugin target.");
  const config = await readJson(configPath, 256 * 1024, "benchmark config");
  const configuredScenarios = Array.isArray(config.scenarios) ? config.scenarios : [];
  const configuredScenarioIds = configuredScenarios
    .map((scenario) => scenario?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  const configuredScenarioCount = configuredScenarios.length;
  const checks = [];
  const metrics = [metric("tokengraph-configured-scenarios", configuredScenarioCount, "scenarios", configuredScenarioCount === 6 ? "good" : "warning")];
  const benchmarkPath = process.env.TOKENGRAPH_PLUGIN_EVAL_BENCHMARK;
  if (!benchmarkPath) {
    checks.push(check(
      "tokengraph-benchmark-evidence",
      "info",
      "Live TokenGraph benchmark evidence was not supplied.",
      [`configured scenarios: ${configuredScenarioCount}`],
      ["Set TOKENGRAPH_PLUGIN_EVAL_BENCHMARK to a retained benchmark-run.json when measured evidence is available."]
    ));
    process.stdout.write(`${JSON.stringify({ checks, metrics, artifacts: [] })}\n`);
    return;
  }

  const benchmark = await readJson(resolve(benchmarkPath), MAX_BENCHMARK_BYTES, "benchmark result");
  if (benchmark?.kind !== "benchmark-run" || !Array.isArray(benchmark.scenarios) || !benchmark.summary) throw new Error("Benchmark result has an unsupported schema.");
  for (const scenario of benchmark.scenarios) nonNegativeInteger(scenario.durationMs, `Benchmark ${scenario.id} durationMs`);
  const payloads = await verifierPayloads(benchmark);
  const completed = benchmark.scenarios.filter((scenario) => scenario.status === "completed").length;
  const failedScenarios = benchmark.scenarios.length - completed;
  const verifierResults = benchmark.scenarios.flatMap((scenario) => Array.isArray(scenario.verifierResults) ? scenario.verifierResults : []);
  const verifierPassCount = verifierResults.filter((result) => result?.status === "passed").length;
  const verifierFailCount = verifierResults.length - verifierPassCount;
  const summaryFailedScenarios = nonNegativeInteger(benchmark.summary.failedScenarios, "Benchmark summary failedScenarios");
  const summaryVerifierPassCount = nonNegativeInteger(benchmark.summary.verifierPassCount, "Benchmark summary verifierPassCount");
  const summaryVerifierFailCount = nonNegativeInteger(benchmark.summary.verifierFailCount, "Benchmark summary verifierFailCount");
  const configuredScenarioSet = new Set(configuredScenarioIds);
  const observedScenarioIds = benchmark.scenarios.map((scenario) => scenario.id);
  const observedScenarioSet = new Set(observedScenarioIds);
  const scenarioIdentitiesMatch =
    configuredScenarioSet.size === configuredScenarioCount &&
    observedScenarioIds.length === configuredScenarioCount &&
    observedScenarioSet.size === observedScenarioIds.length &&
    observedScenarioIds.every((id) => configuredScenarioSet.has(id));
  const verifierRecordsMatch = benchmark.scenarios.every((scenario) => Array.isArray(scenario.verifierResults) && scenario.verifierResults.length === 1);
  const summaryMatchesRecords =
    summaryFailedScenarios === failedScenarios &&
    summaryVerifierPassCount === verifierPassCount &&
    summaryVerifierFailCount === verifierFailCount;
  const taskSuccesses = payloads.filter((payload) => payload.taskSuccess === true).length;
  const requiredFiles = payloads.reduce((sum, payload) => sum + (payload.requiredFileCount ?? 0), 0);
  const recalledFiles = payloads.reduce((sum, payload) => sum + (payload.recalledFileCount ?? 0), 0);
  const passedTestCommands = payloads.reduce((sum, payload) => sum + (payload.passedTestCommands ?? 0), 0);
  const patchPayloads = payloads.filter((payload) => payload.patchCorrect !== null);
  const correctPatches = patchPayloads.filter((payload) => payload.patchCorrect === true).length;
  const workspaceWriteOperations = payloads.reduce((sum, payload) => sum + (payload.workspaceWriteOperationCount ?? 0), 0);
  const workspaceWriteLogicalBytes = payloads.reduce((sum, payload) => sum + (payload.workspaceWriteLogicalBytes ?? 0), 0);
  const workspaceSampledPeakRssBytes = payloads.reduce((maximum, payload) => Math.max(maximum, payload.workspaceSampledPeakRssBytes ?? 0), 0);
  const durationMs = benchmark.scenarios.reduce((sum, scenario) => sum + (scenario.durationMs ?? 0), 0);
  const workspaceChanges = benchmark.scenarios.reduce((sum, scenario) => sum + (scenario.workspaceSummary?.changedFileCount ?? 0), 0);
  const expected = configuredScenarioCount;
  const benchmarkEvidenceComplete =
    scenarioIdentitiesMatch &&
    verifierRecordsMatch &&
    summaryMatchesRecords &&
    completed === expected &&
    payloads.length === expected;

  checks.push(check(
    "tokengraph-benchmark-scenarios",
    benchmarkEvidenceComplete ? "pass" : "fail",
    `${completed} of ${expected} TokenGraph scenarios completed with ${payloads.length} retained verifier records.`,
    [
      `scenario identities: ${scenarioIdentitiesMatch ? "exact" : "mismatch"}`,
      `verifier records: ${verifierRecordsMatch ? "complete" : "mismatch"}`,
      `summary records: ${summaryMatchesRecords ? "consistent" : "mismatch"}`,
      `failed scenarios: ${failedScenarios}`
    ],
    benchmarkEvidenceComplete ? [] : ["Inspect scenario identities, summary counts, and verifier logs before using this benchmark as release evidence."]
  ));
  checks.push(check(
    "tokengraph-required-file-recall",
    requiredFiles > 0 && recalledFiles === requiredFiles ? "pass" : "fail",
    `${recalledFiles} of ${requiredFiles} required files were recalled.`,
    [],
    recalledFiles === requiredFiles ? [] : ["Review scenario result manifests and retrieval evidence."]
  ));
  checks.push(check(
    "tokengraph-patch-correctness",
    patchPayloads.length === 1 && correctPatches === 1 ? "pass" : "fail",
    `${correctPatches} of ${patchPayloads.length} required patches were exact.`,
    [],
    correctPatches === 1 ? [] : ["Inspect the local-change-capsule workspace diff."]
  ));
  checks.push(check(
    "tokengraph-verifier-tests",
    passedTestCommands === 5 && verifierFailCount === 0 && summaryMatchesRecords ? "pass" : "fail",
    `${passedTestCommands} scenario test commands passed; verifier failures: ${verifierFailCount}.`,
    [],
    passedTestCommands === 5 && verifierFailCount === 0 && summaryMatchesRecords ? [] : ["Inspect focused and full verifier command logs."]
  ));

  metrics.push(
    metric("tokengraph-scenario-success-rate", expected ? completed / expected : 0, "ratio", benchmarkEvidenceComplete ? "good" : "warning"),
    metric("tokengraph-task-success-count", taskSuccesses, "tasks", taskSuccesses === expected ? "good" : "warning"),
    metric("tokengraph-required-file-recall-rate", requiredFiles ? recalledFiles / requiredFiles : 0, "ratio", recalledFiles === requiredFiles && requiredFiles > 0 ? "good" : "warning"),
    metric("tokengraph-benchmark-duration", durationMs, "milliseconds"),
    metric("tokengraph-tool-calls", benchmark.summary.toolCallCount ?? 0, "calls"),
    metric("tokengraph-workspace-changes", workspaceChanges, "files"),
    metric("tokengraph-verifier-pass-count", verifierPassCount, "commands", verifierFailCount === 0 && summaryMatchesRecords ? "good" : "warning"),
    metric("tokengraph-passed-test-commands", passedTestCommands, "commands", passedTestCommands === 5 ? "good" : "warning"),
    metric("tokengraph-patch-correctness-rate", patchPayloads.length ? correctPatches / patchPayloads.length : 0, "ratio", correctPatches === patchPayloads.length && patchPayloads.length > 0 ? "good" : "warning"),
    metric("tokengraph-workspace-write-operations", workspaceWriteOperations, "operations"),
    metric("tokengraph-workspace-write-logical-bytes", workspaceWriteLogicalBytes, "bytes"),
    metric("tokengraph-workspace-sampled-peak-rss", workspaceSampledPeakRssBytes, "bytes")
  );
  if ((benchmark.summary.sampleCount ?? 0) > 0) {
    metrics.push(
      metric("tokengraph-average-input-tokens", benchmark.summary.averageInputTokens, "tokens"),
      metric("tokengraph-average-output-tokens", benchmark.summary.averageOutputTokens, "tokens"),
      metric("tokengraph-average-total-tokens", benchmark.summary.averageTotalTokens, "tokens")
    );
  }
  process.stdout.write(`${JSON.stringify({ checks, metrics, artifacts: [] })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
