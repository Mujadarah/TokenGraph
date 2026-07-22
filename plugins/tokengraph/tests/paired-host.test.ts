import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { parseCodexJsonl, planPairedHostRuns, runBoundedProcess, runPairedHostEvaluation, type PairedHostProtocol } from "../src/core/pairedHost.js";

const execFileAsync = promisify(execFile);

it("keeps the acceptance verifier read-only-safe under the evaluation permission profile", async () => {
  const source = await readFile(new URL("../scripts/paired-host-acceptance.mjs", import.meta.url), "utf8");

  expect(source).toContain('NODE_DISABLE_COMPILE_CACHE: "1"');
  expect(source).toContain('"--configLoader", "runner"');
});

function protocol(repositoryCommit: string, prompt = "Where is src/a.ts? Do not persist this raw prompt."): PairedHostProtocol {
  return {
    schemaVersion: 2,
    evaluationId: "paired-host-test",
    seed: "host-seed",
    reviewed: true,
    model: { identifier: "gpt-5", versionOrDate: "2026-07-19" },
    reasoningLevel: "high",
    approvalPolicy: "never",
    windowsSandbox: "elevated",
    repositoryCommit,
    plugin: { version: "0.21.1", commit: "a".repeat(40) },
    promptTemplate: { identifier: "host-test-v1", template: "{{task}}" },
    tokenGraphMcp: { command: process.execPath, args: ["dist/index.js"] },
    acceptance: { verifierScript: "acceptance.mjs" },
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
      stage0LatencyMaximumMs: 5,
      executionMedianMinimum: 0,
      executionP25Minimum: 0,
      nonNegativeActivatedMinimum: 0.8
    },
    tasks: [{ taskId: "task-1", category: "code", prompt, expectedBenefit: "none", expectedRouting: "bypass" }]
  };
}

describe("paired Codex host adapter", () => {
  it("parses exact host usage and attests the final in-host verifier without retaining text", () => {
    const acceptanceCommand = "node .tokengraph-controller/acceptance.mjs";
    const acceptanceCommandHash = "a".repeat(64);
    const raw = [
      { type: "thread.started", thread_id: "thread-secret" },
      { type: "item.completed", item: { id: "1", type: "command_execution", command: "Get-Content src/a.ts", aggregated_output: "private", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "2", type: "mcp_tool_call", server: "tokengraph", tool: "tokengraph_prepare_context", arguments: { task: "private" }, status: "completed", result: { content: [], structured_content: null } } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: "private answer" } },
      { type: "item.completed", item: { id: "4", type: "command_execution", command: acceptanceCommand, aggregated_output: "private acceptance", exit_code: 0, status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } }
    ].map((event) => JSON.stringify(event)).join("\n");
    const parsed = parseCodexJsonl(raw, { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1.2.3", acceptanceCommand, acceptanceCommandHash });
    expect(parsed).toEqual({
      modelIdentifier: "gpt-5",
      hostVersion: "codex-cli 1.2.3",
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 130 },
      toolCalls: 3,
      fallbackRawReads: 1,
      finalStatus: "completed",
      acceptance: { status: "passed", commandHash: acceptanceCommandHash }
    });
    expect(JSON.stringify(parsed)).not.toMatch(/private|thread-secret|src\/a\.ts/);
  });

  it("attests only the exact Windows PowerShell wrapper emitted for the verifier", () => {
    const acceptanceCommand = "node .tokengraph-controller/acceptance.mjs";
    const acceptanceCommandHash = "d".repeat(64);
    const wrapped = `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command '${acceptanceCommand}'`;
    const event = (command: string) => [
      { type: "item.completed", item: { id: "1", type: "command_execution", command, exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "2", type: "todo_list", items: [{ text: "finished", completed: true }] } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }
    ].map((item) => JSON.stringify(item)).join("\n");

    expect(parseCodexJsonl(event(wrapped), { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1", acceptanceCommand, acceptanceCommandHash }).acceptance?.status).toBe("passed");
    expect(parseCodexJsonl(event(`${wrapped}; node malicious.mjs`), { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1", acceptanceCommand, acceptanceCommandHash }).acceptance?.status).toBe("failed");
  });

  it("fails attestation after a later mutation-capable event and treats a later host error as terminal", () => {
    const acceptanceCommand = "node .tokengraph-controller/acceptance.mjs";
    const acceptanceCommandHash = "b".repeat(64);
    const events = [
      { type: "item.completed", item: { id: "1", type: "command_execution", command: acceptanceCommand, exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "2", type: "dynamic_tool_call", tool: "future_mutator", status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }
    ];
    const mutated = parseCodexJsonl(events.map((event) => JSON.stringify(event)).join("\n"), { modelIdentifier: "gpt-5", hostVersion: "codex-cli 1", acceptanceCommand, acceptanceCommandHash });
    expect(mutated.acceptance).toEqual({ status: "failed", commandHash: acceptanceCommandHash });

    const lateError = parseCodexJsonl([...events.slice(0, 1), events[2], { type: "error", message: "secret" }].map((event) => JSON.stringify(event)).join("\n"), {
      modelIdentifier: "gpt-5", hostVersion: "codex-cli 1", acceptanceCommand, acceptanceCommandHash
    });
    expect(lateError).toMatchObject({ finalStatus: "failed", failureClass: "host-stream-error", acceptance: { status: "passed" } });
  });

  it("normalizes host spawn failures instead of rejecting the process wrapper", async () => {
    const missing = join(tmpdir(), `tokengraph-missing-host-${Date.now()}.exe`);
    await expect(runBoundedProcess(missing, [], tmpdir(), 1_000)).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: false,
      spawnFailed: true
    });
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
      const argvLog = join(root, "host-argv.jsonl");
      const verifier = join(root, "acceptance.mjs");
      const failedVerifier = join(root, "acceptance-fail.mjs");
      const sharedDependencies = join(root, "shared-dependencies");
      await mkdir(sharedDependencies);
      await writeFile(join(sharedDependencies, "sentinel.txt"), "preserve\n");
      const verifierSource = "import { existsSync } from 'node:fs'; process.exit(existsSync('README.md') ? 0 : 1);\n";
      await writeFile(verifier, verifierSource);
      await writeFile(failedVerifier, "process.exit(1);\n");
      await writeFile(hostScript, [
        "import { appendFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        "const cwdLog = process.argv[2];",
        "const argvLog = process.argv[3];",
        "if (process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }",
        "let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;",
        "appendFileSync(cwdLog, process.cwd() + '\\n');",
        "appendFileSync(argvLog, JSON.stringify(process.argv.slice(4)) + '\\n');",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'private'}));",
        "const acceptance = spawnSync(process.execPath, ['.tokengraph-controller/acceptance.mjs'], {cwd: process.cwd()});",
        "console.log(JSON.stringify({type:'item.completed',item:{id:'acceptance',type:'command_execution',command:'node .tokengraph-controller/acceptance.mjs',exit_code:acceptance.status,status:'completed'}}));",
        "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:30,reasoning_output_tokens:5}}));",
        "if (process.argv.includes('LATE_ERROR')) console.log(JSON.stringify({type:'error',message:'private late failure'}));"
      ].join("\n"));
      const provisionedProtocol = { ...protocol(commit.trim()), dependencySource: "shared-dependencies" };
      const previousSecret = process.env.TOKENGRAPH_TEST_SECRET_SENTINEL;
      process.env.TOKENGRAPH_TEST_SECRET_SENTINEL = "must-not-enter-model-shell";
      const result = await runPairedHostEvaluation({
        root,
        protocol: provisionedProtocol,
        outputManifest: "artifacts/reviewed-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      });
      if (previousSecret === undefined) delete process.env.TOKENGRAPH_TEST_SECRET_SENTINEL;
      else process.env.TOKENGRAPH_TEST_SECRET_SENTINEL = previousSecret;
      expect(result.manifest?.traces).toHaveLength(2);
      expect(result.manifest?.traces.every((trace) => trace.acceptance?.status === "passed" && trace.quality === 1 && !trace.failed)).toBe(true);
      const worktreeCwds = (await readFile(cwdLog, "utf8")).trim().split(/\r?\n/);
      expect(new Set(worktreeCwds).size).toBe(2);
      const hostArguments = await readFile(argvLog, "utf8");
      expect(hostArguments).toContain("shell_environment_policy.inherit=\\\"none\\\"");
      expect(hostArguments).toContain("permissions.tokengraph-eval.network.enabled=false");
      expect(hostArguments).toMatch(/permissions\.tokengraph-eval\.filesystem=.*:root.*deny/);
      expect(hostArguments).not.toContain("--sandbox");
      expect(hostArguments).not.toContain("must-not-enter-model-shell");
      const rawDir = join(root, ".tokengraph", "runs", "paired-host", "paired-host-test", "raw");
      expect(await readFile(join(rawDir, "task-1-repeat-1-on.jsonl"), "utf8")).toContain(".tokengraph-controller/acceptance.mjs");
      expect(await readFile(join(rawDir, "task-1-repeat-1-off.jsonl"), "utf8")).toContain("turn.completed");
      const reviewed = await readFile(join(root, "artifacts", "reviewed-manifest.json"), "utf8");
      expect(reviewed).not.toContain(root);
      expect(reviewed).not.toContain("Do not persist this raw prompt");
      expect(reviewed).not.toContain("thread-secret");
      expect(await readFile(join(sharedDependencies, "sentinel.txt"), "utf8")).toBe("preserve\n");
      const normalized = JSON.parse(await readFile(join(root, ".tokengraph", "runs", "paired-host", "paired-host-test", "normalized", "task-1-repeat-1-on.json"), "utf8"));
      expect(normalized.acceptance).toMatchObject({
        status: "passed",
        commandHash: createHash("sha256").update(verifierSource).digest("hex")
      });

      const failedAcceptanceProtocol = {
        ...protocol(commit.trim()),
        evaluationId: "paired-host-acceptance-failed",
        acceptance: { verifierScript: "acceptance-fail.mjs" }
      };
      const failedAcceptance = await runPairedHostEvaluation({
        root,
        protocol: failedAcceptanceProtocol,
        outputManifest: "artifacts/failed-acceptance-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      });
      expect(failedAcceptance.manifest?.traces).toHaveLength(2);
      expect(failedAcceptance.manifest?.traces.every((trace) => trace.failed && trace.quality === 0 && trace.acceptance?.status === "failed")).toBe(true);
      expect(new Set(failedAcceptance.manifest?.traces.map((trace) => trace.acceptance?.commandHash)).size).toBe(1);

      const lateErrorProtocol = { ...protocol(commit.trim()), evaluationId: "paired-host-late-error" };
      const lateError = await runPairedHostEvaluation({
        root,
        protocol: lateErrorProtocol,
        outputManifest: "artifacts/late-error-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog, "LATE_ERROR"],
        timeoutMs: 10_000
      });
      expect(lateError.manifest?.traces.every((trace) => trace.failed && trace.quality === 0 && trace.acceptance?.status === "passed")).toBe(true);

      const slowHostScript = join(root, "slow-host.mjs");
      await writeFile(slowHostScript, [
        "if (process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }",
        "setInterval(() => {}, 1000);"
      ].join("\n"));
      const timedOutProtocol = { ...protocol(commit.trim()), evaluationId: "paired-host-timeout" };
      await expect(runPairedHostEvaluation({
        root,
        protocol: timedOutProtocol,
        outputManifest: "artifacts/timeout-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [slowHostScript],
        timeoutMs: 100
      })).rejects.toThrow(/exact-usage host trace/i);
      const timedOutRoot = join(root, ".tokengraph", "runs", "paired-host", "paired-host-timeout");
      const firstTimedOutRun = planPairedHostRuns(timedOutProtocol.tasks, 1, timedOutProtocol.seed)[0]!;
      const timedOutName = `task-1-repeat-1-${firstTimedOutRun.condition}`;
      expect(await readFile(join(timedOutRoot, "raw", `${timedOutName}.jsonl`), "utf8")).toBe("");
      expect(JSON.parse(await readFile(join(timedOutRoot, "normalized", `${timedOutName}.json`), "utf8"))).toMatchObject({
        host: { timedOut: true, finalStatus: "failed", failureClass: "host-timeout" }
      });
      expect(await readdir(join(timedOutRoot, "worktrees"))).toEqual([]);

      const missingDependency = { ...protocol(commit.trim()), evaluationId: "paired-host-dependency-failed", dependencySource: "missing-dependencies" };
      await expect(runPairedHostEvaluation({
        root,
        protocol: missingDependency,
        outputManifest: "artifacts/dependency-failed-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      })).rejects.toThrow(/dependency provisioning/i);
      const dependencyRoot = join(root, ".tokengraph", "runs", "paired-host", "paired-host-dependency-failed");
      const dependencyRun = planPairedHostRuns(missingDependency.tasks, 1, missingDependency.seed)[0]!;
      const dependencyName = `task-1-repeat-1-${dependencyRun.condition}`;
      expect(await readFile(join(dependencyRoot, "raw", `${dependencyName}.jsonl`), "utf8")).toBe("");
      expect(JSON.parse(await readFile(join(dependencyRoot, "normalized", `${dependencyName}.json`), "utf8"))).toMatchObject({
        host: { finalStatus: "failed", failureClass: "dependency-provisioning-failed" }
      });
      expect(await readdir(join(dependencyRoot, "worktrees"))).toEqual([]);

      const invalidRoutingProtocol = {
        ...protocol(commit.trim(), "Trace architecture dependencies across the repository."),
        evaluationId: "paired-host-routing-invalid"
      };
      await expect(runPairedHostEvaluation({
        root,
        protocol: invalidRoutingProtocol,
        outputManifest: "artifacts/routing-invalid-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      })).rejects.toThrow(/routing evidence/i);
      const invalidRoutingRoot = join(root, ".tokengraph", "runs", "paired-host", "paired-host-routing-invalid");
      const invalidRoutingRun = planPairedHostRuns(invalidRoutingProtocol.tasks, 1, invalidRoutingProtocol.seed).find((run) => run.condition === "on")!;
      const invalidRoutingName = `task-1-repeat-1-${invalidRoutingRun.condition}`;
      expect(JSON.parse(await readFile(join(invalidRoutingRoot, "normalized", `${invalidRoutingName}.json`), "utf8"))).toMatchObject({
        host: { finalStatus: "completed", failureClass: "routing-evidence-invalid" }
      });
      expect(await readdir(join(invalidRoutingRoot, "worktrees"))).toEqual([]);

      const unsafeEnvironment = {
        ...protocol(commit.trim()),
        tokenGraphMcp: { command: process.execPath, args: ["dist/index.js"], env: { SECRET_TOKEN: "private" } }
      } as PairedHostProtocol;
      await expect(runPairedHostEvaluation({ root, protocol: unsafeEnvironment, dryRun: true })).rejects.toThrow(/protocol fields/i);

      const arbitraryAcceptance = {
        ...protocol(commit.trim()),
        acceptance: { command: process.execPath, args: ["-e", "process.exit(0)"] }
      } as unknown as PairedHostProtocol;
      await expect(runPairedHostEvaluation({ root, protocol: arbitraryAcceptance, dryRun: true })).rejects.toThrow(/protocol fields/i);

      const nonDurableProtocol = { ...protocol(commit.trim()), evaluationId: "paired-host-nondurable" };
      const nonDurableRun = planPairedHostRuns(nonDurableProtocol.tasks, 1, nonDurableProtocol.seed)[0]!;
      const nonDurableName = `task-1-repeat-1-${nonDurableRun.condition}`;
      const nonDurableRoot = join(root, ".tokengraph", "runs", "paired-host", nonDurableProtocol.evaluationId);
      const nonDurableNormalized = join(nonDurableRoot, "normalized", `${nonDurableName}.json`);
      await mkdir(nonDurableNormalized, { recursive: true });
      await expect(runPairedHostEvaluation({
        root,
        protocol: nonDurableProtocol,
        outputManifest: "artifacts/nondurable-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      })).rejects.toThrow();
      const nonDurableWorktree = join(nonDurableRoot, "worktrees", nonDurableName);
      expect(await readdir(join(nonDurableRoot, "worktrees"))).toEqual([nonDurableName]);
      await expect(runPairedHostEvaluation({
        root,
        protocol: nonDurableProtocol,
        outputManifest: "artifacts/nondurable-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      })).rejects.toThrow(/non-durable stale worktree/i);
      expect(await readdir(join(nonDurableRoot, "worktrees"))).toEqual([nonDurableName]);
      await execFileAsync("git", ["worktree", "remove", "--force", nonDurableWorktree], { cwd: root });
      await rm(nonDurableNormalized, { recursive: true, force: true });

      const durableStaleProtocol = { ...protocol(commit.trim()), evaluationId: "paired-host-durable-stale" };
      const durableStaleRun = planPairedHostRuns(durableStaleProtocol.tasks, 1, durableStaleProtocol.seed)[0]!;
      const durableStaleName = `task-1-repeat-1-${durableStaleRun.condition}`;
      const durableStaleRoot = join(root, ".tokengraph", "runs", "paired-host", durableStaleProtocol.evaluationId);
      const durableStaleWorktree = join(durableStaleRoot, "worktrees", durableStaleName);
      await mkdir(join(durableStaleRoot, "raw"), { recursive: true });
      await mkdir(join(durableStaleRoot, "normalized"), { recursive: true });
      await execFileAsync("git", ["worktree", "add", "--detach", durableStaleWorktree, commit.trim()], { cwd: root });
      await writeFile(join(durableStaleRoot, "raw", `${durableStaleName}.jsonl`), "historical raw\n");
      await writeFile(join(durableStaleRoot, "normalized", `${durableStaleName}.json`), JSON.stringify({
        schemaVersion: 2,
        durable: true,
        taskId: durableStaleRun.taskId,
        repeat: durableStaleRun.repeat,
        condition: durableStaleRun.condition
      }));
      const recovered = await runPairedHostEvaluation({
        root,
        protocol: durableStaleProtocol,
        outputManifest: "artifacts/durable-stale-manifest.json",
        hostExecutable: process.execPath,
        hostArgumentsPrefix: [hostScript, cwdLog, argvLog],
        timeoutMs: 10_000
      });
      expect(recovered.manifest?.traces).toHaveLength(2);
      expect(await readdir(join(durableStaleRoot, "worktrees"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
