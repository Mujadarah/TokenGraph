import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import type { ExpectedBenefit, RoutingDecision } from "./artifact.js";
import type { EvaluationTask, HostTrace, PairedEvaluationManifest, PairedEvaluationProtocol, RouterShadowObservation } from "./pairedEval.js";
import { parseEvaluationManifest } from "./pairedEval.js";
import { adviseRouting } from "./routingAdvisor.js";

export interface PairedHostTask extends EvaluationTask {
  prompt: string;
  expectedBenefit: ExpectedBenefit;
  expectedRouting: "activate" | "bypass";
}

export interface PairedHostProtocol {
  schemaVersion: 1;
  evaluationId: string;
  seed: string;
  reviewed?: boolean;
  model: { identifier: string; versionOrDate: string };
  reasoningLevel: string;
  sandbox: "read-only" | "workspace-write";
  repositoryCommit: string;
  plugin: { version: string; commit: string };
  promptTemplate: { identifier: string; template: string };
  tokenGraphMcp: { command: string; args: string[]; env?: Record<string, string> };
  acceptance: { command: string; args: string[] };
  toolConfiguration: Record<string, unknown>;
  cacheState: string;
  indexState: "cold" | "warm";
  protocol: PairedEvaluationProtocol;
  tasks: PairedHostTask[];
}

export interface PlannedHostRun {
  taskId: string;
  category: string;
  repeat: number;
  condition: "on" | "off";
  conditionOrder: "on-first" | "off-first";
}

export interface ParsedCodexJsonl {
  modelIdentifier: string;
  hostVersion: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  toolCalls: number;
  fallbackRawReads: number;
  finalStatus: "completed" | "failed";
  failureClass?: "host-turn-failed" | "host-stream-error" | "invalid-host-stream";
  routing?: RoutingDecision;
  activationLatencyMs?: number;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  lineElapsedMs: number[];
  durationMs: number;
}

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RunPairedHostOptions {
  root: string;
  protocol: PairedHostProtocol;
  outputManifest?: string;
  hostExecutable?: string;
  hostArgumentsPrefix?: string[];
  timeoutMs?: number;
  dryRun?: boolean;
}

function hashNumber(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 12), 16);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === "string") return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  const candidate = record(value);
  return candidate ? Object.values(candidate).some(containsAbsolutePath) : false;
}

function routingFromToolResult(item: Record<string, unknown>): RoutingDecision | undefined {
  if (item.type !== "mcp_tool_call" || item.server !== "tokengraph" || item.tool !== "tokengraph_prepare_context") return undefined;
  const result = record(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type !== "text" || typeof candidate.text !== "string") continue;
    try {
      const payload = record(JSON.parse(candidate.text));
      const routing = record(payload?.routing);
      if (!routing) continue;
      if (typeof routing.useTokenGraph !== "boolean" || (routing.stage !== 0 && routing.stage !== 1) ||
        typeof routing.reason !== "string" || !routing.reason ||
        typeof routing.expectedOverheadTokens !== "number" || !Number.isFinite(routing.expectedOverheadTokens) || routing.expectedOverheadTokens < 0 ||
        !["none", "low", "medium", "high"].includes(String(routing.expectedBenefit)) || typeof routing.enforced !== "boolean") continue;
      return routing as unknown as RoutingDecision;
    } catch {
      continue;
    }
  }
  return undefined;
}

function rawReadCommand(command: unknown): boolean {
  return typeof command === "string" && /(?:^|\s)(?:Get-Content|type|cat|sed\s+-n)(?:\s|$)/i.test(command);
}

export function parseCodexJsonl(raw: string, options: { modelIdentifier: string; hostVersion: string; allowMissingUsageOnFailure?: boolean; lineElapsedMs?: number[] }): ParsedCodexJsonl {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let usage: ParsedCodexJsonl["usage"];
  let finalStatus: "completed" | "failed" | undefined;
  let failureClass: ParsedCodexJsonl["failureClass"];
  let toolCalls = 0;
  let fallbackRawReads = 0;
  let routing: RoutingDecision | undefined;
  let activationLatencyMs: number | undefined;
  const startedMcpCalls = new Map<string, number>();

  for (const [index, line] of lines.entries()) {
    let event: Record<string, unknown>;
    try {
      const parsed = record(JSON.parse(line));
      if (!parsed || typeof parsed.type !== "string") throw new Error("shape");
      event = parsed;
    } catch {
      throw new Error("Codex JSONL contains an invalid host event.");
    }
    const item = record(event.item);
    if (event.type === "item.started" && item?.type === "mcp_tool_call" && typeof item.id === "string") {
      startedMcpCalls.set(item.id, options.lineElapsedMs?.[index] ?? index);
    }
    if (event.type === "item.completed" && item) {
      if (item.type === "command_execution" || item.type === "mcp_tool_call") toolCalls += 1;
      if (item.type === "command_execution" && rawReadCommand(item.command)) fallbackRawReads += 1;
      const observedRouting = routingFromToolResult(item);
      if (observedRouting) {
        routing = observedRouting;
        if (typeof item.id === "string" && startedMcpCalls.has(item.id)) {
          const completedAt = options.lineElapsedMs?.[index] ?? index;
          activationLatencyMs = completedAt - startedMcpCalls.get(item.id)!;
        }
      }
    }
    if (event.type === "turn.completed") {
      const candidate = record(event.usage);
      const inputTokens = nonNegativeInteger(candidate?.input_tokens);
      const cachedInputTokens = nonNegativeInteger(candidate?.cached_input_tokens);
      const outputTokens = nonNegativeInteger(candidate?.output_tokens);
      const reasoningOutputTokens = nonNegativeInteger(candidate?.reasoning_output_tokens);
      if (inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined || reasoningOutputTokens === undefined || cachedInputTokens > inputTokens) {
        throw new Error("Codex completed without exact host-reported usage.");
      }
      usage = { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens: inputTokens + outputTokens };
      finalStatus = "completed";
    } else if (event.type === "turn.failed") {
      finalStatus = "failed";
      failureClass = "host-turn-failed";
    } else if (event.type === "error") {
      finalStatus = "failed";
      failureClass = "host-stream-error";
    }
  }
  if (!finalStatus) throw new Error("Codex JSONL has no terminal host status.");
  if (!usage && !(finalStatus === "failed" && options.allowMissingUsageOnFailure)) throw new Error("Codex JSONL has no exact host-reported usage.");
  return {
    modelIdentifier: options.modelIdentifier,
    hostVersion: options.hostVersion,
    ...(usage ? { usage } : {}),
    toolCalls,
    fallbackRawReads,
    finalStatus,
    ...(failureClass ? { failureClass } : {}),
    ...(routing ? { routing } : {}),
    ...(activationLatencyMs !== undefined ? { activationLatencyMs } : {})
  };
}

export function planPairedHostRuns(tasks: EvaluationTask[], runsPerTask: number, seed: string): PlannedHostRun[] {
  if (!Number.isInteger(runsPerTask) || runsPerTask < 1) throw new Error("runsPerTask must be a positive integer.");
  const planned: PlannedHostRun[] = [];
  for (const task of [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    for (let repeat = 1; repeat <= runsPerTask; repeat += 1) {
      const conditionOrder = hashNumber(`${seed}:${task.taskId}:${repeat}`) % 2 === 0 ? "on-first" as const : "off-first" as const;
      const conditions: Array<"on" | "off"> = conditionOrder === "on-first" ? ["on", "off"] : ["off", "on"];
      for (const condition of conditions) planned.push({ taskId: task.taskId, category: task.category, repeat, condition, conditionOrder });
    }
  }
  return planned;
}

function assertProtocol(value: unknown): PairedHostProtocol {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== 1 || typeof candidate.evaluationId !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(candidate.evaluationId) ||
    typeof candidate.seed !== "string" || !candidate.seed || !record(candidate.model) || !record(candidate.plugin) || !record(candidate.promptTemplate) ||
    !record(candidate.tokenGraphMcp) || !record(candidate.acceptance) || !record(candidate.protocol) || !Array.isArray(candidate.tasks) || candidate.tasks.some((task) => !record(task))) {
    throw new Error("Paired host protocol schema is invalid.");
  }
  const typed = value as PairedHostProtocol;
  if ((typed.reviewed !== undefined && typeof typed.reviewed !== "boolean") ||
    !typed.tasks.length || new Set(typed.tasks.map((task) => task.taskId)).size !== typed.tasks.length ||
    typeof typed.model.identifier !== "string" || !typed.model.identifier || typeof typed.model.versionOrDate !== "string" || !typed.model.versionOrDate ||
    typeof typed.reasoningLevel !== "string" || !typed.reasoningLevel || !["read-only", "workspace-write"].includes(typed.sandbox) ||
    typeof typed.repositoryCommit !== "string" || !/^[a-f0-9]{7,40}$/i.test(typed.repositoryCommit) || typeof typed.plugin.version !== "string" || !typed.plugin.version || typeof typed.plugin.commit !== "string" || !/^[a-f0-9]{40}$/i.test(typed.plugin.commit) ||
    typeof typed.promptTemplate.identifier !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(typed.promptTemplate.identifier) || typeof typed.promptTemplate.template !== "string" || typed.promptTemplate.template.length > 20_000 || !typed.promptTemplate.template.includes("{{task}}") ||
    typeof typed.tokenGraphMcp.command !== "string" || !typed.tokenGraphMcp.command || !Array.isArray(typed.tokenGraphMcp.args) || typed.tokenGraphMcp.args.some((entry) => typeof entry !== "string") ||
    typeof typed.acceptance.command !== "string" || !typed.acceptance.command || !Array.isArray(typed.acceptance.args) || typed.acceptance.args.some((entry) => typeof entry !== "string") ||
    typeof typed.cacheState !== "string" || !typed.cacheState || !["cold", "warm"].includes(typed.indexState) ||
    !typed.toolConfiguration || typeof typed.toolConfiguration !== "object" || Array.isArray(typed.toolConfiguration) || containsAbsolutePath(typed.toolConfiguration) ||
    (typed.tokenGraphMcp.env && Object.entries(typed.tokenGraphMcp.env).some(([key, entry]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof entry !== "string")) ||
    !Number.isInteger(typed.protocol.runsPerTask) || typed.protocol.runsPerTask < 1 ||
    !Number.isInteger(typed.protocol.minimumPerCategorySamples) || typed.protocol.minimumPerCategorySamples < 10 ||
    ![typed.protocol.qualityNonInferiorityMargin, typed.protocol.tokenSuperiorityMinimum, typed.protocol.resourceLimit, typed.protocol.executionMedianMinimum, typed.protocol.executionP25Minimum]
      .every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0) ||
    typeof typed.protocol.routerRateMaximum !== "number" || !Number.isFinite(typed.protocol.routerRateMaximum) || typed.protocol.routerRateMaximum <= 0 || typed.protocol.routerRateMaximum > 0.1 ||
    typeof typed.protocol.nonNegativeActivatedMinimum !== "number" || !Number.isFinite(typed.protocol.nonNegativeActivatedMinimum) || typed.protocol.nonNegativeActivatedMinimum < 0.8 || typed.protocol.nonNegativeActivatedMinimum > 1 ||
    typed.tasks.some((task) => typeof task.taskId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(task.taskId) || typeof task.category !== "string" || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(task.category) || typeof task.prompt !== "string" || !task.prompt || task.prompt.length > 50_000 || !["none", "low", "medium", "high"].includes(task.expectedBenefit) || !["activate", "bypass"].includes(task.expectedRouting) || ((task.expectedRouting === "bypass") !== (task.expectedBenefit === "none")))) {
    throw new Error("Paired host protocol fields are invalid.");
  }
  return typed;
}

export async function loadPairedHostProtocol(path: string): Promise<PairedHostProtocol> {
  return assertProtocol(JSON.parse(await readFile(path, "utf8")));
}

function beneath(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, stdin?: string): Promise<ProcessResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    const lineElapsedMs: number[] = [];
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
      }
      pendingLine += chunk;
      while (pendingLine.includes("\n")) {
        const newline = pendingLine.indexOf("\n");
        pendingLine = pendingLine.slice(newline + 1);
        lineElapsedMs.push(performance.now() - startedAt);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
      }
    });
    child.once("error", (error) => { clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer); rejectPromise(error); });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (pendingLine.trim()) lineElapsedMs.push(performance.now() - startedAt);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, outputLimitExceeded, lineElapsedMs, durationMs: performance.now() - startedAt });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, root, 30_000);
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed.`);
  return result.stdout.trim();
}

async function ensureLocalRunExclusion(root: string): Promise<void> {
  const pathValue = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  const path = isAbsolute(pathValue) ? pathValue : resolve(root, pathValue);
  const current = await readFile(path, "utf8").catch(() => "");
  if (!current.split(/\r?\n/).includes(".tokengraph/")) await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.tokengraph/\n`);
}

function renderPrompt(template: string, task: PairedHostTask): string {
  return template.replaceAll("{{task}}", task.prompt);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function resolveMcp(root: string, mcp: PairedHostProtocol["tokenGraphMcp"]): PairedHostProtocol["tokenGraphMcp"] {
  return {
    command: mcp.command,
    args: mcp.args.map((arg) => arg.endsWith(".js") && !isAbsolute(arg) ? resolve(root, arg) : arg),
    ...(mcp.env ? { env: mcp.env } : {})
  };
}

function measureRouting(task: PairedHostTask, indexState: "cold" | "warm"): { decision: RoutingDecision; latencyMs: number } {
  const startedAt = performance.now();
  const decision = adviseRouting({ task: task.prompt, routingMode: "shadow", indexAvailable: indexState === "warm" });
  return { decision, latencyMs: performance.now() - startedAt };
}

function routingObservation(task: PairedHostTask, measured: { decision: RoutingDecision; latencyMs: number }, parsed: ParsedCodexJsonl): RouterShadowObservation {
  const actual = parsed.routing ?? measured.decision;
  const decision = actual.useTokenGraph ? "activate" as const : "bypass" as const;
  if (decision === "activate" && (!parsed.routing || parsed.activationLatencyMs === undefined || parsed.activationLatencyMs <= measured.latencyMs)) {
    throw new Error("ON run did not emit monotonic TokenGraph activation evidence.");
  }
  return {
    mode: "shadow",
    decision,
    stage: actual.stage,
    reason: actual.reason,
    expectedOverheadTokens: actual.expectedOverheadTokens,
    expectedBenefit: actual.expectedBenefit,
    expectedRouting: task.expectedRouting,
    routingLatencyMs: measured.latencyMs,
    ...(decision === "activate" ? { activationLatencyMs: parsed.activationLatencyMs! } : {}),
    falseBypass: task.expectedRouting === "activate" && decision === "bypass",
    falseActivation: task.expectedRouting === "bypass" && decision === "activate"
  };
}

function reviewedTrace(run: PlannedHostRun, task: PairedHostTask, parsed: ParsedCodexJsonl, acceptance: ProcessResult, commandHash: string, measuredRouting?: { decision: RoutingDecision; latencyMs: number }): HostTrace {
  if (!parsed.usage) throw new Error("Cannot emit a reviewed trace without exact host usage.");
  const acceptancePassed = acceptance.exitCode === 0 && !acceptance.timedOut;
  return {
    taskId: run.taskId,
    category: run.category,
    condition: run.condition,
    repeat: run.repeat,
    conditionOrder: run.conditionOrder,
    usageSource: "host",
    acceptance: { status: acceptancePassed ? "passed" : "failed", commandHash },
    tokens: parsed.usage.totalTokens,
    executionInclusiveTokens: parsed.usage.totalTokens,
    inputTokens: parsed.usage.inputTokens,
    cachedInputTokens: parsed.usage.cachedInputTokens,
    outputTokens: parsed.usage.outputTokens,
    reasoningOutputTokens: parsed.usage.reasoningOutputTokens,
    toolCalls: parsed.toolCalls,
    fallbackRawReads: parsed.fallbackRawReads,
    quality: acceptancePassed ? 1 : 0,
    timedOut: false,
    failed: parsed.finalStatus !== "completed" || !acceptancePassed,
    resourceUnits: parsed.toolCalls,
    ...(run.condition === "on" && measuredRouting ? { routing: routingObservation(task, measuredRouting, parsed) } : {})
  };
}

export async function runPairedHostEvaluation(options: RunPairedHostOptions): Promise<{ manifest: PairedEvaluationManifest | null; plan: PlannedHostRun[]; hostVersion: string }> {
  const root = resolve(options.root);
  const protocol = assertProtocol(options.protocol);
  const commit = await git(root, ["rev-parse", `${protocol.repositoryCommit}^{commit}`]);
  if (!commit.toLowerCase().startsWith(protocol.repositoryCommit.toLowerCase())) throw new Error("Protocol repository commit is not exact.");
  const plan = planPairedHostRuns(protocol.tasks, protocol.protocol.runsPerTask, protocol.seed);
  const hostExecutable = options.hostExecutable ?? "codex";
  const hostArgumentsPrefix = options.hostArgumentsPrefix ?? [];
  const version = await runProcess(hostExecutable, [...hostArgumentsPrefix, "--version"], root, 10_000);
  if (version.exitCode !== 0 || !/^codex-cli\s+\S+/i.test(version.stdout.trim())) throw new Error("Codex host version could not be verified.");
  const hostVersion = version.stdout.trim();
  if (options.dryRun) return { manifest: null, plan, hostVersion };
  if (!options.outputManifest) throw new Error("An output manifest path is required for a live host evaluation.");

  await ensureLocalRunExclusion(root);
  const evaluationRoot = resolve(root, ".tokengraph", "runs", "paired-host", protocol.evaluationId);
  const worktreeRoot = resolve(evaluationRoot, "worktrees");
  const rawRoot = resolve(evaluationRoot, "raw");
  const normalizedRoot = resolve(evaluationRoot, "normalized");
  if (!beneath(root, evaluationRoot) || !beneath(evaluationRoot, worktreeRoot)) throw new Error("Paired host storage escaped its verified root.");
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(rawRoot, { recursive: true });
  await mkdir(normalizedRoot, { recursive: true });
  const traces: HostTrace[] = [];
  const acceptanceHash = sha256(JSON.stringify([protocol.acceptance.command, ...protocol.acceptance.args]));
  const resolvedMcp = resolveMcp(root, protocol.tokenGraphMcp);

  for (const run of plan) {
    const task = protocol.tasks.find((candidate) => candidate.taskId === run.taskId)!;
    const runName = `${run.taskId}-repeat-${run.repeat}-${run.condition}`;
    const worktree = resolve(worktreeRoot, runName);
    if (!beneath(worktreeRoot, worktree)) throw new Error("Generated worktree escaped its verified root.");
    await git(root, ["worktree", "add", "--detach", worktree, commit]);
    let durable = false;
    try {
      const args = [
        ...hostArgumentsPrefix,
        "exec", "--json", "--ephemeral", "--ignore-user-config",
        "--model", protocol.model.identifier,
        "--sandbox", protocol.sandbox,
        "--cd", worktree,
        "--config", `model_reasoning_effort=${tomlString(protocol.reasoningLevel)}`
      ];
      if (run.condition === "on") {
        args.push("--config", `mcp_servers.tokengraph.command=${tomlString(resolvedMcp.command)}`);
        args.push("--config", `mcp_servers.tokengraph.args=${tomlArray(resolvedMcp.args)}`);
        if (resolvedMcp.env) {
          const env = `{${Object.entries(resolvedMcp.env).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${tomlString(value)}`).join(",")}}`;
          args.push("--config", `mcp_servers.tokengraph.env=${env}`);
        }
      }
      args.push("-");
      const measuredRouting = run.condition === "on" ? measureRouting(task, protocol.indexState) : undefined;
      const host = await runProcess(hostExecutable, args, worktree, options.timeoutMs ?? 30 * 60_000, `${renderPrompt(protocol.promptTemplate.template, task)}\n`);
      const rawPath = resolve(rawRoot, `${runName}.jsonl`);
      await writeFile(rawPath, host.stdout);
      let parsed: ParsedCodexJsonl | undefined;
      let parseFailure: "invalid-host-stream" | undefined;
      try {
        parsed = parseCodexJsonl(host.stdout, {
          modelIdentifier: protocol.model.identifier,
          hostVersion,
          allowMissingUsageOnFailure: true,
          lineElapsedMs: host.lineElapsedMs
        });
      } catch {
        parseFailure = "invalid-host-stream";
      }
      const acceptance = await runProcess(protocol.acceptance.command, protocol.acceptance.args, worktree, Math.min(options.timeoutMs ?? 30 * 60_000, 10 * 60_000));
      const normalized = {
        schemaVersion: 1,
        taskId: run.taskId,
        repeat: run.repeat,
        condition: run.condition,
        host: { exitCode: host.exitCode, timedOut: host.timedOut, outputLimitExceeded: host.outputLimitExceeded, durationMs: host.durationMs, finalStatus: parsed?.finalStatus ?? "failed", failureClass: parsed?.failureClass ?? parseFailure ?? null },
        acceptance: { exitCode: acceptance.exitCode, timedOut: acceptance.timedOut, commandHash: acceptanceHash }
      };
      await writeFile(resolve(normalizedRoot, `${runName}.json`), `${JSON.stringify(normalized, null, 2)}\n`);
      durable = true;
      if (host.timedOut || host.outputLimitExceeded || host.exitCode !== 0 || !parsed?.usage) throw new Error(`${runName} did not produce a complete exact-usage host trace.`);
      traces.push(reviewedTrace(run, task, parsed, acceptance, acceptanceHash, measuredRouting));
    } finally {
      if (durable) {
        await git(root, ["worktree", "remove", "--force", worktree]).catch(async () => {
          if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe worktree cleanup.");
          await rm(worktree, { recursive: true, force: true });
          await git(root, ["worktree", "prune"]);
        });
      }
    }
  }

  const manifest = parseEvaluationManifest({
    schemaVersion: 2,
    evidenceSource: "real-host",
    reviewed: protocol.reviewed === true,
    generatedAt: new Date().toISOString(),
    seed: protocol.seed,
    model: protocol.model,
    reasoningLevel: protocol.reasoningLevel,
    host: { name: "codex", version: hostVersion },
    plugin: protocol.plugin,
    repositoryCommit: commit,
    promptTemplate: protocol.promptTemplate.identifier,
    promptTemplateHash: sha256(protocol.promptTemplate.template),
    toolConfiguration: protocol.toolConfiguration,
    cacheState: protocol.cacheState,
    indexState: protocol.indexState,
    protocol: protocol.protocol,
    tasks: protocol.tasks.map(({ taskId, category, expectedQuality }) => ({ taskId, category, ...(expectedQuality !== undefined ? { expectedQuality } : {}) })),
    traces
  });
  const outputManifest = resolve(options.outputManifest);
  if (!beneath(root, outputManifest)) throw new Error("Reviewed manifest must remain beneath the evaluation root.");
  await mkdir(dirname(outputManifest), { recursive: true });
  await writeFile(outputManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, plan, hostVersion };
}
