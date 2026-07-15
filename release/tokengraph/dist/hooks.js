#!/usr/bin/env node

// src/hooks.ts
import { createHash } from "node:crypto";
import { mkdir as mkdir2, open as open2, readFile as readFile3, readdir as readdir2, rm as rm3, stat as stat2 } from "node:fs/promises";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join3, resolve as resolve3 } from "node:path";

// src/core/taskEstimator.ts
var TASK_ESTIMATOR_VERSION = "task-estimator-v1";
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isConfidence(value) {
  return value === "low" || value === "medium" || value === "high";
}
function isQualityStatus(value) {
  return value === "passed" || value === "warning" || value === "not_evaluated";
}
function reconstructTaskReport(value, expectedTaskId, expectedEventCount) {
  if (!isRecord(value) || !isRecord(value.estimate) || !isRecord(value.estimate.range) || !isRecord(value.quality)) {
    return void 0;
  }
  const range = value.estimate.range;
  const basis = value.estimate.basis;
  const checks = value.quality.checks;
  if (value.taskId !== expectedTaskId || value.eventCount !== expectedEventCount || !Number.isInteger(value.eventCount) || !isFiniteNumber(range.low) || !isFiniteNumber(range.likely) || !isFiniteNumber(range.high) || range.low > range.likely || range.likely > range.high || range.unit !== "estimated_tokens" || !isConfidence(value.estimate.confidence) || !Array.isArray(basis) || !basis.every((item) => typeof item === "string") || !isFiniteNumber(value.estimate.overhead) || value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION || !isQualityStatus(value.quality.status) || !Array.isArray(checks) || !checks.every((item) => typeof item === "string")) {
    return void 0;
  }
  return {
    taskId: value.taskId,
    eventCount: value.eventCount,
    estimate: {
      range: { low: range.low, likely: range.likely, high: range.high, unit: "estimated_tokens" },
      confidence: value.estimate.confidence,
      basis: [...basis],
      overhead: value.estimate.overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    quality: { status: value.quality.status, checks: [...checks] }
  };
}
function formatTaskReportFooter(report) {
  if (report.eventCount === 0) {
    return "TokenGraph: savings not measured (no qualifying task events).";
  }
  const { low, high } = report.estimate.range;
  const formatValue = (value) => Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(1))}`;
  const savings = low === high ? formatValue(low) : low < 0 && high >= 0 ? `${formatValue(low)} to ${formatValue(high)}` : `${formatValue(low)}-${formatValue(high)}`;
  const quality = report.quality.status === "not_evaluated" ? "not evaluated" : report.quality.status;
  return `TokenGraph: ~${savings} tokens saved (estimated, ${report.estimate.confidence} confidence); quality ${quality}.`;
}

// src/core/taskLedger.ts
import { readFile as readFile2, readdir, rename as rename2, rm as rm2 } from "node:fs/promises";
import { join as join2, resolve as resolve2 } from "node:path";

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

// src/core/taskLedger.ts
var TASK_LEDGER_SCHEMA_ID = "tokengraph-task-ledger";
var TASK_LEDGER_SCHEMA_VERSION = 1;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var taskLedgerWriteChains = /* @__PURE__ */ new Map();
function assertTaskId(taskId) {
  if (!UUID_PATTERN.test(taskId)) {
    throw new Error("Task id must be a UUID.");
  }
}
function tasksDirectory(root) {
  return join2(resolve2(root), ".tokengraph", "tasks");
}
function taskLedgerPath(root, taskId) {
  assertTaskId(taskId);
  return join2(tasksDirectory(root), `${taskId}.json`);
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isOptionalIdentifier(value) {
  return value === void 0 || isIdentifier(value);
}
function reconstructQualityCheck(value) {
  if (!isRecord2(value) || typeof value.name !== "string" || typeof value.passed !== "boolean") return void 0;
  return { name: value.name, passed: value.passed };
}
function reconstructEvent(value) {
  if (!isRecord2(value) || !Array.isArray(value.qualityChecks)) return void 0;
  const qualityChecks = value.qualityChecks.map(reconstructQualityCheck);
  if (typeof value.id !== "string" || typeof value.fingerprint !== "string" || typeof value.category !== "string" || typeof value.toolName !== "string" || typeof value.originalTokens !== "number" || !Number.isFinite(value.originalTokens) || value.originalTokens < 0 || typeof value.compactTokens !== "number" || !Number.isFinite(value.compactTokens) || value.compactTokens < 0 || typeof value.overheadTokens !== "number" || !Number.isFinite(value.overheadTokens) || value.overheadTokens < 0 || value.confidence !== "low" && value.confidence !== "medium" && value.confidence !== "high" || !isTimestamp(value.timestamp) || qualityChecks.some((check) => check === void 0)) {
    return void 0;
  }
  return {
    id: value.id,
    fingerprint: value.fingerprint,
    category: value.category,
    toolName: value.toolName,
    originalTokens: value.originalTokens,
    compactTokens: value.compactTokens,
    overheadTokens: value.overheadTokens,
    confidence: value.confidence,
    timestamp: value.timestamp,
    qualityChecks
  };
}
function reconstructTaskLedger(value, expectedTaskId) {
  if (!isRecord2(value) || !Array.isArray(value.events)) return void 0;
  const events = value.events.map(reconstructEvent);
  if (value.schemaId !== TASK_LEDGER_SCHEMA_ID || value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || value.taskId !== expectedTaskId || !["codex", "claude", "unknown"].includes(String(value.host)) || !["open", "paused", "completed", "quarantined"].includes(String(value.status)) || !isOptionalIdentifier(value.sessionId) || !isOptionalIdentifier(value.turnId) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.pausedAt !== void 0 && !isTimestamp(value.pausedAt) || value.completedAt !== void 0 && !isTimestamp(value.completedAt) || value.estimatorVersion !== TASK_ESTIMATOR_VERSION || events.some((event) => event === void 0) || value.lastDisposition !== void 0 && value.lastDisposition !== "pause" && value.lastDisposition !== "complete" || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && Date.parse(value.pausedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && Date.parse(value.pausedAt) > Date.parse(value.updatedAt) || value.completedAt !== void 0 && Date.parse(value.completedAt) < Date.parse(value.createdAt) || value.completedAt !== void 0 && Date.parse(value.completedAt) > Date.parse(value.updatedAt)) {
    return void 0;
  }
  const completedReport = value.completedReport === void 0 ? void 0 : reconstructTaskReport(value.completedReport, expectedTaskId, events.length);
  if (value.completedReport !== void 0 && completedReport === void 0) return void 0;
  if (value.status === "open" && (value.pausedAt !== void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== void 0)) {
    return void 0;
  }
  if (value.status === "paused" && (value.pausedAt === void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== "pause")) {
    return void 0;
  }
  if (value.status === "completed" && (value.completedAt === void 0 || completedReport === void 0 || value.lastDisposition !== "complete")) {
    return void 0;
  }
  return {
    schemaId: TASK_LEDGER_SCHEMA_ID,
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    taskId: expectedTaskId,
    host: value.host,
    ...value.sessionId === void 0 ? {} : { sessionId: value.sessionId },
    ...value.turnId === void 0 ? {} : { turnId: value.turnId },
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...value.pausedAt === void 0 ? {} : { pausedAt: value.pausedAt },
    ...value.completedAt === void 0 ? {} : { completedAt: value.completedAt },
    estimatorVersion: TASK_ESTIMATOR_VERSION,
    events,
    ...value.lastDisposition === void 0 ? {} : { lastDisposition: value.lastDisposition },
    ...completedReport === void 0 ? {} : { completedReport }
  };
}
async function quarantine(path, now = /* @__PURE__ */ new Date()) {
  const timestamp = now.toISOString().replaceAll(":", "-");
  try {
    await rename2(path, `${path}.quarantine-${timestamp}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function enqueueLedgerOperation(root, taskId, operation) {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "tasks", `${taskId}.json`);
  const previous = taskLedgerWriteChains.get(key) ?? Promise.resolve();
  const runWithFileLock = async () => withFileLock(`${taskLedgerPath(root, taskId)}.lock`, operation);
  const current = previous.then(runWithFileLock, runWithFileLock);
  let settled;
  const cleanUp = () => {
    if (taskLedgerWriteChains.get(key) === settled) {
      taskLedgerWriteChains.delete(key);
    }
  };
  settled = current.then(cleanUp, cleanUp);
  taskLedgerWriteChains.set(key, settled);
  return current;
}
async function attachTaskHostContext(root, taskId, context) {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId);
    assertPausedTaskIsTerminal(ledger);
    if (context.host !== "codex" && context.host !== "claude" && context.host !== "unknown") {
      throw new Error("Host context must identify codex, claude, or unknown.");
    }
    if (!isIdentifier(context.sessionId)) throw new Error("Session id must be non-empty.");
    if (!isIdentifier(context.turnId)) throw new Error("Turn id must be non-empty.");
    if (context.host !== "unknown" && ledger.host !== "unknown" && ledger.host !== context.host) {
      throw new Error(`Host context conflict: task is already associated with ${ledger.host}.`);
    }
    if (ledger.sessionId !== void 0 && ledger.sessionId !== context.sessionId) {
      throw new Error("Session context conflict: task is already associated with another session id.");
    }
    if (context.host !== "unknown") ledger.host = context.host;
    ledger.sessionId = context.sessionId;
    ledger.turnId = context.turnId;
    ledger.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}
async function loadTaskLedger(root, taskId) {
  const path = taskLedgerPath(root, taskId);
  try {
    const parsed = JSON.parse(await readFile2(path, "utf8"));
    const ledger = reconstructTaskLedger(parsed, taskId);
    if (!ledger) {
      await quarantine(path);
      return void 0;
    }
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    if (error instanceof SyntaxError) {
      await quarantine(path);
      return void 0;
    }
    throw error;
  }
}
async function requireTaskLedger(root, taskId) {
  const ledger = await loadTaskLedger(root, taskId);
  if (!ledger) throw new Error(`Task ledger ${taskId} was not found or was corrupt.`);
  return ledger;
}
function assertPausedTaskIsTerminal(ledger) {
  if (ledger.status === "paused") {
    throw new Error(`Paused task ${ledger.taskId} is terminal and cannot accept task-aware calls or events. Start a new task with tokengraph_prepare_context or omit taskId on a direct intent call.`);
  }
}

// src/hooks.ts
var POINTER_SCHEMA_ID = "tokengraph-hook-session";
var POINTER_SCHEMA_VERSION = 1;
var POINTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
var LOCK_STALE_MS = 3e4;
var LOCK_WAIT_MS = 10;
var LOCK_ATTEMPTS = 200;
var WINDOWS_FS_RETRY_ATTEMPTS = 20;
var UUID_PATTERN2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var HASH_PATTERN = /^[0-9a-f]{64}$/;
var TASK_AWARE_TOOLS = /* @__PURE__ */ new Set([
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
]);
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isIdentifier2(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}
function isTimestamp2(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function sessionHash(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex");
}
function dataRoot() {
  const value = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  return isIdentifier2(value) ? resolve3(value) : void 0;
}
function sessionsDirectory(root) {
  return join3(root, "sessions");
}
function pointerPath(root, hash) {
  if (!HASH_PATTERN.test(hash)) throw new Error("Invalid session hash.");
  return join3(sessionsDirectory(root), `${hash}.json`);
}
function reconstructPointer(value, expectedHash) {
  if (!isRecord3(value)) return void 0;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["root", "schemaId", "schemaVersion", "sessionHash", "taskId", "turnId", "updatedAt"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return void 0;
  if (value.schemaId !== POINTER_SCHEMA_ID || value.schemaVersion !== POINTER_SCHEMA_VERSION || value.sessionHash !== expectedHash || typeof value.taskId !== "string" || !UUID_PATTERN2.test(value.taskId) || typeof value.root !== "string" || !isAbsolute2(value.root) || !isIdentifier2(value.turnId) || !isTimestamp2(value.updatedAt)) {
    return void 0;
  }
  return {
    schemaId: POINTER_SCHEMA_ID,
    schemaVersion: POINTER_SCHEMA_VERSION,
    sessionHash: expectedHash,
    taskId: value.taskId,
    root: value.root,
    turnId: value.turnId,
    updatedAt: value.updatedAt
  };
}
async function loadPointer(root, hash) {
  try {
    const parsed = JSON.parse(await readFile3(pointerPath(root, hash), "utf8"));
    const pointer = reconstructPointer(parsed, hash);
    return pointer ? { status: "valid", pointer } : { status: "corrupt" };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    if (error instanceof SyntaxError) return { status: "corrupt" };
    throw error;
  }
}
async function wait2(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
function isTransientWindowsFsError2(error) {
  return process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code));
}
async function retryTransientWindowsFs2(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsFsError2(error) || attempt >= WINDOWS_FS_RETRY_ATTEMPTS - 1) throw error;
      await wait2(LOCK_WAIT_MS);
    }
  }
}
async function withPointerLock(path, operation) {
  const lockPath = `${path}.lock`;
  await mkdir2(dirname2(lockPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open2(lockPath, "wx");
      try {
        return await operation();
      } finally {
        await handle.close();
        await retryTransientWindowsFs2(async () => rm3(lockPath, { force: true }));
      }
    } catch (error) {
      if (error.code !== "EEXIST" && !isTransientWindowsFsError2(error)) throw error;
      try {
        const lockStats = await stat2(lockPath);
        if (Date.now() - lockStats.mtimeMs > LOCK_STALE_MS) await rm3(lockPath, { force: true });
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
      }
      await wait2(LOCK_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for the session pointer lock.");
}
async function prunePointers(root, now = /* @__PURE__ */ new Date()) {
  let files;
  try {
    files = await readdir2(sessionsDirectory(root));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const cutoff = now.getTime() - POINTER_RETENTION_MS;
  await Promise.all(files.filter((file) => HASH_PATTERN.test(file.slice(0, -5)) && file.endsWith(".json")).map(async (file) => {
    const hash = file.slice(0, -5);
    const path = pointerPath(root, hash);
    await withPointerLock(path, async () => {
      const loaded = await loadPointer(root, hash);
      if (loaded.status === "missing") return;
      const expired = loaded.status === "valid" ? Date.parse(loaded.pointer.updatedAt) < cutoff : (await stat2(path)).mtimeMs < cutoff;
      if (expired) await retryTransientWindowsFs2(async () => rm3(path, { force: true }));
    });
  }));
}
function detectHost() {
  const explicit = process.env.TOKENGRAPH_HOOK_HOST;
  if (explicit === "codex" || explicit === "claude") return explicit;
  if (isIdentifier2(process.env.PLUGIN_ROOT)) return "codex";
  if (isIdentifier2(process.env.CLAUDE_PLUGIN_ROOT)) return "claude";
  return "unknown";
}
function normalizeToolName(value) {
  if (typeof value !== "string") return void 0;
  const candidate = value.split("__").at(-1);
  if (!candidate || !/^tokengraph_[a-z0-9_]+$/.test(candidate) || !TASK_AWARE_TOOLS.has(candidate)) return void 0;
  return candidate;
}
function responsePayload(response) {
  if (!isRecord3(response)) return void 0;
  const structured = isRecord3(response.structuredContent) ? response.structuredContent : isRecord3(response.structured_content) ? response.structured_content : void 0;
  if (structured) return structured;
  if (!Array.isArray(response.content) || response.content.length !== 1) return void 0;
  const item = response.content[0];
  if (!isRecord3(item) || item.type !== "text" || typeof item.text !== "string") return void 0;
  try {
    const parsed = JSON.parse(item.text);
    return isRecord3(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function responseReference(response, toolInput, hookInput, previous) {
  const payload = responsePayload(response);
  if (!payload || typeof payload.taskId !== "string" || !UUID_PATTERN2.test(payload.taskId)) return void 0;
  const candidates = [
    payload.root,
    isRecord3(toolInput) ? toolInput.root : void 0,
    previous.status === "valid" && previous.pointer.taskId === payload.taskId ? previous.pointer.root : void 0,
    hookInput.cwd,
    process.env.CLAUDE_PROJECT_DIR,
    process.env.TOKENGRAPH_WORKSPACE_ROOT
  ];
  const root = candidates.find((candidate) => typeof candidate === "string" && isAbsolute2(candidate));
  return root ? { taskId: payload.taskId, root } : void 0;
}
function taskInputReference(value, previous) {
  if (!isRecord3(value) || typeof value.taskId !== "string" || !UUID_PATTERN2.test(value.taskId)) return void 0;
  if (typeof value.root === "string") {
    return isAbsolute2(value.root) ? { taskId: value.taskId, root: value.root } : void 0;
  }
  if (value.root !== void 0 || previous.status !== "valid" || previous.pointer.taskId !== value.taskId) return void 0;
  return { taskId: value.taskId, root: previous.pointer.root };
}
function turnId(input) {
  if (isIdentifier2(input.turn_id)) return input.turn_id;
  if (isIdentifier2(input.prompt_id)) return input.prompt_id;
  if (isIdentifier2(input.tool_use_id)) return input.tool_use_id;
  return void 0;
}
async function postToolUse(input) {
  if (!isRecord3(input) || !isIdentifier2(input.session_id)) return {};
  const currentSessionId = input.session_id;
  const toolName = normalizeToolName(input.tool_name);
  if (!toolName) return {};
  const pluginData = dataRoot();
  if (!pluginData) {
    return { systemMessage: "TokenGraph plugin data is unavailable; task lifecycle tracking was skipped." };
  }
  const hash = sessionHash(currentSessionId);
  const previous = await loadPointer(pluginData, hash);
  const reference = taskInputReference(input.tool_input, previous) ?? responseReference(input.tool_response, input.tool_input, input, previous);
  const currentTurnId = turnId(input);
  if (!reference || !currentTurnId) return {};
  try {
    await withPointerLock(pointerPath(pluginData, hash), async () => {
      const ledger = await loadTaskLedger(reference.root, reference.taskId);
      if (!ledger) throw new Error("ledger-unavailable");
      const detected = detectHost();
      const effectiveHost = detected === "unknown" ? ledger.host : detected;
      await retryTransientWindowsFs2(async () => attachTaskHostContext(reference.root, reference.taskId, {
        host: effectiveHost,
        sessionId: currentSessionId,
        turnId: currentTurnId
      }));
      const pointer = {
        schemaId: POINTER_SCHEMA_ID,
        schemaVersion: POINTER_SCHEMA_VERSION,
        sessionHash: hash,
        taskId: reference.taskId,
        root: reference.root,
        turnId: currentTurnId,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await retryTransientWindowsFs2(async () => writeJsonAtomic(pointerPath(pluginData, hash), pointer));
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ledger-unavailable") {
      return { systemMessage: "TokenGraph task ledger is unavailable; task lifecycle tracking was skipped." };
    }
    if (error instanceof Error && /Paused task .* is terminal/.test(error.message)) {
      return { systemMessage: `${error.message} Lifecycle tracking was skipped.` };
    }
    const code = error.code;
    return { systemMessage: `TokenGraph lifecycle state update failed${code ? ` (${code})` : ""}; tracking was skipped.` };
  }
  await prunePointers(pluginData);
  return {};
}
function retryWarning(ledgerStatus, footer) {
  if (ledgerStatus === "completed" && footer) {
    return { systemMessage: `TokenGraph completion footer is still missing. Append exactly: ${footer}` };
  }
  return { systemMessage: "TokenGraph task is still open without a pause-or-complete report; allowing stop to prevent a hook retry loop." };
}
async function stop(input) {
  if (!isRecord3(input) || !isIdentifier2(input.session_id)) {
    return { systemMessage: "TokenGraph received invalid Stop hook input; lifecycle enforcement was skipped." };
  }
  const pluginData = dataRoot();
  if (!pluginData) {
    return { systemMessage: "TokenGraph plugin data is unavailable; lifecycle enforcement was skipped." };
  }
  const loaded = await loadPointer(pluginData, sessionHash(input.session_id));
  if (loaded.status === "missing") return {};
  if (loaded.status === "corrupt") {
    return { systemMessage: "TokenGraph session pointer state is corrupt; lifecycle enforcement was skipped." };
  }
  const ledger = await loadTaskLedger(loaded.pointer.root, loaded.pointer.taskId);
  if (!ledger) {
    return { systemMessage: "TokenGraph task ledger is missing or unavailable; lifecycle enforcement was skipped." };
  }
  if (ledger.status === "paused") return {};
  const isRetry = input.stop_hook_active === true;
  if (ledger.status === "open" && ledger.lastDisposition === void 0) {
    if (isRetry) return retryWarning("open");
    const pauseCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: loaded.pointer.root, disposition: "pause" })})`;
    const completeCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: loaded.pointer.root, disposition: "complete" })})`;
    return {
      decision: "block",
      reason: `Call exactly one of these exact calls, choosing pause if work is unfinished or complete if it is finished: ${pauseCall} OR ${completeCall}. Then report the returned status. Do not claim completion for an interrupt or API failure.`
    };
  }
  if (ledger.status === "completed" && ledger.completedReport) {
    const footer = formatTaskReportFooter(ledger.completedReport);
    const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    if (message.includes(footer)) return {};
    if (isRetry) return retryWarning("completed", footer);
    return { decision: "block", reason: `Append this exact canonical TokenGraph footer to the final response: ${footer}` };
  }
  return {};
}
async function readStdin() {
  let content = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    content += chunk;
    if (content.length > 1048576) throw new Error("Hook input exceeded the size limit.");
  }
  return JSON.parse(content);
}
async function main() {
  const event = process.argv[2];
  let output;
  try {
    const input = await readStdin();
    output = event === "post-tool-use" ? await postToolUse(input) : event === "stop" ? await stop(input) : {};
  } catch {
    output = { systemMessage: "TokenGraph hook state could not be processed; lifecycle enforcement was skipped." };
  }
  process.stdout.write(`${JSON.stringify(output)}
`);
}
await main();
