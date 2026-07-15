#!/usr/bin/env node

// src/core/runner.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { spawn } from "node:child_process";

// src/core/storage.ts
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
var FILE_LOCK_ATTEMPTS = 200;
var FILE_LOCK_WAIT_MS = 10;
var FILE_LOCK_STALE_MS = 3e4;
async function wait(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
function isTransientWindowsFsError(error) {
  return process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code));
}
async function retryTransientWindowsFs(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsFsError(error) || attempt >= 19) throw error;
      await wait(FILE_LOCK_WAIT_MS);
    }
  }
}
async function withFileLock(lockPath, operation) {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await operation();
      } finally {
        await handle.close();
        await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
      }
    } catch (error) {
      if (error.code !== "EEXIST" && !isTransientWindowsFsError(error)) throw error;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > FILE_LOCK_STALE_MS) {
          await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT" && !isTransientWindowsFsError(lockError)) throw lockError;
      }
      await wait(FILE_LOCK_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for a persistence file lock.");
}
async function canonicalPersistenceLockKey(root, ...segments) {
  const resolvedRoot = resolve(root);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonicalRoot = resolvedRoot;
  }
  const key = join(canonicalRoot, ...segments);
  return process.platform === "win32" ? key.toLowerCase() : key;
}
async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}
`);
}
async function writeTextAtomic(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

// src/core/persistence.ts
import { isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2 } from "node:path";

// src/core/repositoryIdentity.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/core/persistence.ts
function stateDir(root) {
  return join2(root, ".tokengraph");
}
function runsDir(root) {
  return join2(stateDir(root), "runs");
}
function runPath(root, runId) {
  return join2(runsDir(root), `${runId}.json`);
}

// src/core/runner.ts
var ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
var SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*([:=])\s*[^\s]+/gi,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g
];
var INTERACTIVE_COMMANDS = /* @__PURE__ */ new Set(["ssh", "vim", "vi", "nano", "less", "more", "top", "htop", "pwsh", "powershell"]);
function redact(value) {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, (match, separator) => separator ? `[REDACTED]${separator}[REDACTED]` : "[REDACTED]"), value);
}
function compactRepeatedLines(value) {
  const lines = value.split("\n");
  const output = [];
  for (let index = 0; index < lines.length; ) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    output.push(lines[index]);
    if (count > 3) output.push(`[repeated line x${count}]`);
    index = end;
  }
  return output.join("\n");
}
function boundedCapture(chunks, maxBytes) {
  const raw = redact(compactRepeatedLines(chunks.join("").replace(ANSI_PATTERN, "")));
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= maxBytes) return { text: raw, truncated: false };
  const buffer = Buffer.from(raw, "utf8");
  return { text: `${buffer.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}
[truncated]`, truncated: true };
}
function validateCommand(command, interactive) {
  if (!command.trim()) throw new Error("Runner command is required.");
  if (!interactive && INTERACTIVE_COMMANDS.has(command.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, ""))) {
    throw new Error("Interactive commands are refused unless interactive mode is explicitly enabled.");
  }
}
function redactRunnerArguments(args) {
  return args.map((arg) => redact(arg));
}
async function executeRun(options, signal) {
  const interactive = options.interactive === true;
  validateCommand(options.command, interactive);
  if (interactive) throw new Error("Interactive runner mode is not supported by the bounded capture interface.");
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? 64 * 1024, 1024 * 1024));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12e4, 15 * 6e4));
  const startedAt = /* @__PURE__ */ new Date();
  const stdout = [];
  const stderr = [];
  const child = spawn(options.command, options.args ?? [], { cwd: options.root, env: options.env ? { ...process.env, ...options.env } : process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  let timedOut = false;
  let cancelled = false;
  const terminate = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const abort = () => {
    cancelled = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const result = await new Promise((resolve3, reject) => {
    child.once("error", reject);
    child.once("close", (code, childSignal) => resolve3({ code, signal: childSignal }));
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
  const stdoutCapture = boundedCapture(stdout, maxBytes);
  const stderrCapture = boundedCapture(stderr, maxBytes);
  return {
    runId: randomUUID2(),
    root: options.root,
    command: options.command,
    args: redactRunnerArguments(options.args ?? []),
    startedAt: startedAt.toISOString(),
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: cancelled ? "cancelled" : timedOut ? "timed-out" : result.code === 0 ? "completed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    stdout: stdoutCapture.text,
    stderr: stderrCapture.text,
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    ...options.metadata ? { metadata: options.metadata } : {}
  };
}
async function saveRun(root, run) {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "runs", `${run.runId}.json`);
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(runPath(root, run.runId), run));
}

// src/cli.ts
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
async function main(argv) {
  if (argv[0] !== "run") throw new Error("Usage: tokengraph run [--root <path>] [--timeout-ms <n>] -- <command> [args...]");
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("tokengraph run requires `-- <command> [args...]`.");
  const commandArgs = argv.slice(separator + 1);
  const root = optionValue(argv.slice(1, separator), "--root") ?? process.cwd();
  const timeoutMs = Number(optionValue(argv.slice(1, separator), "--timeout-ms") ?? 12e4);
  const maxBytes = Number(optionValue(argv.slice(1, separator), "--max-bytes") ?? 64 * 1024);
  const run = await executeRun({ root, command: commandArgs[0], args: commandArgs.slice(1), timeoutMs, maxBytes });
  await saveRun(root, run);
  process.stdout.write(`${JSON.stringify(run)}
`);
  if (run.status !== "completed") process.exitCode = run.status === "timed-out" ? 124 : 1;
}
main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 2;
});
