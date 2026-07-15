import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_GRAPH_CONFIG, saveTokenGraphConfig } from "../src/core/config.js";

const execFileAsync = promisify(execFile);

describe("tokengraph run CLI", () => {
  it("evaluates a complete host-trace manifest and persists only passing promotion evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-eval-"));
    try {
      const tasks = Array.from({ length: 10 }, (_, index) => ({ taskId: `task-${index}`, category: "code" }));
      const traces = tasks.flatMap((task) => [
        { taskId: task.taskId, category: task.category, condition: "on", tokens: 80, executionInclusiveTokens: 80, quality: 1, timedOut: false, failed: false, resourceUnits: 1, routing: { mode: "shadow", decision: "activate", stage: 0, reason: "context-discovery", expectedOverheadTokens: 80, falseBypass: false, falseActivation: false } },
        { taskId: task.taskId, category: task.category, condition: "off", tokens: 100, executionInclusiveTokens: 100, quality: 1, timedOut: false, failed: false, resourceUnits: 1 }
      ]);
      const manifestPath = join(root, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1, generatedAt: "2026-07-16T00:00:00.000Z", seed: "cli-eval",
        model: { identifier: "gpt-5", versionOrDate: "2026-07-16" }, reasoningLevel: "high",
        host: { name: "codex", version: "1.0.0" }, plugin: { version: "0.21.0", commit: "a".repeat(40) },
        repositoryCommit: "b".repeat(40), promptTemplate: "paired-eval-v1", toolConfiguration: { surface: "core" },
        cacheState: "empty", indexState: "cold",
        protocol: { runsPerTask: 1, minimumPerCategorySamples: 10, qualityNonInferiorityMargin: 0.02, tokenSuperiorityMinimum: 1, resourceLimit: 2, routerRateMaximum: 0.1, executionMedianMinimum: 0, executionP25Minimum: 0, nonNegativeActivatedMinimum: 0.8 },
        tasks, traces
      }));
      const evaluated = await execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "evaluate-routing", "--root", root, "--manifest", manifestPath
      ], { cwd: process.cwd() });
      expect(JSON.parse(evaluated.stdout)).toMatchObject({ enforcementEnabled: true, promotion: { enforcementEnabled: true } });
      expect(JSON.parse(await readFile(join(root, ".tokengraph", "repository", "routing-control.json"), "utf8"))).toMatchObject({ promotion: { enforcementEnabled: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists exact selectors and applies configured run retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-runner-"));
    try {
      await saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
      const first = await execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "run", "--root", root,
        "--file", "src/example.ts", "--error-class", "ExplicitFailure",
        "--", process.execPath, "-e", "console.log('ok')"
      ], { cwd: process.cwd() });
      const firstReport = JSON.parse(first.stdout) as { runId: string };
      const saved = JSON.parse(await readFile(join(root, ".tokengraph", "runs", `${firstReport.runId}.json`), "utf8")) as { metadata?: object };
      expect(saved.metadata).toEqual({ file: "src/example.ts", errorClass: "ExplicitFailure" });

      await saveTokenGraphConfig(root, {
        ...DEFAULT_TOKEN_GRAPH_CONFIG,
        storage: { ...DEFAULT_TOKEN_GRAPH_CONFIG.storage, runRetentionDays: 0 }
      });
      await execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "run", "--root", root,
        "--", process.execPath, "-e", "console.log('purge')"
      ], { cwd: process.cwd() });
      expect((await readdir(join(root, ".tokengraph", "runs"))).filter((entry) => entry.endsWith(".json"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses runs above their class cap and explicitly purges selected derived state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-runner-"));
    try {
      await saveTokenGraphConfig(root, {
        ...DEFAULT_TOKEN_GRAPH_CONFIG,
        storage: { ...DEFAULT_TOKEN_GRAPH_CONFIG.storage, runsMaxBytes: 1 }
      });
      await expect(execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "run", "--root", root,
        "--", process.execPath, "-e", "console.log('too large')"
      ], { cwd: process.cwd() })).rejects.toMatchObject({ stderr: expect.stringMatching(/runs.*purge/i) });
      expect((await readdir(join(root, ".tokengraph", "runs")).catch(() => [])).filter((entry) => entry.endsWith(".json"))).toEqual([]);

      await mkdir(join(root, ".tokengraph", "wiki"), { recursive: true });
      await writeFile(join(root, ".tokengraph", "index.json"), "{}");
      await writeFile(join(root, ".tokengraph", "wiki", "page.md"), "derived");
      const purge = await execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "purge", "--root", root, "--class", "cache"
      ], { cwd: process.cwd() });
      expect(JSON.parse(purge.stdout)).toMatchObject({ class: "cache", removed: expect.arrayContaining([".tokengraph/index.json", ".tokengraph/wiki"]) });
      await expect(access(join(root, ".tokengraph", "index.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
