import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const pluginRoot = process.cwd();
const benchmarkPath = resolve(pluginRoot, ".plugin-eval", "benchmark.json");
const metricManifestPath = resolve(pluginRoot, ".plugin-eval", "metric-pack.json");
const metricsScriptPath = resolve(pluginRoot, "scripts", "plugin-eval-metrics.mjs");
const verifierScriptPath = resolve(pluginRoot, "scripts", "plugin-eval-verifier.mjs");
const temporaryRoots: string[] = [];

const scenarioIds = [
  "trusted-setup-graph",
  "indexing-race-recovery",
  "runner-failure-diagnosis",
  "local-change-capsule",
  "memory-knowledge-review",
  "doctor-release-audit"
];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Plugin Eval benchmark contract", () => {
  it("tracks the CLI-only six-scenario Linux harness without machine-local paths", async () => {
    const benchmarkText = await readFile(benchmarkPath, "utf8");
    const benchmark = JSON.parse(benchmarkText) as {
      kind: string;
      schemaVersion: number;
      workspace: { sourcePath: string; setupMode: string; preserve: string };
      targetProvisioning: { mode: string };
      verifiers: { commands: string[] };
      scenarios: Array<{ id: string; userInput: string; successChecklist: string[] }>;
    };

    expect(benchmark).toMatchObject({
      kind: "plugin-eval-benchmark",
      schemaVersion: 2,
      workspace: { sourcePath: "../..", setupMode: "git-worktree", preserve: "on-failure" },
      targetProvisioning: { mode: "workspace-plugin-marketplace" },
      verifiers: { commands: ["node plugins/tokengraph/scripts/plugin-eval-verifier.mjs"] }
    });
    expect(benchmark.scenarios.map((scenario) => scenario.id)).toEqual(scenarioIds);
    for (const scenario of benchmark.scenarios) {
      expect(scenario.userInput).toContain("Use the installed TokenGraph plugin");
      expect(scenario.userInput).toContain("artifacts/plugin-eval/scenario-result.json");
      expect(scenario.userInput).toContain(`scenario ${scenario.id}`);
      expect(scenario.userInput).toContain("schemaVersion 2");
      expect(scenario.userInput).toContain("taskId");
      expect(scenario.userInput).toContain("query exactly each required file path");
      expect(scenario.userInput).toMatch(/Report the task through TokenGraph/);
      expect(scenario.successChecklist.length).toBeGreaterThanOrEqual(3);
    }
    expect(benchmarkText).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);

    const ignore = await readFile(resolve(pluginRoot, ".gitignore"), "utf8");
    expect(ignore).toContain(".plugin-eval/runs/");
    expect(ignore).toContain(".plugin-eval/benchmark-usage.jsonl");
    expect(ignore).toContain(".plugin-eval/workspaces/");
  });

  it("pins the scenario-aware verifier and exact patch fixture in source", async () => {
    const verifier = await readFile(verifierScriptPath, "utf8");
    for (const scenarioId of scenarioIds) expect(verifier).toContain(`\"${scenarioId}\"`);
    expect(verifier).toContain("git\", [\"diff\", \"--check\"");
    expect(verifier).toContain("--untracked-files=no");
    expect(verifier).toContain("write-aggregates.json");
    expect(verifier).toContain(".tokengraph/tasks/");
    expect(verifier).toContain("expectedSearchFingerprint");
    expect(verifier).toContain('ledger.status !== "completed"');
    expect(verifier).toContain("passedTestCommands");
    expect(verifier).toContain("patchCorrect");

    expect(await readFile(resolve(pluginRoot, "tests", "fixtures", "plugin-eval", "change-capsule-input.ts"), "utf8")).toContain('return "before";');
  });
});

describe("TokenGraph Plugin Eval metric pack", () => {
  it("declares only the supported plugin target and local emitter", async () => {
    const manifest = JSON.parse(await readFile(metricManifestPath, "utf8"));
    expect(manifest).toEqual({
      name: "tokengraph-evidence",
      version: "1.0.0",
      supportedTargetKinds: ["plugin"],
      command: ["node", "../scripts/plugin-eval-metrics.mjs"]
    });
  });

  it("emits only checks, metrics, and artifacts without measured evidence", () => {
    const result = spawnSync(process.execPath, [metricsScriptPath, pluginRoot, "plugin"], {
      cwd: resolve(pluginRoot, ".plugin-eval"),
      encoding: "utf8",
      env: { ...process.env, TOKENGRAPH_PLUGIN_EVAL_BENCHMARK: "" }
    });
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(Object.keys(payload).sort()).toEqual(["artifacts", "checks", "metrics"]);
    expect(payload.checks).toEqual([expect.objectContaining({ id: "tokengraph-benchmark-evidence", status: "info" })]);
    expect(payload.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tokengraph-configured-scenarios", value: 6 })]));
  });

  it("merges benchmark and verifier evidence with stable metric ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-plugin-eval-contract-"));
    temporaryRoots.push(root);
    const scenarios = [];
    for (const [index, id] of scenarioIds.entries()) {
      const directory = join(root, `${index + 1}-${id}`);
      await mkdir(directory, { recursive: true });
      const stdoutPath = join(directory, "verifier-1.stdout.log");
      await writeFile(stdoutPath, `${JSON.stringify({
        schemaVersion: 2,
        scenario: id,
        taskSuccess: true,
        requiredFileCount: 3,
        recalledFileCount: 3,
        patchCorrect: id === "local-change-capsule" ? true : null,
        passedTestCommands: id === "trusted-setup-graph" ? 0 : 1,
        workspaceWriteOperationCount: 2,
        workspaceWriteLogicalBytes: 20,
        workspaceSampledPeakRssBytes: 100 + index
      })}\n`);
      scenarios.push({
        id,
        status: "completed",
        durationMs: 10,
        workspaceSummary: { changedFileCount: id === "local-change-capsule" ? 1 : 0 },
        verifierResults: [{ status: "passed", stdoutPath }]
      });
    }
    const resultPath = join(root, "benchmark-run.json");
    await writeFile(resultPath, JSON.stringify({
      kind: "benchmark-run",
      runDirectory: root,
      summary: {
        failedScenarios: 0,
        verifierPassCount: 6,
        verifierFailCount: 0,
        toolCallCount: 24,
        sampleCount: 6,
        averageInputTokens: 100,
        averageOutputTokens: 50,
        averageTotalTokens: 150
      },
      scenarios
    }));

    const result = spawnSync(process.execPath, [metricsScriptPath, pluginRoot, "plugin"], {
      cwd: resolve(pluginRoot, ".plugin-eval"),
      encoding: "utf8",
      env: { ...process.env, TOKENGRAPH_PLUGIN_EVAL_BENCHMARK: resultPath }
    });
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(Object.keys(payload).sort()).toEqual(["artifacts", "checks", "metrics"]);
    expect(payload.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tokengraph-benchmark-scenarios", status: "pass" }),
      expect.objectContaining({ id: "tokengraph-required-file-recall", status: "pass" }),
      expect.objectContaining({ id: "tokengraph-patch-correctness", status: "pass" }),
      expect.objectContaining({ id: "tokengraph-verifier-tests", status: "pass" })
    ]));
    expect(payload.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tokengraph-tool-calls", value: 24 }),
      expect.objectContaining({ id: "tokengraph-workspace-write-operations", value: 12 }),
      expect.objectContaining({ id: "tokengraph-workspace-write-logical-bytes", value: 120 }),
      expect.objectContaining({ id: "tokengraph-workspace-sampled-peak-rss", value: 105 }),
      expect.objectContaining({ id: "tokengraph-passed-test-commands", value: 5 }),
      expect.objectContaining({ id: "tokengraph-patch-correctness-rate", value: 1 })
    ]));
  });
});
