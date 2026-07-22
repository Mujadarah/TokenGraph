import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import type { ExpectedBenefit, RoutingDecision } from "./artifact.js";
import type { EvaluationTask, HostTrace, PairedEvaluationManifest, PairedEvaluationProtocol, RouterShadowObservation } from "./pairedEval.js";
import { parseEvaluationManifest } from "./pairedEval.js";
import { adviseRouting } from "./routingAdvisor.js";
import { assertNoSymbolicLinkComponents, writeJsonAtomic, writeTextAtomic } from "./storage.js";

export interface PairedHostTask extends EvaluationTask {
  prompt: string;
  expectedBenefit: ExpectedBenefit;
  expectedRouting: "activate" | "bypass";
}

export interface PairedHostProtocol {
  schemaVersion: 2;
  evaluationId: string;
  seed: string;
  reviewed?: boolean;
  model: { identifier: string; versionOrDate: string };
  reasoningLevel: string;
  approvalPolicy: "never";
  windowsSandbox: "elevated";
  repositoryCommit: string;
  plugin: { version: string; commit: string };
  promptTemplate: { identifier: string; template: string };
  tokenGraphMcp: { command: string; args: string[]; env?: Record<string, string> };
  dependencySource?: string;
  acceptance: { verifierScript: string };
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
  acceptance?: { status: "passed" | "failed"; commandHash: string };
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  lineElapsedMs: number[];
  durationMs: number;
  spawnFailed: boolean;
}

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const ACCEPTANCE_COMMAND = "node .tokengraph-controller/acceptance.mjs";
const ALLOWED_MCP_ENVIRONMENT = new Set(["TOKENGRAPH_TOOL_SURFACE"]);

export interface RunPairedHostOptions {
  root: string;
  controllerRoot?: string;
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

function sha256(value: string | Buffer): string {
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

function matchesAcceptanceCommand(recorded: unknown, expected: string | undefined): boolean {
  if (typeof recorded !== "string" || expected === undefined) return false;
  if (recorded === expected) return true;
  const windowsWrapper = recorded.match(/^"[a-z]:\\{1,2}windows\\{1,2}system32\\{1,2}windowspowershell\\{1,2}v1\.0\\{1,2}powershell\.exe" -Command '([^'\r\n]*)'$/i);
  return windowsWrapper?.[1] === expected;
}

export function parseCodexJsonl(raw: string, options: { modelIdentifier: string; hostVersion: string; allowMissingUsageOnFailure?: boolean; lineElapsedMs?: number[]; acceptanceCommand?: string; acceptanceCommandHash?: string }): ParsedCodexJsonl {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let usage: ParsedCodexJsonl["usage"];
  let finalStatus: "completed" | "failed" | undefined;
  let failureClass: ParsedCodexJsonl["failureClass"];
  let toolCalls = 0;
  let fallbackRawReads = 0;
  let routing: RoutingDecision | undefined;
  let activationLatencyMs: number | undefined;
  let acceptanceMatches = 0;
  let acceptanceCommandPassed = false;
  let acceptanceInvalidated = false;
  let acceptanceCompletedAt: number | undefined;
  let successfulTerminalAt: number | undefined;
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
    if (event.type === "item.started" && item) {
      const mutationCapable = item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "todo_list";
      if (acceptanceCompletedAt !== undefined && mutationCapable) acceptanceInvalidated = true;
    }
    if (event.type === "item.started" && item?.type === "mcp_tool_call" && typeof item.id === "string") {
      startedMcpCalls.set(item.id, options.lineElapsedMs?.[index] ?? index);
    }
    if (event.type === "item.completed" && item) {
      const mutationCapable = item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "todo_list";
      const matchesAcceptance = item.type === "command_execution" && matchesAcceptanceCommand(item.command, options.acceptanceCommand);
      if (acceptanceMatches > 0 && mutationCapable) acceptanceInvalidated = true;
      if (matchesAcceptance) {
        acceptanceMatches += 1;
        acceptanceCommandPassed = item.status === "completed" && item.exit_code === 0;
        acceptanceCompletedAt = index;
      }
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
      if (finalStatus !== "failed") {
        finalStatus = "completed";
        successfulTerminalAt = index;
      }
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
    ...(options.acceptanceCommand && options.acceptanceCommandHash ? {
      acceptance: {
        status: acceptanceMatches === 1 && acceptanceCommandPassed && !acceptanceInvalidated && finalStatus === "completed" &&
          acceptanceCompletedAt !== undefined && successfulTerminalAt !== undefined && successfulTerminalAt > acceptanceCompletedAt ? "passed" as const : "failed" as const,
        commandHash: options.acceptanceCommandHash
      }
    } : {}),
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
  if (!candidate || candidate.schemaVersion !== 2 || typeof candidate.evaluationId !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(candidate.evaluationId) ||
    typeof candidate.seed !== "string" || !candidate.seed || !record(candidate.model) || !record(candidate.plugin) || !record(candidate.promptTemplate) ||
    !record(candidate.tokenGraphMcp) || !record(candidate.acceptance) || !record(candidate.protocol) || !Array.isArray(candidate.tasks) || candidate.tasks.some((task) => !record(task))) {
    throw new Error("Paired host protocol schema is invalid.");
  }
  const typed = value as PairedHostProtocol;
  if ((typed.reviewed !== undefined && typeof typed.reviewed !== "boolean") ||
    !typed.tasks.length || new Set(typed.tasks.map((task) => task.taskId)).size !== typed.tasks.length ||
    typeof typed.model.identifier !== "string" || !typed.model.identifier || typeof typed.model.versionOrDate !== "string" || !typed.model.versionOrDate ||
    typeof typed.reasoningLevel !== "string" || !typed.reasoningLevel ||
    typed.approvalPolicy !== "never" ||
    typed.windowsSandbox !== "elevated" ||
    typeof typed.repositoryCommit !== "string" || !/^[a-f0-9]{7,40}$/i.test(typed.repositoryCommit) || typeof typed.plugin.version !== "string" || !typed.plugin.version || typeof typed.plugin.commit !== "string" || !/^[a-f0-9]{40}$/i.test(typed.plugin.commit) ||
    typeof typed.promptTemplate.identifier !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(typed.promptTemplate.identifier) || typeof typed.promptTemplate.template !== "string" || typed.promptTemplate.template.length > 20_000 || !typed.promptTemplate.template.includes("{{task}}") ||
    typeof typed.tokenGraphMcp.command !== "string" || !approvedNodeCommand(typed.tokenGraphMcp.command) || !Array.isArray(typed.tokenGraphMcp.args) || typed.tokenGraphMcp.args.some((entry) => typeof entry !== "string") ||
    typeof typed.acceptance.verifierScript !== "string" || !typed.acceptance.verifierScript || isAbsolute(typed.acceptance.verifierScript) || typed.acceptance.verifierScript.split(/[\\/]/).includes("..") || !/\.[cm]?js$/i.test(typed.acceptance.verifierScript) ||
    (typed.dependencySource !== undefined && (typeof typed.dependencySource !== "string" || isAbsolute(typed.dependencySource) || typed.dependencySource.split(/[\\/]/).includes(".."))) ||
    typeof typed.cacheState !== "string" || !typed.cacheState || !["cold", "warm"].includes(typed.indexState) ||
    !typed.toolConfiguration || typeof typed.toolConfiguration !== "object" || Array.isArray(typed.toolConfiguration) || containsAbsolutePath(typed.toolConfiguration) ||
    (typed.tokenGraphMcp.env && Object.entries(typed.tokenGraphMcp.env).some(([key, entry]) => !ALLOWED_MCP_ENVIRONMENT.has(key) || (key === "TOKENGRAPH_TOOL_SURFACE" && entry !== "core" && entry !== "full"))) ||
    !Number.isInteger(typed.protocol.runsPerTask) || typed.protocol.runsPerTask < 1 ||
    !Number.isInteger(typed.protocol.minimumPerCategorySamples) || typed.protocol.minimumPerCategorySamples < 10 ||
    ![typed.protocol.qualityNonInferiorityMargin, typed.protocol.tokenSuperiorityMinimum, typed.protocol.resourceLimit, typed.protocol.executionMedianMinimum, typed.protocol.executionP25Minimum]
      .every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0) ||
    typeof typed.protocol.routerRateMaximum !== "number" || !Number.isFinite(typed.protocol.routerRateMaximum) || typed.protocol.routerRateMaximum <= 0 || typed.protocol.routerRateMaximum > 0.1 ||
    typed.protocol.stage0LatencyMaximumMs !== 5 ||
    typeof typed.protocol.nonNegativeActivatedMinimum !== "number" || !Number.isFinite(typed.protocol.nonNegativeActivatedMinimum) || typed.protocol.nonNegativeActivatedMinimum < 0.8 || typed.protocol.nonNegativeActivatedMinimum > 1 ||
    typed.tasks.some((task) => typeof task.taskId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(task.taskId) || typeof task.category !== "string" || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(task.category) || typeof task.prompt !== "string" || !task.prompt || task.prompt.length > 50_000 || !["none", "low", "medium", "high"].includes(task.expectedBenefit) || !["activate", "bypass"].includes(task.expectedRouting) || ((task.expectedRouting === "bypass") !== (task.expectedBenefit === "none")))) {
    throw new Error("Paired host protocol fields are invalid.");
  }
  return typed;
}

function approvedNodeCommand(command: string): boolean {
  if (command === "node" || (process.platform === "win32" && command.toLowerCase() === "node.exe")) return true;
  if (!isAbsolute(command)) return false;
  const requested = resolve(command);
  const controllerRuntime = resolve(process.execPath);
  return process.platform === "win32" ? requested.toLowerCase() === controllerRuntime.toLowerCase() : requested === controllerRuntime;
}

export async function loadPairedHostProtocol(path: string): Promise<PairedHostProtocol> {
  return assertProtocol(JSON.parse(await readFile(path, "utf8")));
}

function beneath(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function runBoundedProcess(command: string, args: string[], cwd: string, timeoutMs: number, stdin?: string, environment?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return await new Promise((resolvePromise) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    const lineElapsedMs: number[] = [];
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let settled = false;
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
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({ exitCode: null, signal: null, stdout, stderr: "", timedOut, outputLimitExceeded, lineElapsedMs, durationMs: performance.now() - startedAt, spawnFailed: true });
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (pendingLine.trim()) lineElapsedMs.push(performance.now() - startedAt);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, outputLimitExceeded, lineElapsedMs, durationMs: performance.now() - startedAt, spawnFailed: false });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

const runProcess = runBoundedProcess;

function isolatedHostEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_PERMISSION_PROFILE", "CODEX_SHELL", "CODEX_THREAD_ID"]) delete environment[name];
  return environment;
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

function tomlInlineTable(entries: Array<[string, string]>): string {
  return `{${entries.map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(",")}}`;
}

function modelShellEnvironment(worktree: string): Record<string, string> {
  const temporaryDirectory = resolve(worktree, ".tokengraph-tmp");
  const pathValue = process.env.PATH ?? process.env.Path ?? dirname(process.execPath);
  const environment: Record<string, string> = process.platform === "win32"
    ? {
        PATH: pathValue,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
        COMSPEC: process.env.COMSPEC ?? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory
      }
    : {
        PATH: pathValue,
        HOME: resolve(worktree, ".tokengraph-home"),
        TMPDIR: temporaryDirectory,
        LANG: "C.UTF-8"
      };
  return environment;
}

function permissionFilesystem(gitCommonDirectory: string, dependencySource: string | undefined, mcpRuntimePaths: string[]): string {
  const workspaceRules = tomlInlineTable([
    [".", "write"],
    [".git", "read"],
    [".tokengraph-controller", "read"]
  ]);
  const rules = [
    `${tomlString(":root")}=${tomlString("deny")}`,
    `${tomlString(":minimal")}=${tomlString("read")}`,
    `${tomlString(":workspace_roots")}=${workspaceRules}`,
    `${tomlString(gitCommonDirectory)}=${tomlString("read")}`,
    ...(dependencySource ? [`${tomlString(dependencySource)}=${tomlString("read")}`] : []),
    ...[...new Set(mcpRuntimePaths)].map((path) => `${tomlString(path)}=${tomlString("read")}`)
  ];
  return `{${rules.join(",")}}`;
}

async function verifierSource(root: string, verifierScript: string): Promise<{ path: string; content: Buffer; commandHash: string }> {
  const requested = resolve(root, verifierScript);
  if (!beneath(root, requested)) throw new Error("Acceptance verifier escaped the supplied evaluation root.");
  const canonical = await realpath(requested);
  if (!beneath(root, canonical)) throw new Error("Acceptance verifier resolves outside the supplied evaluation root.");
  const metadata = await stat(canonical);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("Acceptance verifier must be a bounded regular file.");
  const content = await readFile(canonical);
  return { path: canonical, content, commandHash: sha256(content) };
}

async function installVerifier(worktree: string, verifier: { content: Buffer; commandHash: string }): Promise<void> {
  const directory = resolve(worktree, ".tokengraph-controller");
  const target = resolve(directory, "acceptance.mjs");
  await assertNoSymbolicLinkComponents(target);
  await mkdir(directory, { recursive: true });
  await assertNoSymbolicLinkComponents(target);
  try {
    const handle = await open(target, "wx", 0o400);
    try {
      await handle.writeFile(verifier.content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Acceptance verifier target already exists.");
    throw error;
  }
  if (sha256(await readFile(target)) !== verifier.commandHash) throw new Error("Copied acceptance verifier hash does not match its validated source.");
  await chmod(target, 0o444);
}

function acceptancePrompt(prompt: string): string {
  return `${prompt}\n\nAfter completing all edits and checks, run exactly this as the final mutation-capable command: ${ACCEPTANCE_COMMAND}\nDo not run any command, MCP tool, or file mutation after it. A final prose response is allowed.\n`;
}

function resolveMcp(root: string, mcp: PairedHostProtocol["tokenGraphMcp"]): PairedHostProtocol["tokenGraphMcp"] {
  return {
    command: process.execPath,
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

function reviewedTrace(run: PlannedHostRun, task: PairedHostTask, parsed: ParsedCodexJsonl, hostSucceeded: boolean, commandHash: string, measuredRouting?: { decision: RoutingDecision; latencyMs: number }): HostTrace {
  if (!parsed.usage) throw new Error("Cannot emit a reviewed trace without exact host usage.");
  const acceptancePassed = parsed.acceptance?.status === "passed" && parsed.acceptance.commandHash === commandHash;
  const successful = hostSucceeded && parsed.finalStatus === "completed" && acceptancePassed;
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
    quality: successful ? 1 : 0,
    timedOut: false,
    failed: !successful,
    resourceUnits: parsed.toolCalls,
    ...(run.condition === "on" && measuredRouting ? { routing: routingObservation(task, measuredRouting, parsed) } : {})
  };
}

function emptyProcessResult(): ProcessResult {
  return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false, lineElapsedMs: [], durationMs: 0, spawnFailed: false };
}

async function cleanupWorktree(root: string, worktreeRoot: string, worktree: string): Promise<void> {
  if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe worktree cleanup.");
  try {
    await git(root, ["worktree", "remove", "--force", worktree]);
  } catch {
    if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe worktree cleanup.");
    await rm(worktree, { recursive: true, force: true });
    await git(root, ["worktree", "prune"]);
    return;
  }
  try {
    await access(worktree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe residual cleanup.");
  await rm(worktree, { recursive: true, force: true });
}

async function durableRunArtifacts(
  rawPath: string,
  normalizedPath: string,
  worktree: string,
  run: PlannedHostRun,
  identity: { evaluationId: string; repositoryCommit: string }
): Promise<boolean> {
  try {
    const raw = await readFile(rawPath, "utf8");
    const normalized = record(JSON.parse(await readFile(normalizedPath, "utf8")));
    const marker = record(JSON.parse(await readFile(resolve(worktree, ".tokengraph-controller", "run.json"), "utf8")));
    return normalized?.schemaVersion === 2 && normalized.durable === true && marker?.schemaVersion === 1 &&
      typeof normalized.executionId === "string" && normalized.executionId.length > 0 && marker.executionId === normalized.executionId &&
      normalized.evaluationId === identity.evaluationId && marker.evaluationId === identity.evaluationId &&
      normalized.repositoryCommit === identity.repositoryCommit && marker.repositoryCommit === identity.repositoryCommit &&
      normalized.rawSha256 === sha256(raw) && normalized.taskId === run.taskId && marker.taskId === run.taskId &&
      normalized.repeat === run.repeat && marker.repeat === run.repeat && normalized.condition === run.condition && marker.condition === run.condition;
  } catch {
    return false;
  }
}

async function recoverStaleWorktree(
  root: string,
  worktreeRoot: string,
  worktree: string,
  rawPath: string,
  normalizedPath: string,
  run: PlannedHostRun,
  identity: { evaluationId: string; repositoryCommit: string }
): Promise<void> {
  try {
    await access(worktree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!await durableRunArtifacts(rawPath, normalizedPath, worktree, run, identity)) {
    throw new Error(`Refusing to remove non-durable stale worktree for ${run.taskId} repeat ${run.repeat} ${run.condition}.`);
  }
  await cleanupWorktree(root, worktreeRoot, worktree);
}

export async function runPairedHostEvaluation(options: RunPairedHostOptions): Promise<{ manifest: PairedEvaluationManifest | null; plan: PlannedHostRun[]; hostVersion: string }> {
  const root = resolve(options.root);
  const controllerRoot = resolve(options.controllerRoot ?? options.root);
  const protocol = assertProtocol(options.protocol);
  const commit = await git(root, ["rev-parse", `${protocol.repositoryCommit}^{commit}`]);
  if (!commit.toLowerCase().startsWith(protocol.repositoryCommit.toLowerCase())) throw new Error("Protocol repository commit is not exact.");
  const plan = planPairedHostRuns(protocol.tasks, protocol.protocol.runsPerTask, protocol.seed);
  const hostExecutable = options.hostExecutable ?? "codex";
  const hostArgumentsPrefix = options.hostArgumentsPrefix ?? [];
  const hostEnvironment = isolatedHostEnvironment();
  const verifier = await verifierSource(controllerRoot, protocol.acceptance.verifierScript);
  const version = await runProcess(hostExecutable, [...hostArgumentsPrefix, "--version"], root, 10_000, undefined, hostEnvironment);
  if (version.spawnFailed || version.exitCode !== 0 || !/^codex-cli\s+\S+/i.test(version.stdout.trim())) throw new Error("Codex host version could not be verified.");
  const hostVersion = version.stdout.trim();
  if (options.dryRun) return { manifest: null, plan, hostVersion };
  if (!options.outputManifest) throw new Error("An output manifest path is required for a live host evaluation.");
  const outputManifest = isAbsolute(options.outputManifest) ? resolve(options.outputManifest) : resolve(controllerRoot, options.outputManifest);
  if (!beneath(controllerRoot, outputManifest)) throw new Error("Reviewed manifest must remain beneath the controller root.");

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
  const gitCommonValue = await git(root, ["rev-parse", "--git-common-dir"]);
  const gitCommonDirectory = isAbsolute(gitCommonValue) ? resolve(gitCommonValue) : resolve(root, gitCommonValue);
  const dependencySource = protocol.dependencySource ? resolve(root, protocol.dependencySource) : undefined;
  const resolvedMcp = resolveMcp(controllerRoot, protocol.tokenGraphMcp);
  const pluginCommit = await git(controllerRoot, ["rev-parse", `${protocol.plugin.commit}^{commit}`]);
  if (pluginCommit.toLowerCase() !== protocol.plugin.commit.toLowerCase()) throw new Error("Protocol plugin commit is not exact.");
  const mcpRuntimePaths = resolvedMcp.args.filter(isAbsolute);
  for (const runtimePath of mcpRuntimePaths) {
    if (!beneath(controllerRoot, runtimePath)) throw new Error("TokenGraph MCP runtime must remain beneath the controller root.");
    const runtimeGitPath = relative(controllerRoot, runtimePath).split(sep).join("/");
    const trackedRuntime = await runProcess("git", ["cat-file", "-e", `${pluginCommit}:${runtimeGitPath}`], controllerRoot, 30_000);
    if (trackedRuntime.spawnFailed || trackedRuntime.exitCode !== 0) throw new Error("TokenGraph MCP runtime is not tracked by the attested plugin commit.");
    const runtimeDiff = await runProcess("git", ["diff", "--quiet", pluginCommit, "--", runtimeGitPath], controllerRoot, 30_000);
    if (runtimeDiff.spawnFailed || runtimeDiff.exitCode !== 0) throw new Error("TokenGraph MCP runtime does not match the attested plugin commit.");
  }

  for (const run of plan) {
    const task = protocol.tasks.find((candidate) => candidate.taskId === run.taskId)!;
    const runName = `${run.taskId}-repeat-${run.repeat}-${run.condition}`;
    const worktree = resolve(worktreeRoot, runName);
    const rawPath = resolve(rawRoot, `${runName}.jsonl`);
    const normalizedPath = resolve(normalizedRoot, `${runName}.json`);
    if (!beneath(worktreeRoot, worktree)) throw new Error("Generated worktree escaped its verified root.");
    const runIdentity = { evaluationId: protocol.evaluationId, repositoryCommit: commit };
    await recoverStaleWorktree(root, worktreeRoot, worktree, rawPath, normalizedPath, run, runIdentity);
    try {
      await git(root, ["worktree", "add", "--detach", worktree, commit]);
    } catch {
      const normalized = {
        schemaVersion: 2, durable: true, taskId: run.taskId, repeat: run.repeat, condition: run.condition,
        host: { exitCode: null, timedOut: false, outputLimitExceeded: false, durationMs: 0, finalStatus: "failed", failureClass: "worktree-create-failed" },
        acceptance: { status: "failed", commandHash: verifier.commandHash }
      };
      await writeTextAtomic(rawPath, "");
      await writeJsonAtomic(normalizedPath, normalized);
      throw new Error(`${runName} worktree creation failed.`);
    }
    let durable = false;
    const executionId = randomUUID();
    try {
      let phaseFailure: "evidence-provisioning-failed" | "dependency-provisioning-failed" | "acceptance-provisioning-failed" | undefined;
      try {
        await writeJsonAtomic(resolve(worktree, ".tokengraph-controller", "run.json"), {
          schemaVersion: 1,
          ...runIdentity,
          executionId,
          taskId: run.taskId,
          repeat: run.repeat,
          condition: run.condition
        });
      } catch {
        phaseFailure = "evidence-provisioning-failed";
      }
      if (!phaseFailure && protocol.dependencySource && dependencySource) {
        const dependencyTarget = resolve(worktree, protocol.dependencySource);
        try {
          if (!beneath(root, dependencySource) || !beneath(worktree, dependencyTarget)) throw new Error("Dependency provisioning escaped its verified root.");
          await access(dependencySource);
          await mkdir(dirname(dependencyTarget), { recursive: true });
          await symlink(dependencySource, dependencyTarget, process.platform === "win32" ? "junction" : "dir");
        } catch {
          phaseFailure = "dependency-provisioning-failed";
        }
      }
      if (!phaseFailure) {
        try {
          await installVerifier(worktree, verifier);
          await mkdir(resolve(worktree, ".tokengraph-tmp"), { recursive: true });
          if (process.platform !== "win32") await mkdir(resolve(worktree, ".tokengraph-home"), { recursive: true });
        } catch {
          phaseFailure = "acceptance-provisioning-failed";
        }
      }
      let host = emptyProcessResult();
      let parsed: ParsedCodexJsonl | undefined;
      let parseFailure: "invalid-host-stream" | undefined;
      const measuredRouting = run.condition === "on" ? measureRouting(task, protocol.indexState) : undefined;
      const args = [
        ...hostArgumentsPrefix,
        "exec", "--json", "--ephemeral", "--ignore-user-config",
        "--model", protocol.model.identifier,
        "--cd", worktree,
        "--config", `model_reasoning_effort=${tomlString(protocol.reasoningLevel)}`,
        "--config", `approval_policy=${tomlString(protocol.approvalPolicy)}`,
        "--config", `windows.sandbox=${tomlString(protocol.windowsSandbox)}`,
        "--config", `default_permissions=${tomlString("tokengraph-eval")}`,
        "--config", `permissions.tokengraph-eval.filesystem=${permissionFilesystem(gitCommonDirectory, dependencySource, mcpRuntimePaths)}`,
        "--config", "permissions.tokengraph-eval.network.enabled=false",
        "--config", `shell_environment_policy.inherit=${tomlString("none")}`,
        "--config", `shell_environment_policy.set=${tomlInlineTable(Object.entries(modelShellEnvironment(worktree)).sort(([left], [right]) => left.localeCompare(right)))}`
      ];
      if (run.condition === "on") {
        args.push("--config", `mcp_servers.tokengraph.command=${tomlString(resolvedMcp.command)}`);
        args.push("--config", `mcp_servers.tokengraph.args=${tomlArray(resolvedMcp.args)}`);
        const mcpEnvironment = { ...(resolvedMcp.env ?? {}), TOKENGRAPH_WORKSPACE_ROOT: worktree };
        args.push("--config", `mcp_servers.tokengraph.env=${tomlInlineTable(Object.entries(mcpEnvironment).sort(([left], [right]) => left.localeCompare(right)))}`);
      }
      args.push("-");
      if (!phaseFailure) {
        host = await runProcess(hostExecutable, args, worktree, options.timeoutMs ?? 30 * 60_000, acceptancePrompt(renderPrompt(protocol.promptTemplate.template, task)), hostEnvironment);
        try {
          parsed = parseCodexJsonl(host.stdout, {
            modelIdentifier: protocol.model.identifier,
            hostVersion,
            allowMissingUsageOnFailure: true,
            lineElapsedMs: host.lineElapsedMs,
            acceptanceCommand: ACCEPTANCE_COMMAND,
            acceptanceCommandHash: verifier.commandHash
          });
        } catch {
          parseFailure = "invalid-host-stream";
        }
      }
      let trace: HostTrace | undefined;
      let routingFailure: "routing-evidence-invalid" | undefined;
      if (!phaseFailure && !host.spawnFailed && !host.timedOut && !host.outputLimitExceeded && parsed?.usage) {
        try {
          trace = reviewedTrace(run, task, parsed, host.exitCode === 0, verifier.commandHash, measuredRouting);
        } catch {
          routingFailure = "routing-evidence-invalid";
        }
      }
      const failureClass = phaseFailure ??
        (host.spawnFailed ? "host-spawn-failed" : undefined) ??
        (host.timedOut ? "host-timeout" : undefined) ??
        (host.outputLimitExceeded ? "host-output-limit" : undefined) ??
        parseFailure ?? routingFailure ?? parsed?.failureClass ??
        (host.exitCode !== 0 ? "host-exit-nonzero" : undefined) ?? null;
      const normalized = {
        schemaVersion: 2,
        durable: true,
        ...runIdentity,
        executionId,
        rawSha256: sha256(host.stdout),
        taskId: run.taskId,
        repeat: run.repeat,
        condition: run.condition,
        host: { exitCode: host.exitCode, timedOut: host.timedOut, outputLimitExceeded: host.outputLimitExceeded, durationMs: host.durationMs, finalStatus: parsed?.finalStatus ?? "failed", failureClass },
        acceptance: { status: parsed?.acceptance?.status ?? "failed", commandHash: verifier.commandHash }
      };
      await writeTextAtomic(rawPath, host.stdout);
      await writeJsonAtomic(normalizedPath, normalized);
      durable = await durableRunArtifacts(rawPath, normalizedPath, worktree, run, runIdentity);
      if (!durable) throw new Error(`${runName} evidence artifacts are not durable.`);
      if (phaseFailure === "evidence-provisioning-failed") throw new Error(`${runName} evidence provisioning failed.`);
      if (phaseFailure === "dependency-provisioning-failed") throw new Error(`${runName} dependency provisioning failed.`);
      if (phaseFailure === "acceptance-provisioning-failed") throw new Error(`${runName} acceptance verifier provisioning failed.`);
      if (host.spawnFailed || host.timedOut || host.outputLimitExceeded || !parsed?.usage) throw new Error(`${runName} did not produce a complete exact-usage host trace.`);
      if (routingFailure || !trace) throw new Error(`${runName} routing evidence is invalid.`);
      traces.push(trace);
    } finally {
      if (durable) await cleanupWorktree(root, worktreeRoot, worktree);
    }
  }

  const manifest = parseEvaluationManifest({
    schemaVersion: 3,
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
  await mkdir(dirname(outputManifest), { recursive: true });
  await writeJsonAtomic(outputManifest, manifest);
  return { manifest, plan, hostVersion };
}
