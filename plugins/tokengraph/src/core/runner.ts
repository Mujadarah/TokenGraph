import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { canonicalPersistenceLock } from "./lockDomain.js";
import { quarantineCorruptJson, withFileLock, writeJsonAtomic } from "./storage.js";
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
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  stdoutBinary?: boolean;
  stderrBinary?: boolean;
  binaryOutput?: boolean;
  redaction?: RunnerRedactionMetadata;
  metadata?: RunnerOptions["metadata"];
}

export type RunnerRedactionCategory =
  | "sensitive-argument"
  | "credential-assignment"
  | "authorization-header"
  | "cookie-header"
  | "jwt"
  | "url-credentials"
  | "private-key"
  | "service-token"
  | "aws-access-key"
  | "credential-line";

export interface RunnerRedactionMetadata {
  categories: RunnerRedactionCategory[];
  withheldLineCount: number;
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
  redaction?: RunnerRedactionMetadata;
}

const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const INTERACTIVE_COMMANDS = new Set(["ssh", "vim", "vi", "nano", "less", "more", "top", "htop", "pwsh", "powershell"]);
const SENSITIVE_ARGUMENT_NAMES = new Set([
  "api-key", "apikey", "access-token", "auth-token", "authorization", "client-secret", "cookie",
  "password", "passwd", "refresh-token", "secret", "token"
]);
const SENSITIVE_ENVIRONMENT_NAME = /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|CLIENT_SECRET|DATABASE_URL|GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|PASSWORD|SLACK_TOKEN|TOKEN)$/i;
const SENSITIVE_HEADER_NAME = /^(?:authorization|cookie|proxy-authorization|set-cookie)$|(?:^|[-_])(?:api[-_]?key|credential|password|secret|token)(?:$|[-_])/i;
const CREDENTIAL_CONTEXT = /\b(?:api[ _-]?key|authorization|client[ _-]?secret|cookie|credential(?:s)?|password|private[ _-]?key)\b/i;

class RunnerSanitizer {
  private readonly categories = new Set<RunnerRedactionCategory>();
  private withheldLineCount = 0;

  constructor(private readonly prior?: RunnerRedactionMetadata) {}

  private replace(
    value: string,
    pattern: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string),
    category: RunnerRedactionCategory
  ): string {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return value;
    this.categories.add(category);
    pattern.lastIndex = 0;
    return value.replace(pattern, replacement as string);
  }

  sanitizeText(value: string): string {
    let sanitized = value.replace(ANSI_PATTERN, "");
    sanitized = this.replace(
      sanitized,
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi,
      "[REDACTED PRIVATE KEY]",
      "private-key"
    );
    return sanitized.split(/(\r?\n)/).map((line) => {
      if (/^\r?\n$/.test(line) || !line) return line;
      let result = line;
      result = this.replace(result, /\b(authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, "$1: [REDACTED]", "authorization-header");
      result = this.replace(result, /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]", "cookie-header");
      result = this.replace(result, /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@", "url-credentials");
      result = this.replace(result, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED]", "jwt");
      result = this.replace(result, /\b(?:npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]", "service-token");
      result = this.replace(result, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]", "aws-access-key");
      result = this.replace(
        result,
        /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|refresh[ _-]?token|secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`,
        "credential-assignment"
      );
      const unresolvedContext = result
        .replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*\[REDACTED\]/gi, "")
        .replace(/\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|refresh[ _-]?token|secret)\s*[:=]\s*\[REDACTED\]/gi, "")
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/\[REDACTED\]:\[REDACTED\]@/gi, "")
        .replace(/\[(?:REDACTED(?: PRIVATE KEY)?|WITHHELD CREDENTIAL LINE)\]/g, "");
      if (CREDENTIAL_CONTEXT.test(unresolvedContext)) {
        this.categories.add("credential-line");
        this.withheldLineCount += 1;
        return "[WITHHELD CREDENTIAL LINE]";
      }
      return result;
    }).join("");
  }

  sanitizeArguments(args: string[]): string[] {
    const sanitized: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      const normalizedName = argument.replace(/^--?/, "").toLowerCase().replaceAll("_", "-");
      if (SENSITIVE_ARGUMENT_NAMES.has(normalizedName) || SENSITIVE_ENVIRONMENT_NAME.test(argument)) {
        sanitized.push(argument);
        if (index + 1 < args.length) {
          sanitized.push("[REDACTED]");
          this.categories.add("sensitive-argument");
          index += 1;
        }
        continue;
      }
      if (argument === "--header" || argument === "-H") {
        sanitized.push(argument);
        if (index + 1 < args.length) {
          sanitized.push(this.sanitizeHeader(args[index + 1]!));
          index += 1;
        }
        continue;
      }
      const inlineHeader = argument.match(/^(--header|-H)=([\s\S]*)$/i);
      if (inlineHeader) {
        sanitized.push(`${inlineHeader[1]}=${this.sanitizeHeader(inlineHeader[2]!)}`);
        continue;
      }
      const inlineSwitch = argument.match(/^(--?)([^=]+)=(.*)$/s);
      if (inlineSwitch && SENSITIVE_ARGUMENT_NAMES.has(inlineSwitch[2]!.toLowerCase().replaceAll("_", "-"))) {
        sanitized.push(`${inlineSwitch[1]}${inlineSwitch[2]}=[REDACTED]`);
        this.categories.add("sensitive-argument");
        continue;
      }
      const environmentAssignment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (environmentAssignment && SENSITIVE_ENVIRONMENT_NAME.test(environmentAssignment[1]!)) {
        sanitized.push(`${environmentAssignment[1]}=[REDACTED]`);
        this.categories.add("sensitive-argument");
        continue;
      }
      sanitized.push(this.sanitizeText(argument));
    }
    return sanitized;
  }

  private sanitizeHeader(value: string): string {
    const header = value.match(/^\s*([^:]+)\s*:\s*([\s\S]*)$/);
    if (header && SENSITIVE_HEADER_NAME.test(header[1]!.trim())) {
      this.categories.add(/cookie/i.test(header[1]!) ? "cookie-header" : "authorization-header");
      return `${header[1]}: [REDACTED]`;
    }
    return this.sanitizeText(value);
  }

  metadata(): RunnerRedactionMetadata | undefined {
    const categories = [...new Set([...(this.prior?.categories ?? []), ...this.categories])].sort();
    const withheldLineCount = (this.prior?.withheldLineCount ?? 0) + this.withheldLineCount;
    return categories.length || withheldLineCount ? { categories, withheldLineCount } : undefined;
  }
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
  private readonly hash = createHash("sha256");
  private capturedBytes = 0;
  private observedBytes = 0;
  private truncated = false;
  private binary = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.hash.update(chunk);
    this.observedBytes += chunk.length;
    if (chunk.includes(0)) this.binary = true;
    if (this.capturedBytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.capturedBytes;
    const selected = chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(selected));
    this.capturedBytes += selected.length;
    if (selected.length < chunk.length) this.truncated = true;
  }

  get hasBinary(): boolean { return this.binary; }

  finish(sanitizer: RunnerSanitizer): { text: string; truncated: boolean; bytes: number; sha256: string; binary: boolean } {
    const sha256 = this.hash.digest("hex");
    if (this.binary) {
      return { text: "", truncated: this.truncated, bytes: this.observedBytes, sha256, binary: true };
    }
    const raw = sanitizer.sanitizeText(compactRepeatedLines(Buffer.concat(this.chunks).toString("utf8")));
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes <= this.maxBytes && !this.truncated) {
      return { text: raw, truncated: false, bytes: this.observedBytes, sha256, binary: false };
    }
    const buffer = Buffer.from(raw, "utf8");
    return {
      text: `${buffer.subarray(0, Math.max(0, this.maxBytes - 32)).toString("utf8")}\n[truncated]`,
      truncated: true,
      bytes: this.observedBytes,
      sha256,
      binary: false
    };
  }
}

function validateCommand(command: string, interactive: boolean): void {
  if (!command.trim()) throw new Error("Runner command is required.");
  if (!interactive && INTERACTIVE_COMMANDS.has(command.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/, ""))) {
    throw new Error("Interactive commands are refused unless interactive mode is explicitly enabled.");
  }
}

export function redactRunnerArguments(args: string[]): string[] {
  return new RunnerSanitizer().sanitizeArguments(args);
}

export function taskOutcomeFromRun(
  run: SavedRun,
  taskId: string,
  identity: RepositoryIdentity
): TaskOutcome {
  const sanitizer = new RunnerSanitizer(run.redaction);
  const command = sanitizer.sanitizeArguments([run.command, ...run.args]).join(" ");
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

function sanitizeRunMetadata(
  metadata: SavedRun["metadata"],
  sanitizer: RunnerSanitizer
): SavedRun["metadata"] {
  if (!metadata) return undefined;
  const sanitized = {
    ...(metadata.test ? { test: sanitizer.sanitizeText(metadata.test) } : {}),
    ...(metadata.file ? { file: sanitizer.sanitizeText(metadata.file) } : {}),
    ...(metadata.errorClass ? { errorClass: sanitizer.sanitizeText(metadata.errorClass) } : {})
  };
  return Object.keys(sanitized).length ? sanitized : undefined;
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function taskkillProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.once("error", (error) => reject(new Error(`taskkill failed to spawn: ${error.message}`)));
    killer.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill failed with exit code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`));
    });
  });
}

export async function executeRun(options: RunnerOptions, signal?: AbortSignal): Promise<SavedRun> {
  const interactive = options.interactive === true;
  validateCommand(options.command, interactive);
  if (interactive) throw new Error("Interactive runner mode is not supported by the bounded capture interface.");
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? 64 * 1024, 1024 * 1024));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 120_000, 15 * 60_000));
  const terminateGraceMs = Math.max(100, Math.min(options.terminateGraceMs ?? 2_000, 15_000));
  const startedAt = new Date();
  const sanitizer = new RunnerSanitizer();
  const stdout = new StreamCapture(maxBytes);
  const stderr = new StreamCapture(maxBytes);
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.root,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let binaryOutput = false;
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  let timedOut = false;
  let cancelled = false;
  let terminationPromise: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    if (terminationPromise) return terminationPromise;
    const pid = child.pid;
    if (!pid) return Promise.resolve();
    terminationPromise = (async () => {
      if (process.platform !== "win32") signalPosixProcessGroup(pid, "SIGTERM");
      await delay(terminateGraceMs);
      if (process.platform === "win32") await taskkillProcessTree(pid);
      else signalPosixProcessGroup(pid, "SIGKILL");
    })();
    return terminationPromise;
  };
  let rejectResult!: (reason: unknown) => void;
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    rejectResult = reject;
    child.once("error", reject);
    child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
  });
  const requestTermination = (): void => {
    void terminate().catch((error: unknown) => {
      if (process.platform === "win32") {
        try { child.kill("SIGKILL"); } catch { /* Preserve the taskkill failure as the actionable error. */ }
      }
      rejectResult(error);
    });
  };
  const timer = setTimeout(() => { timedOut = true; requestTermination(); }, timeoutMs);
  const abort = () => { cancelled = true; requestTermination(); };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const result = await resultPromise.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
  if (terminationPromise) await terminationPromise;
  const stdoutCapture = stdout.finish(sanitizer);
  const stderrCapture = stderr.finish(sanitizer);
  binaryOutput = stdoutCapture.binary || stderrCapture.binary;
  const inferredMetadata = inferRunMetadata(stdoutCapture.text, stderrCapture.text);
  const metadata = sanitizeRunMetadata(
    inferredMetadata || options.metadata ? { ...(inferredMetadata ?? {}), ...(options.metadata ?? {}) } : undefined,
    sanitizer
  );
  return {
    runId: randomUUID(), root: options.root, command: sanitizer.sanitizeText(options.command), args: sanitizer.sanitizeArguments(options.args ?? []),
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    status: cancelled ? "cancelled" : timedOut ? "timed-out" : binaryOutput ? "failed" : result.code === 0 ? "completed" : "failed",
    exitCode: result.code, signal: result.signal, timedOut,
    stdout: stdoutCapture.text, stderr: stderrCapture.text, stdoutTruncated: stdoutCapture.truncated, stderrTruncated: stderrCapture.truncated,
    stdoutBytes: stdoutCapture.bytes, stderrBytes: stderrCapture.bytes,
    stdoutSha256: stdoutCapture.sha256, stderrSha256: stderrCapture.sha256,
    stdoutBinary: stdoutCapture.binary, stderrBinary: stderrCapture.binary,
    ...(binaryOutput ? { binaryOutput: true } : {}),
    ...(sanitizer.metadata() ? { redaction: sanitizer.metadata() } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function sanitizeSavedRun(run: SavedRun): SavedRun {
  const sanitizer = new RunnerSanitizer(run.redaction);
  const metadata = sanitizeRunMetadata(run.metadata, sanitizer);
  const sanitized: SavedRun = {
    ...run,
    command: sanitizer.sanitizeText(run.command),
    args: sanitizer.sanitizeArguments(run.args),
    stdout: sanitizer.sanitizeText(run.stdout),
    stderr: sanitizer.sanitizeText(run.stderr),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {})
  };
  const redaction = sanitizer.metadata();
  if (redaction) sanitized.redaction = redaction;
  return sanitized;
}

export async function saveRun(root: string, run: SavedRun): Promise<void> {
  const lock = await canonicalPersistenceLock(root, "runs", `${run.runId}.json`);
  await withFileLock(lock, () => writeJsonAtomic(runPath(root, run.runId), sanitizeSavedRun(run)));
}

// `repairInsideLock` is set only by callers that own the runs domain anchor
// (purge); quarantining a corrupt run is a mutation and is skipped on the
// unlocked pure reads used by `loadRun`/`querySavedRuns`.
export async function loadRun(root: string, runId: string, repairInsideLock = false): Promise<SavedRun | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runPath(root, runId), "utf8")) as SavedRun;
    return parsed && parsed.runId === runId && parsed.root === root ? sanitizeSavedRun(parsed) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) { if (repairInsideLock) await quarantineCorruptJson(runPath(root, runId)); return undefined; }
    throw error;
  }
}

export function summarizeRun(run: SavedRun): SavedRunSummary {
  const sanitizer = new RunnerSanitizer(run.redaction);
  const combined = sanitizer.sanitizeText(`${run.stderr}\n${run.stdout}`);
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
    locations,
    ...(sanitizer.metadata() ? { redaction: sanitizer.metadata() } : {})
  };
}

export async function querySavedRuns(root: string, selector: { test?: string; file?: string; errorClass?: string } = {}): Promise<SavedRun[]> {
  const entries = await readdir(runsDir(root)).catch((error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
  const runs = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) => loadRun(root, entry.slice(0, -5))));
  return runs.filter((run): run is SavedRun => Boolean(run) && Object.entries(selector).every(([key, value]) => run?.metadata?.[key as keyof NonNullable<SavedRun["metadata"]>] === value)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function purgeRuns(root: string, before?: Date): Promise<string[]> {
  // Retention deletion mutates persistent state and must run while owning the
  // canonical runs domain anchor. Every runs lock shares the same domain-root
  // anchor, so a single acquisition serializes purge against run writers; all
  // primitives inside are unlocked.
  const lock = await canonicalPersistenceLock(root, "runs", "maintenance");
  return withFileLock(lock, () => purgeRunsUnlocked(root, before));
}

async function purgeRunsUnlocked(root: string, before?: Date): Promise<string[]> {
  const entries = await readdir(runsDir(root)).catch((error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
  const removed: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const runId = entry.slice(0, -5);
    const run = await loadRun(root, runId, true);
    if (run && (!before || new Date(run.finishedAt) < before)) { await rm(join(runsDir(root), entry), { force: true }); removed.push(runId); }
  }
  return removed;
}
