import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { parseCodexJsonl, planPairedHostRuns, runPairedHostEvaluation, type PairedHostProtocol } from "../src/core/pairedHost.js";

const execFileAsync = promisify(execFile);

function protocol(repositoryCommit: string, prompt = "Where is src/a.ts? Do not persist this raw prompt."): PairedHostProtocol {
  return {
    schemaVersion: 1,
    evaluationId: "paired-host-test",
    seed: "host-seed",
    reviewed: true,
    model: { identifier: "gpt-5", versionOrDate: "2026-07-19" },
    reasoningLevel: "high",
    approvalPolicy: "never",
    windowsSandbox: "elevated",
    sandbox: "workspace-write",
    repositoryCommit,
    plugin: { version: "0.21.1", commit: "a".repeat(40) },
    promptTemplate: { identifier: "host-test-v1", template: "{{task}}" },
    tokenGraphMcp: { command: process.execPath, args: ["dist/index.js"] },
    acceptance: { command: process.execPath, args: ["-e", "process.exit(require('node:fs').existsSync('host.marker') ? 0 : 1)"] },
    toolConfiguration: { surface: "core" },
    cacheState: "empty",
    indexState: "cold",
    protocol: {
      runsPerTask: 1,
      minimumPerCategorySamples: 10,
      qualityNonInferiorityMargin: 0.02,
      tokenSuperiorityMinimum: 1,
      resourceLimit: 20,
      routerRateMaximum: 0.1,
      executionMedianMinimum: 0,
      executionP25Minimum: 0,
      nonNegativeActivatedMinimum: 0.8
    },
    tasks: [{ taskId: "task-1", category: "code", prompt, expectedBenefit: "none", expectedRouting: "bypass" }]
  };
}

describe("paired Codex host adapter", () => {
  it("parses exact host usage, normalized tools, and final status without retaining text", () => {
    const raw = [
      { type: "thread.started", thread_id: "thread-secret" },
      { type: "item.completed", item: { id: "1", type: "command_execution", command: "Get-Content src/a.ts", aggregated_output: "private", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "2", type: "mcp_tool_call", server: "tokengraph", tool: "tokengraph_prepare_context", arguments: { task: "private" }, status: "completed", result: { content: [], structured_content: null } } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: "private answer" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } }
    ].map((event) => JSON.stringify(event)).join("\n");
    const parsed = parseCodexJsonl(raw, { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1.2.3" });
    expect(parsed).toEqual({
      modelIdentifier: "gpt-5",
      hostVersion: "codex-cli 1.2.3",
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 130 },
      toolCalls: 2,
      fallbackRawReads: 1,
      finalStatus: "completed"
    });
    expect(JSON.stringify(parsed)).not.toMatch(/private|thread-secret|src\/a\.ts/);
  });

  it("refuses JSONL without exact host-reported usage and bounds failure classes", () => {
    expect(() => parseCodexJsonl(JSON.stringify({ type: "turn.completed" }), { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1" })).toThrow(/usage/i);
    const failed = parseCodexJsonl(JSON.stringify({ type: "turn.failed", error: { message: "secret and unbounded" } }), { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1", allowMissingUsageOnFailure: true });
    expect(failed).toMatchObject({ finalStatus: "failed", failureClass: "host-turn-failed" });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("counterbalances ten distinct ON/OFF turns across five repeats", () => {
    const planned = planPairedHostRuns([{ taskId: "task-1", category: "code" }], 5, "seed");
    expect(planned).toHaveLength(10);
    expect(new Set(planned.map((run) => `${run.repeat}:${run.condition}`)).size).toBe(10);
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      const pair = planned.filter((run) => run.repeat === repeat);
      expect(pair.map((run) => run.condition).sort()).toEqual(["off", "on"]);
      expect(new Set(pair.map((run) => run.conditionOrder)).size).toBe(1);
    }
  });

  it("uses isolated worktrees, persists raw evidence, runs acceptance, and emits a privacy-minimal manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-paired-host-"));
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await writeFile(join(root, "README.md"), "fixture\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: root });
      await execFileAsync("git", ["-c", "user.name=TokenGraph", "-c", "user.email=tokengraph@example.invalid", "commit", "-m", "fixture"], { cwd: root });
      const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
      const hostScript = join(root, "fake-host.mjs");
      const cwdLog = join(root, "host-cwds.txt");
      const sharedDependencies = join(root, "shared-dependencies");
      await mkdir(sharedDependencies);
      await writeFile(join(sharedDependencies, "sentinel.txt"), "preserve\n");
      await writeFile(hostScript, [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        "const log = process.argv[2];",
        "if (process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }",
        "appendFileSync(log, process.cwd() + '\\n');",
        "writeFileSync('host.marker', 'ok');",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'private'}));",
        "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:30,reasoning_output_tokens:5}}));"
      ].join("\n"));
      const outputManifest = join(root, "reviewed-manifest.json");
      const provisionedProtocol = { ...protocol(commit.trim()), dependencySource: "shared-dependencies" };
      const result = await runPairedHostEvaluation({
        root,
        protocol: provisionedProtocol,
        outputManifest,
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog],
        timeoutMs: 10_000
      });
      expect(result.manifest?.traces).toHaveLength(2);
      expect(result.manifest?.traces.every((trace) => trace.acceptance?.status === "passed")).toBe(true);
      const worktreeCwds = (await readFile(cwdLog, "utf8")).trim().split(/\r?\n/);
      expect(new Set(worktreeCwds).size).toBe(2);
      const rawDir = join(root, ".tokengraph", "runs", "paired-host", "paired-host-test", "raw");
      expect(await readFile(join(rawDir, "task-1-repeat-1-on.jsonl"), "utf8")).toContain("turn.completed");
      expect(await readFile(join(rawDir, "task-1-repeat-1-off.jsonl"), "utf8")).toContain("turn.completed");
      const reviewed = await readFile(outputManifest, "utf8");
      expect(reviewed).not.toContain(root);
      expect(reviewed).not.toContain("Do not persist this raw prompt");
      expect(reviewed).not.toContain("thread-secret");
      expect(await readFile(join(sharedDependencies, "sentinel.txt"), "utf8")).toBe("preserve\n");

      const failedAcceptanceProtocol = {
        ...protocol(commit.trim()),
        evaluationId: "paired-host-acceptance-failed",
        acceptance: { command: process.execPath, args: ["-e", "process.exit(1)"] }
      };
      const failedAcceptance = await runPairedHostEvaluation({
        root,
        protocol: failedAcceptanceProtocol,
        outputManifest: join(root, "failed-acceptance-manifest.json"),
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog],
        timeoutMs: 10_000
      });
      expect(failedAcceptance.manifest?.traces).toHaveLength(2);
      expect(failedAcceptance.manifest?.traces.every((trace) => trace.failed && trace.acceptance?.status === "failed")).toBe(true);
      expect(new Set(failedAcceptance.manifest?.traces.map((trace) => trace.acceptance?.commandHash)).size).toBe(1);

      const slowHostScript = join(root, "slow-host.mjs");
      await writeFile(slowHostScript, [
        "if (process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }",
        "setInterval(() => {}, 1000);"
      ].join("\n"));
      const timedOutProtocol = { ...protocol(commit.trim()), evaluationId: "paired-host-timeout" };
      await expect(runPairedHostEvaluation({
        root,
        protocol: timedOutProtocol,
        outputManifest: join(root, "timeout-manifest.json"),
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [slowHostScript],
        timeoutMs: 100
      })).rejects.toThrow(/exact-usage host trace/i);
      const timedOutRoot = join(root, ".tokengraph", "runs", "paired-host", "paired-host-timeout");
      const firstTimedOutRun = planPairedHostRuns(timedOutProtocol.tasks, 1, timedOutProtocol.seed)[0]!;
      const timedOutName = `task-1-repeat-1-${firstTimedOutRun.condition}`;
      expect(await readFile(join(timedOutRoot, "raw", `${timedOutName}.jsonl`), "utf8")).toBe("");
      expect(JSON.parse(await readFile(join(timedOutRoot, "normalized", `${timedOutName}.json`), "utf8"))).toMatchObject({
        host: { timedOut: true, finalStatus: "failed", failureClass: "invalid-host-stream" }
      });
      expect(await readdir(join(timedOutRoot, "worktrees"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
