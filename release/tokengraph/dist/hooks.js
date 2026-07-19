#!/usr/bin/env node

// src/hooks.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdir as mkdir2, open as open2, readFile as readFile4, readdir as readdir2, rm as rm3, stat as stat2 } from "node:fs/promises";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join4, resolve as resolve4 } from "node:path";

// src/core/taskEstimator.ts
var TASK_ESTIMATOR_VERSION = "task-estimator-v2";
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
function reconstructCategory(value) {
  if (!isRecord(value) || !isRecord(value.range) || !Array.isArray(value.basis)) return void 0;
  if (typeof value.category !== "string" || value.category.length === 0 || !Number.isInteger(value.eventCount) || value.eventCount < 1 || !isFiniteNumber(value.range.low) || !isFiniteNumber(value.range.likely) || !isFiniteNumber(value.range.high) || value.range.low > value.range.likely || value.range.likely > value.range.high || value.range.unit !== "estimated_tokens" || !isConfidence(value.confidence) || !value.basis.every((item) => typeof item === "string") || !isFiniteNumber(value.overhead) || value.overhead < 0) return void 0;
  return {
    category: value.category,
    eventCount: value.eventCount,
    range: {
      low: value.range.low,
      likely: value.range.likely,
      high: value.range.high,
      unit: "estimated_tokens"
    },
    confidence: value.confidence,
    basis: [...value.basis],
    overhead: value.overhead
  };
}
function reconstructTaskReport(value, expectedTaskId, expectedEventCount) {
  if (!isRecord(value) || !isRecord(value.estimate) || !isRecord(value.estimate.range) || !isRecord(value.quality) || !Array.isArray(value.categories)) {
    return void 0;
  }
  const range = value.estimate.range;
  const basis = value.estimate.basis;
  const checks = value.quality.checks;
  const categories = value.categories.map(reconstructCategory);
  if (value.taskId !== expectedTaskId || value.eventCount !== expectedEventCount || !Number.isInteger(value.eventCount) || !isFiniteNumber(range.low) || !isFiniteNumber(range.likely) || !isFiniteNumber(range.high) || range.low > range.likely || range.likely > range.high || range.unit !== "estimated_tokens" || !isConfidence(value.estimate.confidence) || !Array.isArray(basis) || !basis.every((item) => typeof item === "string") || !isFiniteNumber(value.estimate.overhead) || value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION || !isQualityStatus(value.quality.status) || !Array.isArray(checks) || !checks.every((item) => typeof item === "string") || categories.some((entry) => entry === void 0)) {
    return void 0;
  }
  const reconstructedCategories = categories;
  if (reconstructedCategories.reduce((count, entry) => count + entry.eventCount, 0) !== expectedEventCount || reconstructedCategories.some((entry, index) => index > 0 && reconstructedCategories[index - 1].category.localeCompare(entry.category) >= 0)) return void 0;
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
    categories: reconstructedCategories,
    quality: { status: value.quality.status, checks: [...checks] }
  };
}
var confidenceRank = { low: 0, medium: 1, high: 2 };
function finite(value) {
  return Number.isFinite(value) ? value : 0;
}
function estimateEvents(events, calibration, reportOverheadTokens = 0) {
  let low = 0;
  let likely = 0;
  let high = 0;
  let overhead = 0;
  let confidence = events.length > 0 ? "high" : "low";
  const basis = /* @__PURE__ */ new Set();
  for (const event of events) {
    const original = Math.max(0, finite(event.originalTokens));
    const compact = Math.max(0, finite(event.compactTokens));
    const eventOverhead = Math.max(0, finite(event.overheadTokens));
    const net = original - compact - eventOverhead;
    const gross = original - compact;
    const categoryCalibration = calibration[event.category];
    const isCalibrated = Boolean(categoryCalibration && categoryCalibration.observations >= 10);
    likely += net;
    overhead += eventOverhead;
    if (isCalibrated && categoryCalibration) {
      low += net + finite(categoryCalibration.lowResidual);
      high += Math.max(net, gross, net + finite(categoryCalibration.highResidual));
      basis.add(`${event.category}:calibrated:${categoryCalibration.observations}`);
      if (confidenceRank[event.confidence] < confidenceRank[confidence]) confidence = event.confidence;
    } else {
      if (net < 0) low += net;
      high += Math.max(0, gross);
      confidence = "low";
      basis.add(`${event.category}:uncalibrated`);
    }
  }
  const reportOverhead = Math.max(0, finite(reportOverheadTokens));
  const hasNegativeEvent = events.some((event) => event.originalTokens - event.compactTokens - event.overheadTokens < 0);
  if (!hasNegativeEvent) low = Math.max(0, low);
  low = Math.min(low, likely);
  high = Math.max(likely, high);
  low -= reportOverhead;
  likely -= reportOverhead;
  high = Math.max(likely, high - reportOverhead);
  if (!hasNegativeEvent) low = Math.max(0, low);
  low = Math.min(low, likely);
  overhead += reportOverhead;
  return {
    range: { low, likely, high, unit: "estimated_tokens" },
    confidence,
    basis: [...basis].sort(),
    overhead
  };
}
function buildTaskReport(ledger, calibration = {}, reportOverheadTokens = 0) {
  const checks = [];
  let hasFailedCheck = false;
  for (const event of ledger.events) {
    for (const check of event.qualityChecks) {
      checks.push(`${check.name}:${check.passed ? "passed" : "failed"}`);
      if (!check.passed) {
        hasFailedCheck = true;
      }
    }
  }
  const aggregate = estimateEvents(ledger.events, calibration, reportOverheadTokens);
  const categories = [...new Set(ledger.events.map((event) => event.category))].sort((a, b) => a.localeCompare(b)).map((category) => {
    const events = ledger.events.filter((event) => event.category === category);
    return { category, eventCount: events.length, ...estimateEvents(events, calibration) };
  });
  return {
    taskId: ledger.taskId,
    eventCount: ledger.events.length,
    estimate: {
      range: aggregate.range,
      confidence: aggregate.confidence,
      basis: aggregate.basis,
      overhead: aggregate.overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    categories,
    quality: {
      status: hasFailedCheck ? "warning" : checks.length > 0 ? "passed" : "not_evaluated",
      checks
    }
  };
}
function formatTaskReportFooter(report) {
  if (report.eventCount === 0) {
    return "TokenGraph: savings not measured (no qualifying task events).";
  }
  const formatRange = (range) => {
    const { low, high } = range;
    const formatValue = (value) => Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(1))}`;
    return low === high ? formatValue(low) : low < 0 && high >= 0 ? `${formatValue(low)} to ${formatValue(high)}` : `${formatValue(low)}-${formatValue(high)}`;
  };
  const savings = formatRange(report.estimate.range);
  const quality = report.quality.status === "not_evaluated" ? "not evaluated" : report.quality.status;
  const aggregateFooter = `TokenGraph: ~${savings} tokens saved (estimated, ${report.estimate.confidence} confidence); quality ${quality}.`;
  const categoryText = report.categories.map((entry) => `${entry.category}=~${formatRange(entry.range)} (${entry.basis.join(",")})`).join("; ");
  return `${aggregateFooter.slice(0, -1)}; categories ${categoryText}.`;
}

// src/core/taskLedger.ts
import { readFile as readFile3, readdir, rename as rename2, rm as rm2 } from "node:fs/promises";
import { join as join3, resolve as resolve3 } from "node:path";

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

// src/core/repositoryIdentity.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, readFile as readFile2 } from "node:fs/promises";
import { join as join2, resolve as resolve2 } from "node:path";
var execFileAsync = promisify(execFile);
var LOCAL_EXCLUDE_WARNING = "TokenGraph could not update .git/info/exclude; add this exact line manually: .tokengraph/";
var setupWarnings = /* @__PURE__ */ new Map();
async function git(root, ...args) {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim();
    return output || void 0;
  } catch {
    return void 0;
  }
}
async function ensureLocalExclude(root) {
  const exclude = await git(root, "rev-parse", "--git-path", "info/exclude");
  if (!exclude) return;
  const path = resolve2(root, exclude);
  try {
    const lockKey = await canonicalPersistenceLockKey(path);
    await withFileLock(`${lockKey}.lock`, async () => {
      let existing = "";
      try {
        existing = await readFile2(path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const lines = existing.split(/\r?\n/);
      if (lines.some((line) => line.trim() === ".tokengraph/")) return;
      const next = `${existing.replace(/[\r\n]*$/, "")}${existing ? "\n" : ""}.tokengraph/
`;
      await writeTextAtomic(path, next);
    });
    setupWarnings.delete(resolve2(root));
  } catch {
    setupWarnings.set(resolve2(root), [LOCAL_EXCLUDE_WARNING]);
  }
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function remoteIdentity(root) {
  const remotes = await git(root, "remote", "get-url", "--all", "origin");
  return remotes?.split(/\r?\n/).map((value) => sanitizeRemote(value.trim())).filter(Boolean).sort().join("\n");
}
function sanitizeRemote(value) {
  const scpStyle = value.match(/^[^@\/\s]+@([^:\/\s]+):(.+)$/);
  if (scpStyle) return `ssh://${scpStyle[1]}/${scpStyle[2]}`;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/[^/@\s]+@/g, "//");
  }
}
async function loadOrCreateRepositoryId(directory) {
  const path = join2(directory, "identity.json");
  try {
    const parsed = JSON.parse(await readFile2(path, "utf8"));
    if (parsed.schemaVersion === 1 && typeof parsed.repositoryId === "string" && parsed.repositoryId.length >= 16) return parsed.repositoryId;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const repositoryId = digest(`${directory}
${Date.now()}
${Math.random()}`);
  const lockKey = await canonicalPersistenceLockKey(directory, "identity.json");
  await withFileLock(`${lockKey}.lock`, async () => {
    try {
      const existing = JSON.parse(await readFile2(path, "utf8"));
      if (existing.schemaVersion === 1 && typeof existing.repositoryId === "string" && existing.repositoryId.length >= 16) return;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await writeJsonAtomic(path, { schemaVersion: 1, repositoryId });
  });
  try {
    const persisted = JSON.parse(await readFile2(path, "utf8"));
    return typeof persisted.repositoryId === "string" ? persisted.repositoryId : repositoryId;
  } catch {
    return repositoryId;
  }
}
async function getRepositoryIdentity(root) {
  const workspaceRoot = resolve2(root);
  return getRepositoryIdentityUncached(workspaceRoot);
}
async function getRepositoryIdentityUncached(workspaceRoot) {
  const [topLevel, commonDir, gitDir, branch, headCommit, firstCommits, remote] = await Promise.all([
    git(workspaceRoot, "rev-parse", "--show-toplevel"),
    git(workspaceRoot, "rev-parse", "--git-common-dir"),
    git(workspaceRoot, "rev-parse", "--git-dir"),
    git(workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"),
    git(workspaceRoot, "rev-parse", "HEAD"),
    git(workspaceRoot, "rev-list", "--max-parents=0", "HEAD"),
    remoteIdentity(workspaceRoot)
  ]);
  const normalizedRoot = resolve2(topLevel ?? workspaceRoot);
  const normalizedCommon = commonDir ? resolve2(workspaceRoot, commonDir) : void 0;
  const normalizedGitDir = gitDir ? resolve2(workspaceRoot, gitDir) : void 0;
  if (topLevel && commonDir) await ensureLocalExclude(workspaceRoot);
  const repositoryState = repositoryStateDirectory(normalizedRoot, normalizedCommon);
  const repositoryId = await loadOrCreateRepositoryId(repositoryState);
  const firstCommit = firstCommits?.split(/\r?\n/).filter(Boolean).sort()[0] ?? "unborn";
  const repositoryFingerprint = digest(`${repositoryId}
${firstCommit}`);
  return {
    repositoryId,
    repositoryFingerprint,
    workspaceId: digest(normalizedRoot),
    worktreeId: digest(normalizedGitDir ?? normalizedRoot),
    branch: branch ?? "detached",
    headCommit: headCommit ?? "unborn",
    ...remote ? { remoteIdentity: remote } : {}
  };
}
function repositoryStateDirectory(root, commonDirectory) {
  return commonDirectory ? join2(commonDirectory, "tokengraph") : join2(resolve2(root), ".tokengraph", "repository");
}

// src/core/taskLedger.ts
var TASK_LEDGER_SCHEMA_ID = "tokengraph-task-ledger";
var TASK_LEDGER_SCHEMA_VERSION = 3;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var taskLedgerWriteChains = /* @__PURE__ */ new Map();
function assertTaskId(taskId) {
  if (!UUID_PATTERN.test(taskId)) {
    throw new Error("Task id must be a UUID.");
  }
}
function tasksDirectory(root) {
  return join3(resolve3(root), ".tokengraph", "tasks");
}
function taskLedgerPath(root, taskId) {
  assertTaskId(taskId);
  return join3(tasksDirectory(root), `${taskId}.json`);
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
function reconstructOutcome(value) {
  if (!isRecord2(value) || !Array.isArray(value.evidence)) return void 0;
  if (!isIdentifier(value.id) || !isIdentifier(value.taskId) || typeof value.summary !== "string" || value.summary.trim().length === 0 || !["verified", "proposed", "failed"].includes(String(value.status)) || !value.evidence.every((entry) => isIdentifier(entry)) || !isTimestamp(value.createdAt) || value.staleAt !== void 0 && !isTimestamp(value.staleAt) || value.sourceFingerprint !== void 0 && !isIdentifier(value.sourceFingerprint) || !isIdentifier(value.branch) || !isIdentifier(value.worktreeId) || !isIdentifier(value.headCommit)) return void 0;
  return {
    id: value.id,
    taskId: value.taskId,
    summary: value.summary,
    status: value.status,
    evidence: [...value.evidence],
    createdAt: value.createdAt,
    ...value.staleAt === void 0 ? {} : { staleAt: value.staleAt },
    ...value.sourceFingerprint === void 0 ? {} : { sourceFingerprint: value.sourceFingerprint },
    branch: value.branch,
    worktreeId: value.worktreeId,
    headCommit: value.headCommit
  };
}
function reconstructTaskLedger(value, expectedTaskId) {
  if (!isRecord2(value) || !Array.isArray(value.events)) return void 0;
  const legacy = value.schemaVersion === 1 || value.schemaVersion === 2;
  const events = value.events.map(reconstructEvent);
  const outcomes = value.outcomes === void 0 && legacy ? [] : Array.isArray(value.outcomes) ? value.outcomes.map(reconstructOutcome) : void 0;
  const routingObservation = value.routingObservation === void 0 ? void 0 : reconstructRoutingObservation(value.routingObservation);
  const readPolicy = value.readPolicy === void 0 ? void 0 : reconstructReadPolicy(value.readPolicy);
  const deliveredArtifacts = value.deliveredArtifacts === void 0 ? [] : Array.isArray(value.deliveredArtifacts) && value.deliveredArtifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) ? [...new Set(value.deliveredArtifacts)] : void 0;
  if (value.schemaId !== TASK_LEDGER_SCHEMA_ID || value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || value.taskId !== expectedTaskId || !["codex", "claude", "unknown"].includes(String(value.host)) || !["open", "paused", "completed", "quarantined"].includes(String(value.status)) || !isOptionalIdentifier(value.sessionId) || !isOptionalIdentifier(value.turnId) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.pausedAt !== void 0 && !isTimestamp(value.pausedAt) || value.completedAt !== void 0 && !isTimestamp(value.completedAt) || !legacy && value.estimatorVersion !== TASK_ESTIMATOR_VERSION || legacy && value.estimatorVersion !== "task-estimator-v1" && value.estimatorVersion !== TASK_ESTIMATOR_VERSION || value.repositoryIdentity !== void 0 && !isRepositoryIdentity(value.repositoryIdentity) || value.routingObservation !== void 0 && routingObservation === void 0 || value.readPolicy !== void 0 && readPolicy === void 0 || deliveredArtifacts === void 0 || outcomes === void 0 || outcomes.some((outcome) => outcome === void 0) || events.some((event) => event === void 0) || value.lastDisposition !== void 0 && value.lastDisposition !== "pause" && value.lastDisposition !== "complete" || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && Date.parse(value.pausedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && Date.parse(value.pausedAt) > Date.parse(value.updatedAt) || value.completedAt !== void 0 && Date.parse(value.completedAt) < Date.parse(value.createdAt) || value.completedAt !== void 0 && Date.parse(value.completedAt) > Date.parse(value.updatedAt)) {
    return void 0;
  }
  const completedReport = legacy && value.status === "completed" ? void 0 : value.completedReport === void 0 ? void 0 : reconstructTaskReport(value.completedReport, expectedTaskId, events.length);
  if (!legacy && value.completedReport !== void 0 && completedReport === void 0) return void 0;
  if (value.status === "open" && (value.pausedAt !== void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== void 0)) {
    return void 0;
  }
  if (value.status === "paused" && (value.pausedAt === void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== "pause")) {
    return void 0;
  }
  if (value.status === "completed" && (value.completedAt === void 0 || !legacy && completedReport === void 0 || value.completedReport === void 0 || value.lastDisposition !== "complete")) {
    return void 0;
  }
  const ledger = {
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
    ...value.repositoryIdentity === void 0 ? {} : { repositoryIdentity: value.repositoryIdentity },
    ...routingObservation === void 0 ? {} : { routingObservation },
    ...readPolicy === void 0 ? {} : { readPolicy },
    deliveredArtifacts,
    outcomes,
    events,
    ...value.lastDisposition === void 0 ? {} : { lastDisposition: value.lastDisposition },
    ...completedReport === void 0 ? {} : { completedReport }
  };
  if (legacy && ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
  return ledger;
}
function isRepositoryIdentity(value) {
  if (!isRecord2(value)) return false;
  return ["repositoryId", "repositoryFingerprint", "workspaceId", "worktreeId", "branch", "headCommit"].every((key) => isIdentifier(value[key]));
}
function reconstructRoutingObservation(value) {
  if (!isRecord2(value)) return void 0;
  if (value.decision !== "activate" && value.decision !== "bypass" || !Number.isInteger(value.stage) || value.stage < 0 || typeof value.reason !== "string" || typeof value.expectedOverheadTokens !== "number" || !Number.isFinite(value.expectedOverheadTokens) || value.expectedOverheadTokens < 0 || !["shadow", "enforced", "always-activate", "always-advisory"].includes(String(value.mode)) || typeof value.enforced !== "boolean") return void 0;
  return {
    decision: value.decision,
    stage: value.stage,
    reason: value.reason,
    expectedOverheadTokens: value.expectedOverheadTokens,
    mode: value.mode,
    enforced: value.enforced
  };
}
function reconstructReadPolicy(value) {
  if (!isRecord2(value)) return void 0;
  if (!["L0", "L1", "L2", "L3", "L4"].includes(String(value.level)) || typeof value.allowRawReads !== "boolean" || typeof value.reason !== "string" || value.targetedReads !== void 0 && (!Number.isInteger(value.targetedReads) || value.targetedReads < 0) || value.recommendedReadsThisResponse !== void 0 && (!Number.isInteger(value.recommendedReadsThisResponse) || value.recommendedReadsThisResponse < 0) || value.requiresReassessment !== void 0 && typeof value.requiresReassessment !== "boolean" || value.hasReassessed !== void 0 && typeof value.hasReassessed !== "boolean" || value.evidenceGap !== void 0 && typeof value.evidenceGap !== "string") return void 0;
  return {
    level: value.level,
    allowRawReads: value.allowRawReads,
    reason: value.reason,
    ...value.targetedReads === void 0 ? {} : { targetedReads: value.targetedReads },
    ...value.recommendedReadsThisResponse === void 0 ? {} : { recommendedReadsThisResponse: value.recommendedReadsThisResponse },
    ...value.requiresReassessment === void 0 ? {} : { requiresReassessment: value.requiresReassessment },
    ...value.hasReassessed === void 0 ? {} : { hasReassessed: value.hasReassessed },
    ...value.evidenceGap === void 0 ? {} : { evidenceGap: value.evidenceGap }
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
    const parsed = JSON.parse(await readFile3(path, "utf8"));
    if (isRecord2(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > TASK_LEDGER_SCHEMA_VERSION) {
      throw new Error(`Task ledger schema ${parsed.schemaVersion} is newer than supported schema ${TASK_LEDGER_SCHEMA_VERSION}; refusing to modify it.`);
    }
    const ledger = reconstructTaskLedger(parsed, taskId);
    if (!ledger) {
      await quarantine(path);
      return void 0;
    }
    if (!ledger.repositoryIdentity || isRecord2(parsed) && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)) {
      ledger.repositoryIdentity ??= await getRepositoryIdentity(root);
      ledger.schemaVersion = TASK_LEDGER_SCHEMA_VERSION;
      ledger.estimatorVersion = TASK_ESTIMATOR_VERSION;
      ledger.outcomes ??= [];
      if (ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
      await writeJsonAtomic(path, ledger);
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
  return createHash2("sha256").update(sessionId).digest("hex");
}
function dataRoot() {
  const value = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  return isIdentifier2(value) ? resolve4(value) : void 0;
}
function sessionsDirectory(root) {
  return join4(root, "sessions");
}
function pointerPath(root, hash) {
  if (!HASH_PATTERN.test(hash)) throw new Error("Invalid session hash.");
  return join4(sessionsDirectory(root), `${hash}.json`);
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
    const parsed = JSON.parse(await readFile4(pointerPath(root, hash), "utf8"));
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
