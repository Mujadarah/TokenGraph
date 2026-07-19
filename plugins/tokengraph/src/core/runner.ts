import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalPersistenceLockKey, quarantineCorruptJson, withFileLock, writeJsonAtomic } from "./storage.js";
import { runPath, runsDir } from "./persistence.js";
import { createTaskOutcome, type TaskOutcome } from "./memoryCore.js";
import type { RepositoryIdentity } from "./types.js";

export interface RunnerOptions {
  root: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  terminateGraceMs?: number;
  metadata?: { test?: string; file?: string; errorClass?: string };
}

export interface SavedRun {
  runId: string;
  root: string;
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed" | "timed-out" | "cancelled";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  binaryOutput?: boolean;
  metadata?: RunnerOptions["metadata"];
}

export interface SavedRunSummary {
  runId: string;
  status: SavedRun["status"];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  firstError?: string;
  repeatCount: number;
  tests: string[];
  stackFrames: string[];
  locations: string[];
}

const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*([:=])\s*[^\s]+/gi,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g
];
const INTERACTIVE_COMMANDS = new Set(["ssh", "vim", "vi", "nano", "less", "more", "top", "htop", "pwsh", "powershell"]);

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, (match, separator?: string) => separator ? `[REDACTED]${separator}[REDACTED]` : "[REDACTED]"), value);
}

function compactRepeatedLines(value: string): string {
  const lines = value.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    output.push(lines[index]);
    if (count > 3) output.push(`[repeated line x${count}]`);
    index = end;
  }
  return output.join("\n");
}

class StreamCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;
  private binary = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.includes(0)) this.binary = true;
    if (this.bytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.bytes;
    const selected = chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(selected));
    this.bytes += selected.length;
    if (selected.length < chunk.length) this.truncated = true;
  }

  get hasBinary(): boolean { return this.binary; }

  finish(): { text: string; truncated: boolean } {
    const raw = redact(compactRepeatedLines(Buffer.concat(this.chunks).toString("utf8").replace(ANSI_PATTERN, "")));
  const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes <= this.maxBytes && !this.truncated) return { text: raw, truncated: false };
  const buffer = Buffer.from(raw, "utf8");
    return { text: `${buffer.subarray(0, Math.max(0, this.maxBytes - 32)).toString("utf8")}\n[truncated]`, truncated: true };
  }
}

function validateCommand(command: string, interactive: boolean): void {
  if (!command.trim()) throw new Error("Runner command is required.");
  if (!interactive && INTERACTIVE_COMMANDS.has(command.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/, ""))) {
    throw new Error("Interactive commands are refused unless interactive mode is explicitly enabled.");
  }
}

export function redactRunnerArguments(args: string[]): string[] {
  return args.map((arg) => redact(arg));
}

export function taskOutcomeFromRun(
  run: SavedRun,
  taskId: string,
  identity: RepositoryIdentity
): TaskOutcome {
  const command = redactRunnerArguments([run.command, ...run.args]).join(" ");
  return createTaskOutcome({
    id: `run-${run.runId}`,
    taskId,
    summary: `${command} -> ${run.status} (exit ${run.exitCode ?? "null"})`,
    evidence: [`run:${run.runId}`, `exit-code:${run.exitCode ?? "null"}`, `runner-status:${run.status}`],
    createdAt: run.finishedAt,
    branch: identity.branch,
    worktreeId: identity.worktreeId,
    headCommit: identity.headCommit,
    provenance: "runner"
  });
}

function inferRunMetadata(stdout: string, stderr: string): NonNullable<SavedRun["metadata"]> | undefined {
  const combined = `${stderr}\n${stdout}`;
  const errorClass = combined.match(/\b([A-Z][A-Za-z0-9_$]*(?:Error|Exception))\b/)?.[1];
  const file = combined.match(/((?:[A-Za-z]:[\\/])?(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+):\d+(?::\d+)?/)?.[1]?.replaceAll("\\", "/");
  const test = combined.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(?:FAIL|FAILED)\s+\S/i.test(line))?.replace(/^(?:FAIL|FAILED)\s+/i, "");
  const metadata = { ...(test ? { test } : {}), ...(file ? { file } : {}), ...(errorClass ? { errorClass } : {}) };
  return Object.keys(metadata).length ? metadata : undefined;
}

export async function executeRun(options: RunnerOptions, signal?: AbortSignal): Promise<SavedRun> {
  const interactive = options.interactive === true;
  validateCommand(options.command, interactive);
  if (interactive) throw new Error("Interactive runner mode is not supported by the bounded capture interface.");
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? 64 * 1024, 1024 * 1024));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 120_000, 15 * 60_000));
  const terminateGraceMs = Math.max(100, Math.min(options.terminateGraceMs ?? 2_000, 15_000));
  const startedAt = new Date();
  const stdout = new StreamCapture(maxBytes);
  const stderr = new StreamCapture(maxBytes);
  const child = spawn(options.command, options.args ?? [], { cwd: options.root, env: options.env ? { ...process.env, ...options.env } : process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let binaryOutput = false;
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  let timedOut = false;
  let cancelled = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    escalationTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    }, terminateGraceMs);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  const abort = () => { cancelled = true; terminate(); };
  signal?.addEventListener("abort", abort, { once: true });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
  }).finally(() => {
    clearTimeout(timer);
    if (escalationTimer) clearTimeout(escalationTimer);
    signal?.removeEventListener("abort", abort);
  });
  const stdoutCapture = stdout.finish();
  const stderrCapture = stderr.finish();
  binaryOutput = stdout.hasBinary || stderr.hasBinary;
  if (binaryOutput) stderrCapture.text = `${stderrCapture.text}\n[binary output refused]`;
  const inferredMetadata = inferRunMetadata(stdoutCapture.text, stderrCapture.text);
  const metadata = inferredMetadata || options.metadata ? { ...(inferredMetadata ?? {}), ...(options.metadata ?? {}) } : undefined;
  return {
    runId: randomUUID(), root: options.root, command: options.command, args: redactRunnerArguments(options.args ?? []),
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    status: cancelled ? "cancelled" : timedOut ? "timed-out" : binaryOutput ? "failed" : result.code === 0 ? "completed" : "failed",
    exitCode: result.code, signal: result.signal, timedOut,
    stdout: stdoutCapture.text, stderr: stderrCapture.text, stdoutTruncated: stdoutCapture.truncated, stderrTruncated: stderrCapture.truncated,
    ...(binaryOutput ? { binaryOutput: true } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export async function saveRun(root: string, run: SavedRun): Promise<void> {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "runs", `${run.runId}.json`);
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(runPath(root, run.runId), run));
}

export async function loadRun(root: string, runId: string): Promise<SavedRun | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runPath(root, runId), "utf8")) as SavedRun;
    return parsed && parsed.runId === runId && parsed.root === root ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) { await quarantineCorruptJson(runPath(root, runId)); return undefined; }
    throw error;
  }
}

export function summarizeRun(run: SavedRun): SavedRunSummary {
  const combined = `${run.stderr}\n${run.stdout}`;
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstError = lines.find((line) => /\b(error|failed|failure|exception)\b/i.test(line));
  const tests = lines.filter((line) => /(?:test|spec)\b|\b(pass|fail)ed\b/i.test(line)).slice(0, 20);
  const stackFrames = lines.filter((line) => /^\s*at\s+|\bat\s+.+:\d+:\d+/.test(line)).slice(0, 20);
  const locations = lines.map((line) => line.match(/[^\s:()]+:\d+(?::\d+)?/)?.[0]).filter((value): value is string => Boolean(value)).slice(0, 20);
  const repeatCount = lines.length - new Set(lines).size;
  return {
    runId: run.runId,
    status: run.status,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    ...(firstError ? { firstError } : {}),
    repeatCount,
    tests,
    stackFrames,
    locations
  };
}

export async function querySavedRuns(root: string, selector: { test?: string; file?: string; errorClass?: string } = {}): Promise<SavedRun[]> {
  const entries = await readdir(runsDir(root)).catch((error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
  const runs = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) => loadRun(root, entry.slice(0, -5))));
  return runs.filter((run): run is SavedRun => Boolean(run) && Object.entries(selector).every(([key, value]) => run?.metadata?.[key as keyof NonNullable<SavedRun["metadata"]>] === value)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function purgeRuns(root: string, before?: Date): Promise<string[]> {
  const entries = await readdir(runsDir(root)).catch((error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
  const removed: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const runId = entry.slice(0, -5);
    const run = await loadRun(root, runId);
    if (run && (!before || new Date(run.finishedAt) < before)) { await rm(join(runsDir(root), entry), { force: true }); removed.push(runId); }
  }
  return removed;
}
