import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_GRAPH_CONFIG, saveTokenGraphConfig } from "../src/core/config.js";
import { createTaskLedger, loadTaskLedger, setTaskDisposition } from "../src/core/taskLedger.js";

const execFileAsync = promisify(execFile);

describe("tokengraph run CLI", () => {
  it("links a real failed command to an active task as a verified scoped outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-task-outcome-"));
    try {
      const ledger = await createTaskLedger(root, { host: "codex" });
      const result = await execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "run", "--root", root, "--task-id", ledger.taskId,
        "--", process.execPath, "-e", "process.exit(7)"
      ], { cwd: process.cwd() }).catch((error: unknown) => error as { stdout: string });

      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", exitCode: 7 });
      const stored = await loadTaskLedger(root, ledger.taskId);
      expect(stored?.outcomes).toEqual([
        expect.objectContaining({
          taskId: ledger.taskId,
          status: "verified",
          branch: expect.any(String),
          worktreeId: expect.any(String),
          headCommit: expect.any(String),
          evidence: expect.arrayContaining([expect.stringMatching(/^run:/), "exit-code:7", "runner-status:failed"])
        })
      ]);
      expect(stored?.outcomes[0]?.summary).not.toMatch(/stdout|stderr/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a post-run linkage failure without replacing the command result", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-task-link-failure-"));
    try {
      const ledger = await createTaskLedger(root, { host: "codex" });
      const path = join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`);
      const result = await execFileAsync(process.execPath, [
        resolve("dist", "cli.js"), "run", "--root", root, "--task-id", ledger.taskId,
        "--", process.execPath, "-e", `require('node:fs').unlinkSync(${JSON.stringify(path)}); process.exit(7)`
      ], { cwd: process.cwd() }).catch((error: unknown) => error) as { code: number; stdout: string; stderr: string };

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", exitCode: 7 });
      expect(result.stderr).toMatch(new RegExp(`Run .+ was saved but was not linked to task ${ledger.taskId}:`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid task linkage before spawning the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-task-guard-"));
    try {
      const paused = await createTaskLedger(root, { host: "codex" });
      await setTaskDisposition(root, paused.taskId, "pause");
      const completed = await createTaskLedger(root, { host: "codex" });
      await setTaskDisposition(root, completed.taskId, "complete");
      const wrongBranch = await createTaskLedger(root, { host: "codex" });
      const wrongBranchPath = join(root, ".tokengraph", "tasks", `${wrongBranch.taskId}.json`);
      const wrongBranchStored = JSON.parse(await readFile(wrongBranchPath, "utf8")) as { repositoryIdentity: { branch: string } };
      wrongBranchStored.repositoryIdentity.branch = `${wrongBranchStored.repositoryIdentity.branch}-other`;
      await writeFile(wrongBranchPath, JSON.stringify(wrongBranchStored));

      for (const [label, taskId] of [
        ["missing", randomUUID()],
        ["paused", paused.taskId],
        ["completed", completed.taskId],
        ["wrong-branch", wrongBranch.taskId]
      ]) {
        const marker = join(root, `${label}.marker`);
        await expect(execFileAsync(process.execPath, [
          resolve("dist", "cli.js"), "run", "--root", root, "--task-id", taskId,
          "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`
        ], { cwd: process.cwd() })).rejects.toMatchObject({ stderr: expect.stringMatching(/task|ledger|branch/i) });
        await expect(access(marker)).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evaluates a complete host-trace manifest and persists only passing promotion evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-eval-"));
    try {
      const tasks = Array.from({ length: 20 }, (_, index) => ({ taskId: `task-${index}`, category: "code" }));
      const traces = tasks.flatMap((task, index) => {
        const expectedRouting = index < 10 ? "activate" : "bypass";
        const shared = {
          taskId: task.taskId, category: task.category, repeat: 1,
          conditionOrder: index % 2 === 0 ? "on-first" : "off-first", usageSource: "host",
          acceptance: { status: "passed", commandHash: "c".repeat(64) },
          quality: 1, timedOut: false, failed: false, resourceUnits: 1
        };
        return [
          {
            ...shared, condition: "on", tokens: 80, executionInclusiveTokens: 80,
            routing: {
              mode: "shadow", decision: expectedRouting, stage: 0,
              reason: expectedRouting === "activate" ? "context-discovery" : "bounded-task",
              expectedOverheadTokens: expectedRouting === "activate" ? 80 : 0,
              expectedBenefit: expectedRouting === "activate" ? "medium" : "none", expectedRouting,
              routingLatencyMs: 0.2, ...(expectedRouting === "activate" ? { activationLatencyMs: 5 } : {}),
              falseBypass: false, falseActivation: false
            }
          },
          { ...shared, condition: "off", tokens: 100, executionInclusiveTokens: 100 }
        ];
      });
      const manifestPath = join(root, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 2, evidenceSource: "real-host", reviewed: true,
        generatedAt: "2026-07-16T00:00:00.000Z", seed: "cli-eval",
        model: { identifier: "gpt-5", versionOrDate: "2026-07-16" }, reasoningLevel: "high",
        host: { name: "codex", version: "1.0.0" }, plugin: { version: "0.21.0", commit: "a".repeat(40) },
        repositoryCommit: "b".repeat(40), promptTemplate: "paired-eval-v2", promptTemplateHash: "d".repeat(64), toolConfiguration: { surface: "core" },
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
