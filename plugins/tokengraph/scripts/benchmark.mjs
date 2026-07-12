#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "tokengraph-benchmark-"));
const output = join(temporaryDirectory, "benchmark-cli.mjs");

try {
  await build({
    entryPoints: [resolve("scripts", "benchmark-cli.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent"
  });
  const { runBenchmarkCli } = await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
  await runBenchmarkCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
