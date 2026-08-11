#!/usr/bin/env node
import { executeRun, purgeRuns, saveRun, summarizeRun, taskOutcomeFromRun } from "./core/runner.js";
import { loadTokenGraphConfig } from "./core/config.js";
import { assertStorageWriteAllowed, purgeStorageClass, type PurgeStorageClass } from "./core/storagePolicy.js";
import { evaluateManifest, loadEvaluationManifest, persistPromotionReport } from "./core/pairedEval.js";
import { loadPairedHostProtocol, runPairedHostEvaluation } from "./core/pairedHost.js";
import { recordTaskOutcome, requireOpenTaskForOutcome } from "./core/taskLedger.js";
import { getRepositoryIdentity } from "./core/repositoryIdentity.js";
import { activateLegacyRuntimeShutdown } from "./core/legacyRuntimeActivation.js";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function activateConfirmedInvocation(options: string[], usage: string): void {
  if (!options.includes("--confirm-no-legacy-processes")) {
    throw new Error(`${usage} This lock-taking command requires --confirm-no-legacy-processes.`);
  }
  activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true });
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "evaluate-host") {
    const options = argv.slice(1);
    const usage = "Usage: tokengraph evaluate-host [--root <path>] [--controller-root <path>] --protocol <path> [--output-manifest <path>] [--codex <executable>] [--timeout-ms <n>] [--dry-run]";
    if (options.includes("--help")) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    const root = optionValue(options, "--root") ?? process.cwd();
    const protocolPath = optionValue(options, "--protocol");
    if (!protocolPath) throw new Error(usage);
    const timeoutMs = Number(optionValue(options, "--timeout-ms") ?? 30 * 60_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("evaluate-host --timeout-ms must be a positive number.");
    const result = await runPairedHostEvaluation({
      root,
      ...(optionValue(options, "--controller-root") ? { controllerRoot: optionValue(options, "--controller-root") } : {}),
      protocol: await loadPairedHostProtocol(protocolPath),
      ...(optionValue(options, "--output-manifest") ? { outputManifest: optionValue(options, "--output-manifest") } : {}),
      ...(optionValue(options, "--codex") ? { hostExecutable: optionValue(options, "--codex") } : {}),
      timeoutMs,
      dryRun: options.includes("--dry-run")
    });
    process.stdout.write(`${JSON.stringify(options.includes("--dry-run") ? { dryRun: true, hostVersion: result.hostVersion, runs: result.plan } : { manifest: result.manifest, hostVersion: result.hostVersion })}\n`);
    return;
  }
  if (argv[0] === "evaluate-routing") {
    const options = argv.slice(1);
    activateConfirmedInvocation(options, "Usage: tokengraph evaluate-routing [--root <path>] --manifest <path> --confirm-no-legacy-processes");
    const root = optionValue(options, "--root") ?? process.cwd();
    const manifestPath = optionValue(options, "--manifest");
    if (!manifestPath) throw new Error("Usage: tokengraph evaluate-routing [--root <path>] --manifest <path>");
    const report = evaluateManifest(await loadEvaluationManifest(manifestPath));
    const promotion = await persistPromotionReport(root, report);
    process.stdout.write(`${JSON.stringify({ ...report, promotion })}\n`);
    if (!report.enforcementEnabled) process.exitCode = 1;
    return;
  }
  if (argv[0] === "purge") {
    const options = argv.slice(1);
    activateConfirmedInvocation(options, "Usage: tokengraph purge [--root <path>] --class runs|cache|outcomes|derived --confirm-no-legacy-processes");
    const root = optionValue(options, "--root") ?? process.cwd();
    const storageClass = optionValue(options, "--class");
    if (!storageClass || !(["runs", "cache", "outcomes", "derived"] as string[]).includes(storageClass)) {
      throw new Error("Usage: tokengraph purge [--root <path>] --class runs|cache|outcomes|derived");
    }
    process.stdout.write(`${JSON.stringify(await purgeStorageClass(root, storageClass as PurgeStorageClass, {
      confirmedNoLegacyTokenGraphProcesses: true
    }))}\n`);
    return;
  }
  if (argv[0] !== "run") throw new Error("Usage: tokengraph run [--root <path>] [--task-id <uuid>] [--timeout-ms <n>] [--max-bytes <n>] [--test <name>] [--file <path>] [--error-class <name>] --confirm-no-legacy-processes -- <command> [args...]; tokengraph purge [--root <path>] --class runs|cache|outcomes|derived --confirm-no-legacy-processes; tokengraph evaluate-routing [--root <path>] --manifest <path> --confirm-no-legacy-processes; or tokengraph evaluate-host --protocol <path> [--dry-run]");
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("tokengraph run requires `-- <command> [args...]`.");
  const commandArgs = argv.slice(separator + 1);
  const options = argv.slice(1, separator);
  activateConfirmedInvocation(options, "Usage: tokengraph run [options] --confirm-no-legacy-processes -- <command> [args...]");
  const root = optionValue(options, "--root") ?? process.cwd();
  const taskId = optionValue(options, "--task-id");
  const config = await loadTokenGraphConfig(root);
  const timeoutMs = Number(optionValue(options, "--timeout-ms") ?? config.runner.timeoutMs);
  const maxBytes = Number(optionValue(options, "--max-bytes") ?? config.runner.maxBytes);
  const metadata = {
    ...(optionValue(options, "--test") ? { test: optionValue(options, "--test") } : {}),
    ...(optionValue(options, "--file") ? { file: optionValue(options, "--file") } : {}),
    ...(optionValue(options, "--error-class") ? { errorClass: optionValue(options, "--error-class") } : {})
  };
  const taskIdentity = taskId
    ? (await requireOpenTaskForOutcome(root, taskId), await getRepositoryIdentity(root))
    : undefined;
  const retentionCutoff = () => new Date(Date.now() - config.storage.runRetentionDays * 24 * 60 * 60 * 1000);
  await purgeRuns(root, retentionCutoff());
  const run = await executeRun({ root, command: commandArgs[0]!, args: commandArgs.slice(1), timeoutMs, maxBytes, ...(Object.keys(metadata).length ? { metadata } : {}) });
  await assertStorageWriteAllowed(root, "runs", Buffer.byteLength(`${JSON.stringify(run, null, 2)}\n`, "utf8"), config.storage);
  await saveRun(root, run);
  if (taskId && taskIdentity) {
    try {
      await recordTaskOutcome(root, taskId, taskOutcomeFromRun(run, taskId, taskIdentity));
    } catch (error) {
      process.stderr.write(`Run ${run.runId} was saved but was not linked to task ${taskId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  await purgeRuns(root, retentionCutoff());
  process.stdout.write(`${JSON.stringify({ ...summarizeRun(run), stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated })}\n`);
  if (run.status !== "completed") process.exitCode = run.status === "timed-out" ? 124 : 1;
}

// Native addon promises do not by themselves keep Node's event loop alive.
// Hold one bounded process-local handle until the CLI invocation settles.
const cliKeepAlive = setInterval(() => undefined, 1_000);
void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}).finally(() => {
  clearInterval(cliKeepAlive);
});
