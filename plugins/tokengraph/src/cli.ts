#!/usr/bin/env node
import { executeRun, purgeRuns, saveRun, summarizeRun } from "./core/runner.js";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] !== "run") throw new Error("Usage: tokengraph run [--root <path>] [--timeout-ms <n>] -- <command> [args...]");
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("tokengraph run requires `-- <command> [args...]`.");
  const commandArgs = argv.slice(separator + 1);
  const root = optionValue(argv.slice(1, separator), "--root") ?? process.cwd();
  const timeoutMs = Number(optionValue(argv.slice(1, separator), "--timeout-ms") ?? 120_000);
  const maxBytes = Number(optionValue(argv.slice(1, separator), "--max-bytes") ?? 64 * 1024);
  const run = await executeRun({ root, command: commandArgs[0]!, args: commandArgs.slice(1), timeoutMs, maxBytes });
  await saveRun(root, run);
  await purgeRuns(root, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
  process.stdout.write(`${JSON.stringify({ ...summarizeRun(run), stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated })}\n`);
  if (run.status !== "completed") process.exitCode = run.status === "timed-out" ? 124 : 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
