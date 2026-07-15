#!/usr/bin/env node

// src/core/runner.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile as readFile2, readdir, rm as rm2 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/core/storage.ts
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
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
  await assertNoSymbolicLinkComponents(lockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  await assertNoSymbolicLinkComponents(lockPath);
  for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 384);
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
  await assertNoSymbolicLinkComponents(path);
  await mkdir(directory, { recursive: true, mode: 448 });
  await assertNoSymbolicLinkComponents(path);
  if (process.platform !== "win32") await chmod(directory, 448);
  const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode: 384 });
    await rename(tempPath, path);
    if (process.platform !== "win32") await chmod(path, 384);
  } finally {
    await rm(tempPath, { force: true });
  }
}
async function assertNoSymbolicLinkComponents(path) {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  for (const segment of remainder) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`State write cannot traverse symbolic-link or junction component: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
}
async function quarantineCorruptJson(path) {
  const corruptPath = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(path, corruptPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

// src/core/persistence.ts
import { isAbsolute as isAbsolute2, join as join3, relative as relative2, resolve as resolve3 } from "node:path";

// src/core/repositoryIdentity.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join as join2, resolve as resolve2 } from "node:path";
var execFileAsync = promisify(execFile);
async function git(root, ...args) {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim();
    return output || void 0;
  } catch {
    return void 0;
  }
}
async function gitCommonDirectory(root) {
  const commonDir = await git(resolve2(root), "rev-parse", "--git-common-dir");
  if (!commonDir) return void 0;
  return resolve2(root, commonDir);
}
function repositoryStateDirectory(root, commonDirectory) {
  return commonDirectory ? join2(commonDirectory, "tokengraph") : join2(resolve2(root), ".tokengraph", "repository");
}
async function resolveRepositoryStateDirectory(root) {
  return repositoryStateDirectory(root, await gitCommonDirectory(root));
}

// src/core/persistence.ts
function stateDir(root) {
  return join3(root, ".tokengraph");
}
async function repositoryDir(root) {
  return resolveRepositoryStateDirectory(root);
}
function configPath(root) {
  return join3(stateDir(root), "config.json");
}
function runsDir(root) {
  return join3(stateDir(root), "runs");
}
function runPath(root, runId) {
  return join3(runsDir(root), `${runId}.json`);
}
function wikiDir(root) {
  return join3(stateDir(root), "wiki");
}
function vaultDir(root) {
  return join3(stateDir(root), "vault");
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
var StreamCapture = class {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
  }
  maxBytes;
  chunks = [];
  bytes = 0;
  truncated = false;
  binary = false;
  append(chunk) {
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
  get hasBinary() {
    return this.binary;
  }
  finish() {
    const raw = redact(compactRepeatedLines(Buffer.concat(this.chunks).toString("utf8").replace(ANSI_PATTERN, "")));
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes <= this.maxBytes && !this.truncated) return { text: raw, truncated: false };
    const buffer = Buffer.from(raw, "utf8");
    return { text: `${buffer.subarray(0, Math.max(0, this.maxBytes - 32)).toString("utf8")}
[truncated]`, truncated: true };
  }
};
function validateCommand(command, interactive) {
  if (!command.trim()) throw new Error("Runner command is required.");
  if (!interactive && INTERACTIVE_COMMANDS.has(command.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, ""))) {
    throw new Error("Interactive commands are refused unless interactive mode is explicitly enabled.");
  }
}
function redactRunnerArguments(args) {
  return args.map((arg) => redact(arg));
}
function inferRunMetadata(stdout, stderr) {
  const combined = `${stderr}
${stdout}`;
  const errorClass = combined.match(/\b([A-Z][A-Za-z0-9_$]*(?:Error|Exception))\b/)?.[1];
  const file = combined.match(/((?:[A-Za-z]:[\\/])?(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+):\d+(?::\d+)?/)?.[1]?.replaceAll("\\", "/");
  const test = combined.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(?:FAIL|FAILED)\s+\S/i.test(line))?.replace(/^(?:FAIL|FAILED)\s+/i, "");
  const metadata = { ...test ? { test } : {}, ...file ? { file } : {}, ...errorClass ? { errorClass } : {} };
  return Object.keys(metadata).length ? metadata : void 0;
}
async function executeRun(options, signal) {
  const interactive = options.interactive === true;
  validateCommand(options.command, interactive);
  if (interactive) throw new Error("Interactive runner mode is not supported by the bounded capture interface.");
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? 64 * 1024, 1024 * 1024));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12e4, 15 * 6e4));
  const terminateGraceMs = Math.max(100, Math.min(options.terminateGraceMs ?? 2e3, 15e3));
  const startedAt = /* @__PURE__ */ new Date();
  const stdout = new StreamCapture(maxBytes);
  const stderr = new StreamCapture(maxBytes);
  const child = spawn(options.command, options.args ?? [], { cwd: options.root, env: options.env ? { ...process.env, ...options.env } : process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let binaryOutput = false;
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  let timedOut = false;
  let cancelled = false;
  let escalationTimer;
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
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const abort = () => {
    cancelled = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const result = await new Promise((resolve5, reject) => {
    child.once("error", reject);
    child.once("close", (code, childSignal) => resolve5({ code, signal: childSignal }));
  }).finally(() => {
    clearTimeout(timer);
    if (escalationTimer) clearTimeout(escalationTimer);
    signal?.removeEventListener("abort", abort);
  });
  const stdoutCapture = stdout.finish();
  const stderrCapture = stderr.finish();
  binaryOutput = stdout.hasBinary || stderr.hasBinary;
  if (binaryOutput) stderrCapture.text = `${stderrCapture.text}
[binary output refused]`;
  const inferredMetadata = inferRunMetadata(stdoutCapture.text, stderrCapture.text);
  const metadata = inferredMetadata || options.metadata ? { ...inferredMetadata ?? {}, ...options.metadata ?? {} } : void 0;
  return {
    runId: randomUUID2(),
    root: options.root,
    command: options.command,
    args: redactRunnerArguments(options.args ?? []),
    startedAt: startedAt.toISOString(),
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: cancelled ? "cancelled" : timedOut ? "timed-out" : binaryOutput ? "failed" : result.code === 0 ? "completed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    stdout: stdoutCapture.text,
    stderr: stderrCapture.text,
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    ...binaryOutput ? { binaryOutput: true } : {},
    ...metadata ? { metadata } : {}
  };
}
async function saveRun(root, run) {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "runs", `${run.runId}.json`);
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(runPath(root, run.runId), run));
}
async function loadRun(root, runId) {
  try {
    const parsed = JSON.parse(await readFile2(runPath(root, runId), "utf8"));
    return parsed && parsed.runId === runId && parsed.root === root ? parsed : void 0;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(runPath(root, runId));
      return void 0;
    }
    throw error;
  }
}
function summarizeRun(run) {
  const combined = `${run.stderr}
${run.stdout}`;
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstError = lines.find((line) => /\b(error|failed|failure|exception)\b/i.test(line));
  const tests = lines.filter((line) => /(?:test|spec)\b|\b(pass|fail)ed\b/i.test(line)).slice(0, 20);
  const stackFrames = lines.filter((line) => /^\s*at\s+|\bat\s+.+:\d+:\d+/.test(line)).slice(0, 20);
  const locations = lines.map((line) => line.match(/[^\s:()]+:\d+(?::\d+)?/)?.[0]).filter((value) => Boolean(value)).slice(0, 20);
  const repeatCount = lines.length - new Set(lines).size;
  return {
    runId: run.runId,
    status: run.status,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    ...firstError ? { firstError } : {},
    repeatCount,
    tests,
    stackFrames,
    locations
  };
}
async function purgeRuns(root, before) {
  const entries = await readdir(runsDir(root)).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const removed = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const runId = entry.slice(0, -5);
    const run = await loadRun(root, runId);
    if (run && (!before || new Date(run.finishedAt) < before)) {
      await rm2(join4(runsDir(root), entry), { force: true });
      removed.push(runId);
    }
  }
  return removed;
}

// src/core/config.ts
import { copyFile, readFile as readFile3 } from "node:fs/promises";
var CURRENT_CONFIG_SCHEMA_VERSION = 2;
var PROFILE_DEFAULTS = {
  conservative: {
    maxFiles: 10,
    maxSqlObjects: 10,
    maxMemories: 6,
    firstReads: 5,
    maxPlannedContextTokens: 12e3,
    rawReadWarningThreshold: 12e3
  },
  balanced: {
    maxFiles: 6,
    maxSqlObjects: 6,
    maxMemories: 4,
    firstReads: 3,
    maxPlannedContextTokens: 8e3,
    rawReadWarningThreshold: 8e3
  },
  aggressive: {
    maxFiles: 3,
    maxSqlObjects: 3,
    maxMemories: 2,
    firstReads: 2,
    maxPlannedContextTokens: 4e3,
    rawReadWarningThreshold: 4e3
  }
};
var DEFAULT_TOKEN_GRAPH_CONFIG = {
  tokenSavingProfile: "balanced",
  routingMode: "shadow",
  maxFiles: PROFILE_DEFAULTS.balanced.maxFiles,
  maxSqlObjects: PROFILE_DEFAULTS.balanced.maxSqlObjects,
  maxMemories: PROFILE_DEFAULTS.balanced.maxMemories,
  maxPlannedContextTokens: PROFILE_DEFAULTS.balanced.maxPlannedContextTokens,
  rawReadWarningThreshold: PROFILE_DEFAULTS.balanced.rawReadWarningThreshold,
  sqlIndexingEnabled: true,
  memoryEnabled: true,
  wikiGenerationEnabled: false,
  routingKillSwitch: false,
  routing: { mode: "shadow", killSwitch: false },
  parser: {
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    maxSymbols: 1e4,
    maxNodes: 25e4,
    perFileTimeoutMs: 2e3,
    wholeIndexTimeoutMs: 6e4,
    maxRecursionDepth: 64,
    maxGraphDepth: 3,
    maxGeneratedFiles: 200,
    maxTsconfigChain: 8,
    maxAliases: 500
  },
  storage: {
    maxBytes: 64 * 1024 * 1024,
    runsMaxBytes: 16 * 1024 * 1024,
    cacheMaxBytes: 32 * 1024 * 1024,
    vaultMaxBytes: 8 * 1024 * 1024,
    durableMaxBytes: 8 * 1024 * 1024,
    runRetentionDays: 14,
    cacheRetentionDays: 7
  },
  runner: { maxBytes: 64 * 1024, timeoutMs: 12e4, terminateGraceMs: 2e3 },
  memory: { projectBriefTargetTokens: 220, projectBriefMaxTokens: 600, maxRetrievalTokens: 1200 },
  responseFormat: { default: "json" }
};
function isProfile(value) {
  return value === "conservative" || value === "balanced" || value === "aggressive";
}
function isRoutingMode(value) {
  return value === "shadow" || value === "enforced" || value === "always-activate" || value === "always-advisory";
}
function sanitizeNumber(value, fallback, min = 0) {
  return Number.isInteger(value) && value >= min ? value : fallback;
}
function legacyStorageClassCaps(maxBytes) {
  const runsMaxBytes = Math.floor(maxBytes * 0.25);
  const cacheMaxBytes = Math.floor(maxBytes * 0.5);
  const vaultMaxBytes = Math.floor(maxBytes * 0.125);
  return { runsMaxBytes, cacheMaxBytes, vaultMaxBytes, durableMaxBytes: maxBytes - runsMaxBytes - cacheMaxBytes - vaultMaxBytes };
}
function normalizeConfig(value, applyEnvironment = true) {
  const candidate = value && typeof value === "object" ? value : {};
  const nestedRouting = candidate.routing && typeof candidate.routing === "object" ? candidate.routing : {};
  const nestedParser = candidate.parser && typeof candidate.parser === "object" ? candidate.parser : {};
  const nestedStorage = candidate.storage && typeof candidate.storage === "object" ? candidate.storage : {};
  const nestedRunner = candidate.runner && typeof candidate.runner === "object" ? candidate.runner : {};
  const nestedMemory = candidate.memory && typeof candidate.memory === "object" ? candidate.memory : {};
  const nestedResponse = candidate.responseFormat && typeof candidate.responseFormat === "object" ? candidate.responseFormat : {};
  const storageMaxBytes = sanitizeNumber(nestedStorage.maxBytes, DEFAULT_TOKEN_GRAPH_CONFIG.storage.maxBytes, 1);
  const legacyStorageCaps = legacyStorageClassCaps(storageMaxBytes);
  const routingMode = applyEnvironment && isRoutingMode(process.env.TOKENGRAPH_ROUTING_MODE) ? process.env.TOKENGRAPH_ROUTING_MODE : isRoutingMode(candidate.routingMode) ? candidate.routingMode : isRoutingMode(nestedRouting.mode) ? nestedRouting.mode : DEFAULT_TOKEN_GRAPH_CONFIG.routingMode;
  const routingKillSwitch = typeof candidate.routingKillSwitch === "boolean" ? candidate.routingKillSwitch : typeof nestedRouting.killSwitch === "boolean" ? Boolean(nestedRouting.killSwitch) : DEFAULT_TOKEN_GRAPH_CONFIG.routingKillSwitch;
  const integer = (object, key, fallback, min = 0) => sanitizeNumber(object[key], fallback, min);
  return {
    tokenSavingProfile: isProfile(candidate.tokenSavingProfile) ? candidate.tokenSavingProfile : DEFAULT_TOKEN_GRAPH_CONFIG.tokenSavingProfile,
    routingMode,
    maxFiles: sanitizeNumber(candidate.maxFiles, DEFAULT_TOKEN_GRAPH_CONFIG.maxFiles, 1),
    maxSqlObjects: sanitizeNumber(candidate.maxSqlObjects, DEFAULT_TOKEN_GRAPH_CONFIG.maxSqlObjects),
    maxMemories: sanitizeNumber(candidate.maxMemories, DEFAULT_TOKEN_GRAPH_CONFIG.maxMemories),
    maxPlannedContextTokens: sanitizeNumber(candidate.maxPlannedContextTokens, DEFAULT_TOKEN_GRAPH_CONFIG.maxPlannedContextTokens, 1),
    rawReadWarningThreshold: sanitizeNumber(candidate.rawReadWarningThreshold, DEFAULT_TOKEN_GRAPH_CONFIG.rawReadWarningThreshold, 1),
    sqlIndexingEnabled: typeof candidate.sqlIndexingEnabled === "boolean" ? candidate.sqlIndexingEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.sqlIndexingEnabled,
    memoryEnabled: typeof candidate.memoryEnabled === "boolean" ? candidate.memoryEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.memoryEnabled,
    wikiGenerationEnabled: typeof candidate.wikiGenerationEnabled === "boolean" ? candidate.wikiGenerationEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.wikiGenerationEnabled,
    routingKillSwitch,
    routing: { mode: routingMode, killSwitch: routingKillSwitch },
    parser: {
      maxFileBytes: integer(nestedParser, "maxFileBytes", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxFileBytes, 1),
      maxTotalBytes: integer(nestedParser, "maxTotalBytes", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxTotalBytes, 1),
      maxSymbols: integer(nestedParser, "maxSymbols", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxSymbols, 1),
      maxNodes: integer(nestedParser, "maxNodes", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxNodes, 1),
      perFileTimeoutMs: integer(nestedParser, "perFileTimeoutMs", DEFAULT_TOKEN_GRAPH_CONFIG.parser.perFileTimeoutMs, 1),
      wholeIndexTimeoutMs: integer(nestedParser, "wholeIndexTimeoutMs", DEFAULT_TOKEN_GRAPH_CONFIG.parser.wholeIndexTimeoutMs, 1),
      maxRecursionDepth: integer(nestedParser, "maxRecursionDepth", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxRecursionDepth, 1),
      maxGraphDepth: integer(nestedParser, "maxGraphDepth", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxGraphDepth, 0),
      maxGeneratedFiles: integer(nestedParser, "maxGeneratedFiles", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxGeneratedFiles, 0),
      maxTsconfigChain: integer(nestedParser, "maxTsconfigChain", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxTsconfigChain, 1),
      maxAliases: integer(nestedParser, "maxAliases", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxAliases, 0)
    },
    storage: {
      maxBytes: storageMaxBytes,
      runsMaxBytes: integer(nestedStorage, "runsMaxBytes", legacyStorageCaps.runsMaxBytes, 0),
      cacheMaxBytes: integer(nestedStorage, "cacheMaxBytes", legacyStorageCaps.cacheMaxBytes, 0),
      vaultMaxBytes: integer(nestedStorage, "vaultMaxBytes", legacyStorageCaps.vaultMaxBytes, 0),
      durableMaxBytes: integer(nestedStorage, "durableMaxBytes", legacyStorageCaps.durableMaxBytes, 0),
      runRetentionDays: integer(nestedStorage, "runRetentionDays", DEFAULT_TOKEN_GRAPH_CONFIG.storage.runRetentionDays, 0),
      cacheRetentionDays: integer(nestedStorage, "cacheRetentionDays", DEFAULT_TOKEN_GRAPH_CONFIG.storage.cacheRetentionDays, 0)
    },
    runner: {
      maxBytes: integer(nestedRunner, "maxBytes", DEFAULT_TOKEN_GRAPH_CONFIG.runner.maxBytes, 256),
      timeoutMs: integer(nestedRunner, "timeoutMs", DEFAULT_TOKEN_GRAPH_CONFIG.runner.timeoutMs, 1),
      terminateGraceMs: integer(nestedRunner, "terminateGraceMs", DEFAULT_TOKEN_GRAPH_CONFIG.runner.terminateGraceMs, 1)
    },
    memory: {
      projectBriefTargetTokens: integer(nestedMemory, "projectBriefTargetTokens", DEFAULT_TOKEN_GRAPH_CONFIG.memory.projectBriefTargetTokens, 150),
      projectBriefMaxTokens: integer(nestedMemory, "projectBriefMaxTokens", DEFAULT_TOKEN_GRAPH_CONFIG.memory.projectBriefMaxTokens, 1),
      maxRetrievalTokens: integer(nestedMemory, "maxRetrievalTokens", DEFAULT_TOKEN_GRAPH_CONFIG.memory.maxRetrievalTokens, 1)
    },
    responseFormat: { default: nestedResponse.default === "compact-tabular" ? "compact-tabular" : "json" }
  };
}
function unwrapPersistedConfig(value) {
  if (value && typeof value === "object" && "schemaVersion" in value && "config" in value) {
    const schemaVersion = value.schemaVersion;
    if (typeof schemaVersion === "number" && schemaVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
      throw new Error(`Unsupported newer TokenGraph config schema version ${schemaVersion}; refusing to overwrite it.`);
    }
    return {
      config: value.config,
      needsMigration: schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION
    };
  }
  return { config: value, needsMigration: true };
}
async function saveTokenGraphConfig(root, config) {
  const persisted = normalizeConfig(config, false);
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "config.json");
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(configPath(root), {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    config: persisted
  }));
  return normalizeConfig(persisted);
}
async function loadTokenGraphConfig(root) {
  try {
    const parsed = JSON.parse(await readFile3(configPath(root), "utf8"));
    const unwrapped = unwrapPersistedConfig(parsed);
    const persistedNormalized = normalizeConfig(unwrapped.config, false);
    const normalized = normalizeConfig(persistedNormalized);
    if (unwrapped.needsMigration || JSON.stringify(unwrapped.config) !== JSON.stringify(persistedNormalized)) {
      await copyFile(configPath(root), `${configPath(root)}.bak`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await saveTokenGraphConfig(root, persistedNormalized);
    }
    return normalized;
  } catch (error) {
    if (error.code === "ENOENT") {
      return saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
    }
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(configPath(root));
      return saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
    }
    throw error;
  }
}

// src/core/storagePolicy.ts
import { chmod as chmod2, lstat as lstat2, mkdir as mkdir2, readFile as readFile4, readdir as readdir2, realpath as realpath2, rm as rm3 } from "node:fs/promises";
import { basename, dirname as dirname2, isAbsolute as isAbsolute3, join as join5, relative as relative3, resolve as resolve4 } from "node:path";
async function usage(path) {
  try {
    const info = await lstat2(path);
    if (info.isSymbolicLink()) throw new Error(`TokenGraph storage accounting refuses symbolic-link paths: ${path}`);
    if (info.isFile()) return { bytes: info.size, files: 1 };
    if (!info.isDirectory()) return { bytes: 0, files: 0 };
    const entries = await readdir2(path);
    const children = await Promise.all(entries.map((entry) => usage(join5(path, entry))));
    return children.reduce((total, child) => ({ bytes: total.bytes + child.bytes, files: total.files + child.files }), { bytes: 0, files: 0 });
  } catch (error) {
    if (error.code === "ENOENT") return { bytes: 0, files: 0 };
    throw error;
  }
}
function containsPath(parent, child) {
  const nested = relative3(resolve4(parent), resolve4(child));
  return nested === "" || !nested.startsWith("..") && !isAbsolute3(nested);
}
async function usageMany(paths) {
  const unique = paths.map((path) => resolve4(path)).filter((path, index, all) => all.indexOf(path) === index);
  const roots = unique.filter((path, index, all) => !all.some((candidate, candidateIndex) => candidateIndex !== index && containsPath(candidate, path)));
  const values = await Promise.all(roots.map((path) => usage(path)));
  return values.reduce((total, current) => ({ bytes: total.bytes + current.bytes, files: total.files + current.files }), { bytes: 0, files: 0 });
}
async function storageUsage(root) {
  return usageMany([stateDir(root), await resolveRepositoryStateDirectory(root)]);
}
async function storageClassUsage(root) {
  const repository = await resolveRepositoryStateDirectory(root);
  const [total, runs, cache, vault] = await Promise.all([
    storageUsage(root),
    usage(runsDir(root)),
    usageMany([join5(stateDir(root), "index.json"), wikiDir(root), join5(repository, "index.json"), join5(repository, "artifacts")]),
    usage(vaultDir(root))
  ]);
  return {
    total,
    runs,
    cache,
    vault,
    durable: {
      bytes: Math.max(0, total.bytes - runs.bytes - cache.bytes - vault.bytes),
      files: Math.max(0, total.files - runs.files - cache.files - vault.files)
    }
  };
}
function assertClassQuotas(quotas) {
  for (const [name, value] of Object.entries(quotas)) {
    if (!Number.isInteger(value) || value < (name === "maxBytes" ? 1 : 0)) throw new Error(`Storage ${name} must be a non-negative integer${name === "maxBytes" ? " greater than zero" : ""}.`);
  }
}
function classQuota(quotas, storageClass) {
  return quotas[`${storageClass}MaxBytes`];
}
function quotaExceededError(storageClass, current, maximum) {
  if (storageClass === "runs") return new Error(`TokenGraph runs storage quota exceeded (${current}/${maximum} bytes); run \`tokengraph purge --class runs\` or raise storage.runsMaxBytes.`);
  if (storageClass === "vault") return new Error(`TokenGraph vault storage quota exceeded (${current}/${maximum} bytes); explicitly purge derived projections with \`tokengraph purge --class derived\` or raise storage.vaultMaxBytes.`);
  if (storageClass === "durable") return new Error(`TokenGraph durable storage quota exceeded (${current}/${maximum} bytes); refusing the write. Review durable state or raise storage.durableMaxBytes; reviewed decisions and preferences are never purged implicitly.`);
  return new Error(`TokenGraph cache item exceeds its storage quota (${current}/${maximum} bytes); raise storage.cacheMaxBytes.`);
}
async function safeRemoveUnderBase(base, relativeTarget, recursive) {
  if (!relativeTarget || isAbsolute3(relativeTarget) || relativeTarget.replaceAll("\\", "/").split("/").includes("..")) throw new Error("Storage purge target must be a safe relative path.");
  let canonicalBase;
  try {
    if ((await lstat2(base)).isSymbolicLink()) throw new Error(`Storage purge refuses symbolic-link base paths: ${base}`);
    canonicalBase = await realpath2(base);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const target = join5(canonicalBase, relativeTarget);
  if (!containsPath(canonicalBase, target) || target === canonicalBase) throw new Error("Storage purge target escapes its approved base directory.");
  let current = canonicalBase;
  for (const segment of relativeTarget.replaceAll("\\", "/").split("/").filter(Boolean)) {
    current = join5(current, segment);
    try {
      if ((await lstat2(current)).isSymbolicLink()) throw new Error(`Storage purge refuses symbolic-link or junction paths: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  await rm3(target, { recursive, force: true });
  return true;
}
async function removeWorktreeState(root, relativeTarget, recursive, label) {
  const workspace = await realpath2(resolve4(root));
  return await safeRemoveUnderBase(workspace, join5(".tokengraph", relativeTarget), recursive) ? [label] : [];
}
async function purgeCache(root) {
  const repository = await resolveRepositoryStateDirectory(root);
  const removed = [
    ...await removeWorktreeState(root, "index.json", false, ".tokengraph/index.json"),
    ...await removeWorktreeState(root, "wiki", true, ".tokengraph/wiki")
  ];
  if (await safeRemoveUnderBase(repository, "index.json", false)) removed.push("repository/index.json");
  if (await safeRemoveUnderBase(repository, "artifacts", true)) removed.push("repository/artifacts");
  return removed;
}
async function purgeOutcomes(root) {
  const directory = join5(await realpath2(resolve4(root)), ".tokengraph", "tasks");
  const entries = await readdir2(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const removed = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile4(join5(directory, entry), "utf8"));
      if (parsed.status !== "completed" && parsed.status !== "quarantined") continue;
    } catch {
      continue;
    }
    removed.push(...await removeWorktreeState(root, join5("tasks", entry), false, `.tokengraph/tasks/${entry}`));
  }
  return removed;
}
async function purgeStorageClass(root, storageClass) {
  let removed = [];
  if (storageClass === "runs" || storageClass === "derived") removed.push(...await removeWorktreeState(root, "runs", true, ".tokengraph/runs"));
  if (storageClass === "cache" || storageClass === "derived") removed.push(...await purgeCache(root));
  if (storageClass === "outcomes" || storageClass === "derived") removed.push(...await purgeOutcomes(root));
  if (storageClass === "derived") removed.push(...await removeWorktreeState(root, "vault", true, ".tokengraph/vault"));
  return { class: storageClass, removed: [...new Set(removed)] };
}
async function enforceStorageClassQuotas(root, quotas) {
  assertClassQuotas(quotas);
  let current = await storageClassUsage(root);
  const cleaned = [];
  if (current.cache.bytes > quotas.cacheMaxBytes || current.total.bytes > quotas.maxBytes) {
    if (current.cache.bytes > 0) {
      await purgeStorageClass(root, "cache");
      cleaned.push("cache");
      current = await storageClassUsage(root);
    }
  }
  for (const storageClass of ["runs", "vault", "durable"]) {
    const maximum = classQuota(quotas, storageClass);
    if (current[storageClass].bytes > maximum) throw quotaExceededError(storageClass, current[storageClass].bytes, maximum);
  }
  if (current.cache.bytes > quotas.cacheMaxBytes) throw quotaExceededError("cache", current.cache.bytes, quotas.cacheMaxBytes);
  if (current.total.bytes > quotas.maxBytes) throw new Error(`TokenGraph total storage quota exceeded (${current.total.bytes}/${quotas.maxBytes} bytes) after cache cleanup; explicitly purge runs, outcomes, or derived state, or raise storage.maxBytes.`);
  return { usage: current, cleaned };
}
async function assertStorageWriteAllowed(root, storageClass, incomingBytes, quotas) {
  if (!Number.isInteger(incomingBytes) || incomingBytes < 0) throw new Error("Incoming storage bytes must be a non-negative integer.");
  let report = await enforceStorageClassQuotas(root, quotas);
  let projectedClassBytes = report.usage[storageClass].bytes + incomingBytes;
  if (storageClass === "cache" && projectedClassBytes > quotas.cacheMaxBytes && report.usage.cache.bytes > 0) {
    await purgeStorageClass(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [.../* @__PURE__ */ new Set([...report.cleaned, "cache"])] };
    projectedClassBytes = incomingBytes;
  }
  const maximum = classQuota(quotas, storageClass);
  if (projectedClassBytes > maximum) throw quotaExceededError(storageClass, projectedClassBytes, maximum);
  let projectedTotal = report.usage.total.bytes + incomingBytes;
  if (projectedTotal > quotas.maxBytes && report.usage.cache.bytes > 0 && storageClass !== "cache") {
    await purgeStorageClass(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [.../* @__PURE__ */ new Set([...report.cleaned, "cache"])] };
    projectedTotal = report.usage.total.bytes + incomingBytes;
  }
  if (projectedTotal > quotas.maxBytes) throw new Error(`TokenGraph total storage quota would be exceeded (${projectedTotal}/${quotas.maxBytes} bytes); explicitly purge storage or raise storage.maxBytes.`);
  return report;
}

// src/core/pairedEval.ts
import { readFile as readFile6 } from "node:fs/promises";

// src/core/routingControl.ts
import { readFile as readFile5 } from "node:fs/promises";
var CURRENT_ROUTING_CONTROL_SCHEMA = 1;
var REQUIRED_PROMOTION_GATES = [
  "minimumSamples",
  "qualityNonInferiority",
  "tokenSuperiority",
  "resources",
  "routerRates",
  "executionMedian",
  "executionP25",
  "nonNegativeActivated"
];
function routingControlPath(directory) {
  return `${directory}/routing-control.json`;
}
function isValidatedPromotion(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  const gateRecord = candidate.gates && typeof candidate.gates === "object" ? candidate.gates : void 0;
  const gates = gateRecord ? Object.values(gateRecord) : [];
  const hasRequiredGates = Boolean(gateRecord) && REQUIRED_PROMOTION_GATES.every((name) => typeof gateRecord?.[name] === "boolean") && Object.keys(gateRecord ?? {}).length === REQUIRED_PROMOTION_GATES.length;
  const allGatesPass = hasRequiredGates && gates.every((gate) => gate === true);
  const categoryCounts = candidate.categoryCounts && typeof candidate.categoryCounts === "object" ? Object.values(candidate.categoryCounts) : [];
  const evidencePasses = categoryCounts.length > 0 && categoryCounts.every((count) => Number.isInteger(count) && count >= 10) && typeof candidate.falseBypassRate === "number" && Number.isFinite(candidate.falseBypassRate) && candidate.falseBypassRate >= 0 && candidate.falseBypassRate < 0.1 && typeof candidate.falseActivationRate === "number" && Number.isFinite(candidate.falseActivationRate) && candidate.falseActivationRate >= 0 && candidate.falseActivationRate < 0.1 && typeof candidate.executionInclusiveMedian === "number" && Number.isFinite(candidate.executionInclusiveMedian) && candidate.executionInclusiveMedian > 0 && typeof candidate.executionInclusiveP25 === "number" && Number.isFinite(candidate.executionInclusiveP25) && candidate.executionInclusiveP25 >= 0 && typeof candidate.nonNegativeActivatedRate === "number" && Number.isFinite(candidate.nonNegativeActivatedRate) && candidate.nonNegativeActivatedRate >= 0.8 && candidate.nonNegativeActivatedRate <= 1;
  return candidate.schemaVersion === 1 && typeof candidate.generatedAt === "string" && typeof candidate.enforcementEnabled === "boolean" && hasRequiredGates && (!candidate.enforcementEnabled || allGatesPass && evidencePasses);
}
function normalize(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const envKillSwitch = process.env.TOKENGRAPH_ROUTING_KILL_SWITCH;
  return {
    schemaVersion: CURRENT_ROUTING_CONTROL_SCHEMA,
    killSwitch: envKillSwitch === "1" || envKillSwitch === "true" || candidate.killSwitch === true,
    ...isValidatedPromotion(candidate.promotion) ? { promotion: candidate.promotion } : {}
  };
}
async function loadRoutingControl(root) {
  const directory = await repositoryDir(root);
  const path = routingControlPath(directory);
  try {
    return normalize(JSON.parse(await readFile5(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalize(void 0);
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(path);
      return normalize(void 0);
    }
    throw error;
  }
}
async function saveRoutingControl(root, control) {
  const directory = await repositoryDir(root);
  const path = routingControlPath(directory);
  const normalized = normalize(control);
  const key = await canonicalPersistenceLockKey(directory, "routing-control.json");
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(path, normalized));
  return normalized;
}

// src/core/pairedEval.ts
function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function random(seed) {
  let state = seed || 1;
  return () => {
    state = state * 1664525 + 1013904223 >>> 0;
    return state / 4294967296;
  };
}
function pairedBootstrap(values, iterations = 2e3, seed = 17) {
  const estimate = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  if (!values.length) return { estimate: 0, lower: 0, upper: 0, samples: 0 };
  const next = random(seed);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(next() * values.length)];
    means.push(total / values.length);
  }
  return { estimate, lower: quantile(means, 0.025), upper: quantile(means, 0.975), samples: values.length };
}
function validateTrace(trace) {
  if (!trace.taskId || !trace.category || !["on", "off"].includes(trace.condition) || !Number.isFinite(trace.tokens) || trace.tokens < 0 || !Number.isFinite(trace.quality) || trace.executionInclusiveTokens !== void 0 && (!Number.isFinite(trace.executionInclusiveTokens) || trace.executionInclusiveTokens < 0)) throw new Error("Invalid host evaluation trace.");
}
function validShadowObservation(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return candidate.mode === "shadow" && (candidate.decision === "activate" || candidate.decision === "bypass") && (candidate.stage === 0 || candidate.stage === 1) && typeof candidate.reason === "string" && candidate.reason.length > 0 && typeof candidate.expectedOverheadTokens === "number" && Number.isFinite(candidate.expectedOverheadTokens) && candidate.expectedOverheadTokens >= 0 && typeof candidate.falseBypass === "boolean" && typeof candidate.falseActivation === "boolean";
}
function validProtocol(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return Number.isInteger(candidate.runsPerTask) && candidate.runsPerTask >= 1 && Number.isInteger(candidate.minimumPerCategorySamples) && candidate.minimumPerCategorySamples >= 10 && typeof candidate.qualityNonInferiorityMargin === "number" && Number.isFinite(candidate.qualityNonInferiorityMargin) && candidate.qualityNonInferiorityMargin >= 0 && typeof candidate.tokenSuperiorityMinimum === "number" && Number.isFinite(candidate.tokenSuperiorityMinimum) && candidate.tokenSuperiorityMinimum >= 0 && typeof candidate.resourceLimit === "number" && Number.isFinite(candidate.resourceLimit) && candidate.resourceLimit >= 0 && typeof candidate.routerRateMaximum === "number" && Number.isFinite(candidate.routerRateMaximum) && candidate.routerRateMaximum > 0 && candidate.routerRateMaximum <= 0.1 && typeof candidate.executionMedianMinimum === "number" && Number.isFinite(candidate.executionMedianMinimum) && candidate.executionMedianMinimum >= 0 && typeof candidate.executionP25Minimum === "number" && Number.isFinite(candidate.executionP25Minimum) && candidate.executionP25Minimum >= 0 && typeof candidate.nonNegativeActivatedMinimum === "number" && Number.isFinite(candidate.nonNegativeActivatedMinimum) && candidate.nonNegativeActivatedMinimum >= 0.8 && candidate.nonNegativeActivatedMinimum <= 1;
}
function evaluatePaired(tasks, traces, options = {}) {
  for (const trace of traces) validateTrace(trace);
  const byTask = /* @__PURE__ */ new Map();
  for (const trace of traces) byTask.set(trace.taskId, [...byTask.get(trace.taskId) ?? [], trace]);
  const failures = [];
  const pairs = [];
  for (const task of tasks) {
    const pair = byTask.get(task.taskId) ?? [];
    const on = pair.find((trace) => trace.condition === "on");
    const off = pair.find((trace) => trace.condition === "off");
    if (!on || !off) {
      failures.push(`${task.taskId}:missing-pair`);
      continue;
    }
    if (on.timedOut || off.timedOut || on.failed || off.failed) failures.push(`${task.taskId}:failure-or-timeout`);
    pairs.push({ task, on, off });
  }
  const categoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, pairs.filter((pair) => pair.task.category === category).length]));
  const minimumCategorySamples = options.minimumCategorySamples ?? 10;
  const minimumSamples = Object.values(categoryCounts).every((count) => count >= minimumCategorySamples);
  const tokenDifference = pairedBootstrap(pairs.map(({ on, off }) => on.tokens - off.tokens), 2e3, 11);
  const qualityDifference = pairedBootstrap(pairs.map(({ on, off }) => on.quality - off.quality), 2e3, 13);
  const executionSavingsValues = pairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens));
  const executionInclusiveSavings = pairedBootstrap(executionSavingsValues, 2e3, 19);
  const categoryIntervals = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category, index) => {
    const categoryPairs = pairs.filter((pair) => pair.task.category === category);
    return [category, {
      tokenDifference: pairedBootstrap(categoryPairs.map(({ on, off }) => on.tokens - off.tokens), 2e3, 101 + index),
      qualityDifference: pairedBootstrap(categoryPairs.map(({ on, off }) => on.quality - off.quality), 2e3, 201 + index),
      executionInclusiveSavings: pairedBootstrap(categoryPairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens)), 2e3, 301 + index)
    }];
  }));
  const activatedPairs = pairs.filter(({ on }) => validShadowObservation(on.routing) && on.routing.decision === "activate");
  const activatedExecutionSavings = activatedPairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens));
  const executionSorted = [...activatedExecutionSavings].sort((a, b) => a - b);
  const executionMedian = executionSorted.length ? executionSorted[Math.floor((executionSorted.length - 1) * 0.5)] : 0;
  const executionP25 = executionSorted.length ? executionSorted[Math.floor((executionSorted.length - 1) * 0.25)] : 0;
  const nonNegativeActivatedRate = activatedExecutionSavings.length ? activatedExecutionSavings.filter((value) => value >= 0).length / activatedExecutionSavings.length : 0;
  const routerObservations = pairs.flatMap(({ on }) => validShadowObservation(on.routing) ? [on.routing] : []);
  const routerObservationCategories = pairs.flatMap(({ task, on }) => validShadowObservation(on.routing) ? [task.category] : []);
  const routerCategoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, routerObservationCategories.filter((candidate) => candidate === category).length]));
  const falseBypassRate = routerObservations.length ? routerObservations.filter((observation) => observation.falseBypass).length / routerObservations.length : 0;
  const falseActivationRate = routerObservations.length ? routerObservations.filter((observation) => observation.falseActivation).length / routerObservations.length : 0;
  const qualityMargin = options.qualityMargin ?? 0.02;
  const qualityNonInferiority = qualityDifference.lower >= -qualityMargin;
  const tokenSuperiority = tokenDifference.upper <= -(options.tokenSuperiority ?? 1);
  const resourceLimit = options.resourceLimit;
  const resources = resourceLimit === void 0 || pairs.every(({ on, off }) => (on.resourceUnits ?? 0) <= resourceLimit && (off.resourceUnits ?? 0) <= resourceLimit);
  const routerRateMaximum = options.routerRateMaximum ?? 0.1;
  if (Object.values(routerCategoryCounts).some((count) => count < 10)) failures.push("router-shadow-sample-incomplete");
  const gates = {
    minimumSamples,
    qualityNonInferiority,
    tokenSuperiority,
    resources,
    routerRates: Object.values(routerCategoryCounts).every((count) => count >= 10) && falseBypassRate < routerRateMaximum && falseActivationRate < routerRateMaximum,
    executionMedian: executionMedian > (options.executionMedianMinimum ?? 0),
    executionP25: executionP25 >= (options.executionP25Minimum ?? 0),
    nonNegativeActivated: nonNegativeActivatedRate >= (options.nonNegativeActivatedMinimum ?? 0.8)
  };
  return {
    taskCount: pairs.length,
    categoryCounts,
    tokenDifference,
    qualityDifference,
    executionInclusiveSavings,
    gates,
    routerRates: { falseBypassRate, falseActivationRate, observationCount: routerObservations.length, categoryCounts: routerCategoryCounts },
    executionInclusive: { median: executionMedian, p25: executionP25, nonNegativeActivatedRate },
    categoryIntervals,
    enforcementEnabled: Object.values(gates).every(Boolean) && failures.length === 0,
    failures
  };
}
function evaluateManifest(manifest) {
  const protocol = manifest.protocol;
  return evaluatePaired(manifest.tasks, manifest.traces, {
    minimumCategorySamples: protocol.minimumPerCategorySamples,
    qualityMargin: protocol.qualityNonInferiorityMargin,
    tokenSuperiority: protocol.tokenSuperiorityMinimum,
    resourceLimit: protocol.resourceLimit,
    routerRateMaximum: protocol.routerRateMaximum,
    executionMedianMinimum: protocol.executionMedianMinimum,
    executionP25Minimum: protocol.executionP25Minimum,
    nonNegativeActivatedMinimum: protocol.nonNegativeActivatedMinimum
  });
}
function parseEvaluationManifest(value) {
  if (!value || typeof value !== "object") throw new Error("Evaluation manifest must be an object.");
  const candidate = value;
  const model = candidate.model && typeof candidate.model === "object" ? candidate.model : void 0;
  const host = candidate.host && typeof candidate.host === "object" ? candidate.host : void 0;
  const plugin = candidate.plugin && typeof candidate.plugin === "object" ? candidate.plugin : void 0;
  if (candidate.schemaVersion !== 1 || typeof candidate.generatedAt !== "string" || typeof candidate.seed !== "string" || !model || typeof model.identifier !== "string" || !model.identifier || typeof model.versionOrDate !== "string" || !model.versionOrDate || typeof candidate.reasoningLevel !== "string" || !candidate.reasoningLevel || !host || typeof host.name !== "string" || !host.name || typeof host.version !== "string" || !host.version || !plugin || typeof plugin.version !== "string" || !plugin.version || typeof plugin.commit !== "string" || !plugin.commit || typeof candidate.repositoryCommit !== "string" || !candidate.repositoryCommit || typeof candidate.promptTemplate !== "string" || !candidate.promptTemplate || !candidate.toolConfiguration || typeof candidate.toolConfiguration !== "object" || Array.isArray(candidate.toolConfiguration) || typeof candidate.cacheState !== "string" || !candidate.cacheState || candidate.indexState !== "cold" && candidate.indexState !== "warm" || !validProtocol(candidate.protocol) || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.traces)) throw new Error("Evaluation manifest schema is invalid.");
  const tasks = candidate.tasks.filter((task) => Boolean(task && typeof task.taskId === "string" && typeof task.category === "string"));
  const traces = candidate.traces.filter((trace) => Boolean(trace && typeof trace.taskId === "string" && typeof trace.category === "string"));
  if (tasks.length !== candidate.tasks.length || traces.length !== candidate.traces.length) throw new Error("Evaluation manifest contains malformed tasks or traces.");
  return {
    schemaVersion: 1,
    generatedAt: candidate.generatedAt,
    seed: candidate.seed,
    model: { identifier: model.identifier, versionOrDate: model.versionOrDate },
    reasoningLevel: candidate.reasoningLevel,
    host: { name: host.name, version: host.version },
    plugin: { version: plugin.version, commit: plugin.commit },
    repositoryCommit: candidate.repositoryCommit,
    promptTemplate: candidate.promptTemplate,
    toolConfiguration: candidate.toolConfiguration,
    cacheState: candidate.cacheState,
    indexState: candidate.indexState,
    protocol: candidate.protocol,
    tasks,
    traces
  };
}
async function loadEvaluationManifest(path) {
  return parseEvaluationManifest(JSON.parse(await readFile6(path, "utf8")));
}
async function persistPromotionReport(root, report) {
  const promotion = {
    schemaVersion: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    enforcementEnabled: report.enforcementEnabled,
    gates: report.gates,
    falseBypassRate: report.routerRates.falseBypassRate,
    falseActivationRate: report.routerRates.falseActivationRate,
    executionInclusiveMedian: report.executionInclusive.median,
    executionInclusiveP25: report.executionInclusive.p25,
    nonNegativeActivatedRate: report.executionInclusive.nonNegativeActivatedRate,
    categoryCounts: report.routerRates.categoryCounts
  };
  const current = await loadRoutingControl(root);
  if (report.enforcementEnabled) {
    await saveRoutingControl(root, { ...current, promotion });
  } else {
    await saveRoutingControl(root, { schemaVersion: current.schemaVersion, killSwitch: current.killSwitch });
  }
  return promotion;
}

// src/cli.ts
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
async function main(argv) {
  if (argv[0] === "evaluate-routing") {
    const options2 = argv.slice(1);
    const root2 = optionValue(options2, "--root") ?? process.cwd();
    const manifestPath = optionValue(options2, "--manifest");
    if (!manifestPath) throw new Error("Usage: tokengraph evaluate-routing [--root <path>] --manifest <path>");
    const report = evaluateManifest(await loadEvaluationManifest(manifestPath));
    const promotion = await persistPromotionReport(root2, report);
    process.stdout.write(`${JSON.stringify({ ...report, promotion })}
`);
    if (!report.enforcementEnabled) process.exitCode = 1;
    return;
  }
  if (argv[0] === "purge") {
    const root2 = optionValue(argv.slice(1), "--root") ?? process.cwd();
    const storageClass = optionValue(argv.slice(1), "--class");
    if (!storageClass || !["runs", "cache", "outcomes", "derived"].includes(storageClass)) {
      throw new Error("Usage: tokengraph purge [--root <path>] --class runs|cache|outcomes|derived");
    }
    process.stdout.write(`${JSON.stringify(await purgeStorageClass(root2, storageClass))}
`);
    return;
  }
  if (argv[0] !== "run") throw new Error("Usage: tokengraph run [--root <path>] [--timeout-ms <n>] [--max-bytes <n>] [--test <name>] [--file <path>] [--error-class <name>] -- <command> [args...]; tokengraph purge [--root <path>] --class runs|cache|outcomes|derived; or tokengraph evaluate-routing [--root <path>] --manifest <path>");
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("tokengraph run requires `-- <command> [args...]`.");
  const commandArgs = argv.slice(separator + 1);
  const options = argv.slice(1, separator);
  const root = optionValue(options, "--root") ?? process.cwd();
  const config = await loadTokenGraphConfig(root);
  const timeoutMs = Number(optionValue(options, "--timeout-ms") ?? config.runner.timeoutMs);
  const maxBytes = Number(optionValue(options, "--max-bytes") ?? config.runner.maxBytes);
  const metadata = {
    ...optionValue(options, "--test") ? { test: optionValue(options, "--test") } : {},
    ...optionValue(options, "--file") ? { file: optionValue(options, "--file") } : {},
    ...optionValue(options, "--error-class") ? { errorClass: optionValue(options, "--error-class") } : {}
  };
  const retentionCutoff = () => new Date(Date.now() - config.storage.runRetentionDays * 24 * 60 * 60 * 1e3);
  await purgeRuns(root, retentionCutoff());
  const run = await executeRun({ root, command: commandArgs[0], args: commandArgs.slice(1), timeoutMs, maxBytes, ...Object.keys(metadata).length ? { metadata } : {} });
  await assertStorageWriteAllowed(root, "runs", Buffer.byteLength(`${JSON.stringify(run, null, 2)}
`, "utf8"), config.storage);
  await saveRun(root, run);
  await purgeRuns(root, retentionCutoff());
  process.stdout.write(`${JSON.stringify({ ...summarizeRun(run), stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated })}
`);
  if (run.status !== "completed") process.exitCode = run.status === "timed-out" ? 124 : 1;
}
main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 2;
});
