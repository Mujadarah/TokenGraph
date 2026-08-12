import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

import {
  TASK_ESTIMATOR_VERSION,
  buildTaskReport,
  reconstructTaskReport,
  type EstimateConfidence,
  type TaskCalibration,
  type TaskReport
} from "./taskEstimator.js";
import type { CanonicalPersistenceLock } from "./lockDomain.js";
import type { TaskOutcome } from "./memoryCore.js";
import type { RepositoryIdentity } from "./types.js";
import type { ReadPolicyState } from "./retrieval.js";

export const TASK_LEDGER_SCHEMA_ID = "tokengraph-task-ledger" as const;
export const TASK_LEDGER_SCHEMA_VERSION = 3 as const;
export const TASK_LEDGER_RETENTION_DAYS = 30;

export type TaskHost = "codex" | "claude" | "unknown";
export type TaskStatus = "open" | "paused" | "completed" | "quarantined";
export type TaskDisposition = "pause" | "complete";

export interface TaskQualityCheck {
  name: string;
  passed: boolean;
}

export interface TaskEvent {
  id: string;
  fingerprint: string;
  category: string;
  toolName: string;
  originalTokens: number;
  compactTokens: number;
  overheadTokens: number;
  confidence: EstimateConfidence;
  timestamp: string;
  qualityChecks: TaskQualityCheck[];
}

export interface TaskLedger {
  schemaId: typeof TASK_LEDGER_SCHEMA_ID;
  schemaVersion: typeof TASK_LEDGER_SCHEMA_VERSION;
  taskId: string;
  host: TaskHost;
  sessionId?: string;
  turnId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  completedAt?: string;
  estimatorVersion: typeof TASK_ESTIMATOR_VERSION;
  repositoryIdentity?: RepositoryIdentity;
  routingObservation?: TaskRoutingObservation;
  readPolicy?: ReadPolicyState;
  deliveredArtifacts: string[];
  outcomes: TaskOutcome[];
  events: TaskEvent[];
  lastDisposition?: TaskDisposition;
  completedReport?: TaskReport;
}

export type TaskLedgerReadOnlyInspection =
  | { status: "valid"; ledger: Readonly<TaskLedger> }
  | { status: "missing" | "invalid" | "unsupported" | "unstable" };

export interface TaskRoutingObservation {
  decision: "activate" | "bypass";
  stage: number;
  reason: string;
  expectedOverheadTokens: number;
  mode: "shadow" | "enforced" | "always-activate" | "always-advisory";
  enforced: boolean;
}

export interface CreateTaskLedgerOptions {
  host: TaskHost;
  sessionId?: string;
  turnId?: string;
}

export interface TaskHostContext {
  host: TaskHost;
  sessionId: string;
  turnId: string;
}

export interface SetTaskDispositionResult {
  ledger: TaskLedger;
  report?: TaskReport;
}

export interface PruneTaskLedgersResult {
  pruned: string[];
  quarantined: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETED_OUTCOMES_INDEX_SCHEMA_ID = "tokengraph-completed-outcomes-index";
const COMPLETED_OUTCOMES_INDEX_SCHEMA_VERSION = 1;
const MAX_COMPLETED_OUTCOMES = 100;
const taskLedgerWriteChains = new Map<string, Promise<void>>();
const MAX_READ_ONLY_LEDGER_BYTES = 8 * 1024 * 1024;
const CURRENT_LEDGER_KEYS = new Set([
  "schemaId", "schemaVersion", "taskId", "host", "sessionId", "turnId", "status",
  "createdAt", "updatedAt", "pausedAt", "completedAt", "estimatorVersion",
  "repositoryIdentity", "routingObservation", "readPolicy", "deliveredArtifacts",
  "outcomes", "events", "lastDisposition", "completedReport"
]);
const REQUIRED_CURRENT_LEDGER_KEYS = [
  "schemaId", "schemaVersion", "taskId", "host", "status", "createdAt", "updatedAt",
  "estimatorVersion", "deliveredArtifacts", "outcomes", "events"
] as const;

async function canonicalTaskLock(root: string, relativeDataName: string): Promise<CanonicalPersistenceLock> {
  const { canonicalPersistenceLock } = await import("./lockDomain.js");
  return canonicalPersistenceLock(root, "tasks", relativeDataName);
}

async function runWithTaskLock<T>(lock: CanonicalPersistenceLock, operation: () => Promise<T>): Promise<T> {
  const { withFileLock } = await import("./storage.js");
  return withFileLock(lock, operation);
}

async function writeTaskJson(path: string, value: unknown): Promise<void> {
  const { writeJsonAtomic } = await import("./storage.js");
  await writeJsonAtomic(path, value);
}

async function readRepositoryIdentity(root: string): Promise<RepositoryIdentity> {
  const { getRepositoryIdentity } = await import("./repositoryIdentity.js");
  return getRepositoryIdentity(root);
}

function assertTaskId(taskId: string): void {
  if (!UUID_PATTERN.test(taskId)) {
    throw new Error("Task id must be a UUID.");
  }
}

function tasksDirectory(root: string): string {
  return join(resolve(root), ".tokengraph", "tasks");
}

function taskLedgerPath(root: string, taskId: string): string {
  assertTaskId(taskId);
  return join(tasksDirectory(root), `${taskId}.json`);
}

export interface TaskLedgerStatSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly birthtimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type StablePathIdentity = TaskLedgerStatSnapshot;

interface StablePathSnapshotEntry {
  readonly kind: "directory" | "file";
  readonly identity: StablePathIdentity;
}

function stablePathIdentity(stats: BigIntStats | TaskLedgerStatSnapshot): StablePathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    birthtimeNs: stats.birthtimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

function sameStableIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameStableDirectory(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}

export function __compareTaskLedgerStatsForTests(
  left: TaskLedgerStatSnapshot,
  right: TaskLedgerStatSnapshot,
  comparison: "file" | "directory"
): boolean {
  const leftIdentity = stablePathIdentity(left);
  const rightIdentity = stablePathIdentity(right);
  return comparison === "file" ? sameStableIdentity(leftIdentity, rightIdentity) : sameStableDirectory(leftIdentity, rightIdentity);
}

async function snapshotLedgerPath(path: string): Promise<readonly StablePathSnapshotEntry[]> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  const identities: StablePathSnapshotEntry[] = [];
  let current = root;
  for (let index = 0; index < remainder.length; index += 1) {
    current = join(current, remainder[index]!);
    const stats = await lstat(current, { bigint: true });
    const kind = index === remainder.length - 1 ? "file" : "directory";
    if (stats.isSymbolicLink() || (kind === "file" ? !stats.isFile() || stats.nlink !== 1n : !stats.isDirectory())) {
      throw new Error("unstable-ledger-path");
    }
    identities.push({ kind, identity: stablePathIdentity(stats) });
  }
  return identities;
}

function samePathSnapshot(left: readonly StablePathSnapshotEntry[], right: readonly StablePathSnapshotEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index]!;
    return entry.kind === candidate.kind && (entry.kind === "file"
      ? sameStableIdentity(entry.identity, candidate.identity)
      : sameStableDirectory(entry.identity, candidate.identity));
  });
}

async function readStableTaskLedger(path: string): Promise<string> {
  const before = await snapshotLedgerPath(path);
  const entryBefore = before.at(-1)!.identity;
  if (entryBefore.size < 0n || entryBefore.size > BigInt(MAX_READ_ONLY_LEDGER_BYTES)) throw new Error("invalid-ledger-size");
  try {
    return await readOpenedTaskLedger(path, before, entryBefore);
  } catch (error) {
    // Only a genuine initial absence is missing; a disappearance seen after the read began is unstable.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("unstable-ledger-read");
    throw error;
  }
}

async function readOpenedTaskLedger(
  path: string,
  before: readonly StablePathSnapshotEntry[],
  entryBefore: StablePathIdentity
): Promise<string> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const handleBefore = await handle.stat({ bigint: true });
    const openedBefore = stablePathIdentity(handleBefore);
    if (!handleBefore.isFile() || handleBefore.nlink !== 1n || !sameStableIdentity(entryBefore, openedBefore)) {
      throw new Error("unstable-ledger-identity");
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_READ_ONLY_LEDGER_BYTES + 1 - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > MAX_READ_ONLY_LEDGER_BYTES) throw new Error("invalid-ledger-size");
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const handleAfter = stablePathIdentity(await handle.stat({ bigint: true }));
    const after = await snapshotLedgerPath(path);
    if (!sameStableIdentity(openedBefore, handleAfter) || !samePathSnapshot(before, after) || BigInt(bytesRead) !== handleAfter.size) {
      throw new Error("unstable-ledger-read");
    }
    return Buffer.concat(chunks, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// The strict current-schema decoder must reject coercion: a stringifiable value
// such as ["completed"] is not an accepted literal, so membership is tested on
// the parsed value itself instead of on String(value).
function isLiteral<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function decodeCurrentRepositoryIdentity(value: unknown): RepositoryIdentity | undefined {
  const required = ["repositoryId", "repositoryFingerprint", "workspaceId", "worktreeId", "branch", "headCommit"] as const;
  if (!hasExactKeys(value, required, ["remoteIdentity"]) || !required.every((key) => isIdentifier(value[key])) ||
      (value.remoteIdentity !== undefined && !isIdentifier(value.remoteIdentity))) return undefined;
  return {
    repositoryId: value.repositoryId as string,
    repositoryFingerprint: value.repositoryFingerprint as string,
    workspaceId: value.workspaceId as string,
    worktreeId: value.worktreeId as string,
    branch: value.branch as string,
    headCommit: value.headCommit as string,
    ...(value.remoteIdentity === undefined ? {} : { remoteIdentity: value.remoteIdentity })
  };
}

function decodeCurrentRoutingObservation(value: unknown): TaskRoutingObservation | undefined {
  if (!hasExactKeys(value, ["decision", "stage", "reason", "expectedOverheadTokens", "mode", "enforced"]) ||
      (value.decision !== "activate" && value.decision !== "bypass") || !Number.isInteger(value.stage) || (value.stage as number) < 0 ||
      typeof value.reason !== "string" || !finiteNonnegative(value.expectedOverheadTokens) ||
      !isLiteral(value.mode, ["shadow", "enforced", "always-activate", "always-advisory"] as const) || typeof value.enforced !== "boolean") return undefined;
  return {
    decision: value.decision,
    stage: value.stage as number,
    reason: value.reason,
    expectedOverheadTokens: value.expectedOverheadTokens,
    mode: value.mode as TaskRoutingObservation["mode"],
    enforced: value.enforced
  };
}

function decodeCurrentReadPolicy(value: unknown): ReadPolicyState | undefined {
  if (!hasExactKeys(value, ["level", "allowRawReads", "reason"], [
    "targetedReads", "recommendedReadsThisResponse", "requiresReassessment", "hasReassessed", "evidenceGap"
  ]) || !isLiteral(value.level, ["L0", "L1", "L2", "L3", "L4"] as const) || typeof value.allowRawReads !== "boolean" ||
      typeof value.reason !== "string" || (value.targetedReads !== undefined && (!Number.isInteger(value.targetedReads) || (value.targetedReads as number) < 0)) ||
      (value.recommendedReadsThisResponse !== undefined && (!Number.isInteger(value.recommendedReadsThisResponse) || (value.recommendedReadsThisResponse as number) < 0)) ||
      (value.requiresReassessment !== undefined && typeof value.requiresReassessment !== "boolean") ||
      (value.hasReassessed !== undefined && typeof value.hasReassessed !== "boolean") ||
      (value.evidenceGap !== undefined && typeof value.evidenceGap !== "string")) return undefined;
  return {
    level: value.level as ReadPolicyState["level"],
    allowRawReads: value.allowRawReads,
    reason: value.reason,
    ...(value.targetedReads === undefined ? {} : { targetedReads: value.targetedReads as number }),
    ...(value.recommendedReadsThisResponse === undefined ? {} : { recommendedReadsThisResponse: value.recommendedReadsThisResponse as number }),
    ...(value.requiresReassessment === undefined ? {} : { requiresReassessment: value.requiresReassessment }),
    ...(value.hasReassessed === undefined ? {} : { hasReassessed: value.hasReassessed }),
    ...(value.evidenceGap === undefined ? {} : { evidenceGap: value.evidenceGap })
  };
}

function decodeCurrentQualityCheck(value: unknown): TaskQualityCheck | undefined {
  if (!hasExactKeys(value, ["name", "passed"]) || typeof value.name !== "string" || typeof value.passed !== "boolean") return undefined;
  return { name: value.name, passed: value.passed };
}

function decodeCurrentEvent(value: unknown): TaskEvent | undefined {
  if (!hasExactKeys(value, [
    "id", "fingerprint", "category", "toolName", "originalTokens", "compactTokens", "overheadTokens", "confidence", "timestamp", "qualityChecks"
  ]) || typeof value.id !== "string" || typeof value.fingerprint !== "string" || typeof value.category !== "string" ||
      typeof value.toolName !== "string" || !finiteNonnegative(value.originalTokens) || !finiteNonnegative(value.compactTokens) ||
      !finiteNonnegative(value.overheadTokens) || !isLiteral(value.confidence, ["low", "medium", "high"] as const) ||
      !isTimestamp(value.timestamp) || !Array.isArray(value.qualityChecks)) return undefined;
  const qualityChecks = value.qualityChecks.map(decodeCurrentQualityCheck);
  if (qualityChecks.some((entry) => entry === undefined)) return undefined;
  return {
    id: value.id,
    fingerprint: value.fingerprint,
    category: value.category,
    toolName: value.toolName,
    originalTokens: value.originalTokens,
    compactTokens: value.compactTokens,
    overheadTokens: value.overheadTokens,
    confidence: value.confidence as EstimateConfidence,
    timestamp: value.timestamp,
    qualityChecks: qualityChecks as TaskQualityCheck[]
  };
}

function decodeCurrentOutcome(value: unknown, expectedTaskId: string): TaskOutcome | undefined {
  if (!hasExactKeys(value, [
    "id", "taskId", "summary", "status", "evidence", "createdAt", "branch", "worktreeId", "headCommit"
  ], ["staleAt", "sourceFingerprint"]) || !isIdentifier(value.id) || value.taskId !== expectedTaskId ||
      typeof value.summary !== "string" || value.summary.trim().length === 0 || !isLiteral(value.status, ["verified", "proposed", "failed"] as const) ||
      !Array.isArray(value.evidence) || !value.evidence.every(isIdentifier) || !isTimestamp(value.createdAt) ||
      (value.staleAt !== undefined && !isTimestamp(value.staleAt)) ||
      (value.sourceFingerprint !== undefined && !isIdentifier(value.sourceFingerprint)) || !isIdentifier(value.branch) ||
      !isIdentifier(value.worktreeId) || !isIdentifier(value.headCommit)) return undefined;
  return {
    id: value.id,
    taskId: value.taskId,
    summary: value.summary,
    status: value.status as TaskOutcome["status"],
    evidence: [...value.evidence] as string[],
    createdAt: value.createdAt,
    ...(value.staleAt === undefined ? {} : { staleAt: value.staleAt }),
    ...(value.sourceFingerprint === undefined ? {} : { sourceFingerprint: value.sourceFingerprint }),
    branch: value.branch,
    worktreeId: value.worktreeId,
    headCommit: value.headCommit
  };
}

function decodeCurrentRange(value: unknown): TaskReport["estimate"]["range"] | undefined {
  if (!hasExactKeys(value, ["low", "likely", "high", "unit"]) || typeof value.low !== "number" || !Number.isFinite(value.low) ||
      typeof value.likely !== "number" || !Number.isFinite(value.likely) || typeof value.high !== "number" || !Number.isFinite(value.high) ||
      value.low > value.likely || value.likely > value.high || value.unit !== "estimated_tokens") return undefined;
  return { low: value.low, likely: value.likely, high: value.high, unit: "estimated_tokens" };
}

function decodeCurrentTaskReport(value: unknown, expectedTaskId: string, expectedEventCount: number): TaskReport | undefined {
  if (!hasExactKeys(value, ["taskId", "eventCount", "estimate", "categories", "quality"]) || value.taskId !== expectedTaskId ||
      value.eventCount !== expectedEventCount || !Number.isInteger(value.eventCount) || !Array.isArray(value.categories) ||
      !hasExactKeys(value.estimate, ["range", "confidence", "basis", "overhead", "estimatorVersion"]) ||
      !hasExactKeys(value.quality, ["status", "checks"])) return undefined;
  const estimateRange = decodeCurrentRange(value.estimate.range);
  if (!estimateRange || !isLiteral(value.estimate.confidence, ["low", "medium", "high"] as const) || !stringArray(value.estimate.basis) ||
      !finiteNonnegative(value.estimate.overhead) || value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION ||
      !isLiteral(value.quality.status, ["passed", "warning", "not_evaluated"] as const) || !stringArray(value.quality.checks)) return undefined;
  const categories = value.categories.map((category): TaskReport["categories"][number] | undefined => {
    if (!hasExactKeys(category, ["category", "eventCount", "range", "confidence", "basis", "overhead"]) ||
        !isIdentifier(category.category) || !Number.isInteger(category.eventCount) || (category.eventCount as number) < 1 ||
        !isLiteral(category.confidence, ["low", "medium", "high"] as const) || !stringArray(category.basis) || !finiteNonnegative(category.overhead)) return undefined;
    const range = decodeCurrentRange(category.range);
    if (!range) return undefined;
    return {
      category: category.category,
      eventCount: category.eventCount as number,
      range,
      confidence: category.confidence as EstimateConfidence,
      basis: [...category.basis],
      overhead: category.overhead
    };
  });
  if (categories.some((entry) => entry === undefined)) return undefined;
  const exactCategories = categories as TaskReport["categories"];
  if (exactCategories.reduce((count, entry) => count + entry.eventCount, 0) !== expectedEventCount ||
      exactCategories.some((entry, index) => index > 0 && exactCategories[index - 1]!.category.localeCompare(entry.category) >= 0)) return undefined;
  return {
    taskId: value.taskId,
    eventCount: value.eventCount,
    estimate: {
      range: estimateRange,
      confidence: value.estimate.confidence as EstimateConfidence,
      basis: [...value.estimate.basis],
      overhead: value.estimate.overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    categories: exactCategories,
    quality: { status: value.quality.status as TaskReport["quality"]["status"], checks: [...value.quality.checks] }
  };
}

function decodeCurrentTaskLedger(value: unknown, expectedTaskId: string): TaskLedger | undefined {
  if (!hasExactKeys(value, REQUIRED_CURRENT_LEDGER_KEYS, [...CURRENT_LEDGER_KEYS].filter((key) => !REQUIRED_CURRENT_LEDGER_KEYS.includes(key as typeof REQUIRED_CURRENT_LEDGER_KEYS[number]))) ||
      value.schemaId !== TASK_LEDGER_SCHEMA_ID || value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || value.taskId !== expectedTaskId ||
      !isLiteral(value.host, ["codex", "claude", "unknown"] as const) || !isLiteral(value.status, ["open", "paused", "completed", "quarantined"] as const) ||
      !isOptionalIdentifier(value.sessionId) || !isOptionalIdentifier(value.turnId) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
      (value.pausedAt !== undefined && !isTimestamp(value.pausedAt)) || (value.completedAt !== undefined && !isTimestamp(value.completedAt)) ||
      value.estimatorVersion !== TASK_ESTIMATOR_VERSION || !Array.isArray(value.deliveredArtifacts) ||
      !value.deliveredArtifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) ||
      !Array.isArray(value.outcomes) || !Array.isArray(value.events) ||
      (value.lastDisposition !== undefined && value.lastDisposition !== "pause" && value.lastDisposition !== "complete") ||
      Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string) ||
      (value.pausedAt !== undefined && (Date.parse(value.pausedAt as string) < Date.parse(value.createdAt as string) || Date.parse(value.pausedAt as string) > Date.parse(value.updatedAt as string))) ||
      (value.completedAt !== undefined && (Date.parse(value.completedAt as string) < Date.parse(value.createdAt as string) || Date.parse(value.completedAt as string) > Date.parse(value.updatedAt as string)))) return undefined;
  const repositoryIdentity = value.repositoryIdentity === undefined ? undefined : decodeCurrentRepositoryIdentity(value.repositoryIdentity);
  const routingObservation = value.routingObservation === undefined ? undefined : decodeCurrentRoutingObservation(value.routingObservation);
  const readPolicy = value.readPolicy === undefined ? undefined : decodeCurrentReadPolicy(value.readPolicy);
  const events = value.events.map(decodeCurrentEvent);
  const outcomes = value.outcomes.map((outcome) => decodeCurrentOutcome(outcome, expectedTaskId));
  if ((value.repositoryIdentity !== undefined && !repositoryIdentity) || (value.routingObservation !== undefined && !routingObservation) ||
      (value.readPolicy !== undefined && !readPolicy) || events.some((entry) => entry === undefined) || outcomes.some((entry) => entry === undefined)) return undefined;
  const completedReport = value.completedReport === undefined ? undefined : decodeCurrentTaskReport(value.completedReport, expectedTaskId, events.length);
  if (value.completedReport !== undefined && !completedReport) return undefined;
  if (value.status === "open" && (value.pausedAt !== undefined || value.completedAt !== undefined || completedReport !== undefined || value.lastDisposition !== undefined)) return undefined;
  if (value.status === "paused" && (value.pausedAt === undefined || value.completedAt !== undefined || completedReport !== undefined || value.lastDisposition !== "pause")) return undefined;
  if (value.status === "completed" && (value.completedAt === undefined || completedReport === undefined || value.lastDisposition !== "complete")) return undefined;
  if (value.status === "quarantined" && (
    (value.lastDisposition === undefined && (value.pausedAt !== undefined || value.completedAt !== undefined || completedReport !== undefined)) ||
    (value.lastDisposition === "pause" && (value.pausedAt === undefined || value.completedAt !== undefined || completedReport !== undefined)) ||
    (value.lastDisposition === "complete" && (value.completedAt === undefined || completedReport === undefined)))) return undefined;
  return {
    schemaId: TASK_LEDGER_SCHEMA_ID,
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    taskId: expectedTaskId,
    host: value.host as TaskHost,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    status: value.status as TaskStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.pausedAt === undefined ? {} : { pausedAt: value.pausedAt }),
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    estimatorVersion: TASK_ESTIMATOR_VERSION,
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    ...(routingObservation === undefined ? {} : { routingObservation }),
    ...(readPolicy === undefined ? {} : { readPolicy }),
    deliveredArtifacts: [...value.deliveredArtifacts] as string[],
    outcomes: outcomes as TaskOutcome[],
    events: events as TaskEvent[],
    ...(value.lastDisposition === undefined ? {} : { lastDisposition: value.lastDisposition }),
    ...(completedReport === undefined ? {} : { completedReport })
  };
}

export async function inspectTaskLedgerReadOnly(
  root: string,
  taskId: string
): Promise<TaskLedgerReadOnlyInspection> {
  if (!UUID_PATTERN.test(taskId) || !isAbsolute(root)) return { status: "invalid" };
  const path = join(root, ".tokengraph", "tasks", `${taskId}.json`);
  let text: string;
  try {
    text = await readStableTaskLedger(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    if (error instanceof Error && error.message === "invalid-ledger-size") return { status: "invalid" };
    return { status: "unstable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: "invalid" };
  }
  if (isRecord(parsed) && parsed.schemaId === TASK_LEDGER_SCHEMA_ID && Number.isInteger(parsed.schemaVersion) &&
      parsed.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) {
    return { status: "unsupported" };
  }
  const ledger = decodeCurrentTaskLedger(parsed, taskId);
  if (!ledger) return { status: "invalid" };
  return { status: "valid", ledger: deepFreeze(ledger) };
}

function completedOutcomesIndexPath(root: string): string {
  return join(tasksDirectory(root), "completed-outcomes.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value);
}

function reconstructQualityCheck(value: unknown): TaskQualityCheck | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.passed !== "boolean") return undefined;
  return { name: value.name, passed: value.passed };
}

function reconstructEvent(value: unknown): TaskEvent | undefined {
  if (!isRecord(value) || !Array.isArray(value.qualityChecks)) return undefined;
  const qualityChecks = value.qualityChecks.map(reconstructQualityCheck);
  if (
    typeof value.id !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.category !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.originalTokens !== "number" ||
    !Number.isFinite(value.originalTokens) ||
    value.originalTokens < 0 ||
    typeof value.compactTokens !== "number" ||
    !Number.isFinite(value.compactTokens) ||
    value.compactTokens < 0 ||
    typeof value.overheadTokens !== "number" ||
    !Number.isFinite(value.overheadTokens) ||
    value.overheadTokens < 0 ||
    (value.confidence !== "low" && value.confidence !== "medium" && value.confidence !== "high") ||
    !isTimestamp(value.timestamp) ||
    qualityChecks.some((check) => check === undefined)
  ) {
    return undefined;
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
    qualityChecks: qualityChecks as TaskQualityCheck[]
  };
}

function reconstructOutcome(value: unknown): TaskOutcome | undefined {
  if (!isRecord(value) || !Array.isArray(value.evidence)) return undefined;
  if (
    !isIdentifier(value.id) ||
    !isIdentifier(value.taskId) ||
    typeof value.summary !== "string" || value.summary.trim().length === 0 ||
    !isLiteral(value.status, ["verified", "proposed", "failed"] as const) ||
    !value.evidence.every((entry) => isIdentifier(entry)) ||
    !isTimestamp(value.createdAt) ||
    (value.staleAt !== undefined && !isTimestamp(value.staleAt)) ||
    (value.sourceFingerprint !== undefined && !isIdentifier(value.sourceFingerprint)) ||
    !isIdentifier(value.branch) ||
    !isIdentifier(value.worktreeId) ||
    !isIdentifier(value.headCommit)
  ) return undefined;
  return {
    id: value.id,
    taskId: value.taskId,
    summary: value.summary,
    status: value.status as TaskOutcome["status"],
    evidence: [...value.evidence] as string[],
    createdAt: value.createdAt,
    ...(value.staleAt === undefined ? {} : { staleAt: value.staleAt }),
    ...(value.sourceFingerprint === undefined ? {} : { sourceFingerprint: value.sourceFingerprint }),
    branch: value.branch,
    worktreeId: value.worktreeId,
    headCommit: value.headCommit
  };
}

function reconstructTaskLedger(value: unknown, expectedTaskId: string): TaskLedger | undefined {
  if (!isRecord(value) || !Array.isArray(value.events)) return undefined;
  const legacy = value.schemaVersion === 1 || value.schemaVersion === 2;
  const events = value.events.map(reconstructEvent);
  const outcomes = value.outcomes === undefined && legacy
    ? []
    : Array.isArray(value.outcomes)
      ? value.outcomes.map(reconstructOutcome)
      : undefined;
  const routingObservation = value.routingObservation === undefined ? undefined : reconstructRoutingObservation(value.routingObservation);
  const readPolicy = value.readPolicy === undefined ? undefined : reconstructReadPolicy(value.readPolicy);
  const deliveredArtifacts = value.deliveredArtifacts === undefined
    ? []
    : Array.isArray(value.deliveredArtifacts) && value.deliveredArtifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512)
      ? [...new Set(value.deliveredArtifacts as string[])]
      : undefined;
  if (
    value.schemaId !== TASK_LEDGER_SCHEMA_ID ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) ||
    value.taskId !== expectedTaskId ||
    !isLiteral(value.host, ["codex", "claude", "unknown"] as const) ||
    !isLiteral(value.status, ["open", "paused", "completed", "quarantined"] as const) ||
    !isOptionalIdentifier(value.sessionId) ||
    !isOptionalIdentifier(value.turnId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.pausedAt !== undefined && !isTimestamp(value.pausedAt)) ||
    (value.completedAt !== undefined && !isTimestamp(value.completedAt)) ||
    (!legacy && value.estimatorVersion !== TASK_ESTIMATOR_VERSION) ||
    (legacy && value.estimatorVersion !== "task-estimator-v1" && value.estimatorVersion !== TASK_ESTIMATOR_VERSION) ||
    (value.repositoryIdentity !== undefined && !isRepositoryIdentity(value.repositoryIdentity)) ||
    (value.routingObservation !== undefined && routingObservation === undefined) ||
    (value.readPolicy !== undefined && readPolicy === undefined) ||
    deliveredArtifacts === undefined ||
    outcomes === undefined || outcomes.some((outcome) => outcome === undefined) ||
    events.some((event) => event === undefined) ||
    (value.lastDisposition !== undefined && value.lastDisposition !== "pause" && value.lastDisposition !== "complete") ||
    Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string) ||
    (value.pausedAt !== undefined && Date.parse(value.pausedAt as string) < Date.parse(value.createdAt as string)) ||
    (value.pausedAt !== undefined && Date.parse(value.pausedAt as string) > Date.parse(value.updatedAt as string)) ||
    (value.completedAt !== undefined && Date.parse(value.completedAt as string) < Date.parse(value.createdAt as string)) ||
    (value.completedAt !== undefined && Date.parse(value.completedAt as string) > Date.parse(value.updatedAt as string))
  ) {
    return undefined;
  }
  const completedReport = legacy && value.status === "completed"
    ? undefined
    : value.completedReport === undefined
      ? undefined
      : reconstructTaskReport(value.completedReport, expectedTaskId, events.length);
  if (!legacy && value.completedReport !== undefined && completedReport === undefined) return undefined;
  if (
    value.status === "open" &&
    (value.pausedAt !== undefined || value.completedAt !== undefined || completedReport !== undefined || value.lastDisposition !== undefined)
  ) {
    return undefined;
  }
  if (
    value.status === "paused" &&
    (value.pausedAt === undefined ||
      value.completedAt !== undefined ||
      completedReport !== undefined ||
      value.lastDisposition !== "pause")
  ) {
    return undefined;
  }
  if (
    value.status === "completed" &&
    (value.completedAt === undefined || (!legacy && completedReport === undefined) || value.completedReport === undefined || value.lastDisposition !== "complete")
  ) {
    return undefined;
  }
  const ledger: TaskLedger = {
    schemaId: TASK_LEDGER_SCHEMA_ID,
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    taskId: expectedTaskId,
    host: value.host as TaskHost,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    status: value.status as TaskStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.pausedAt === undefined ? {} : { pausedAt: value.pausedAt }),
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    estimatorVersion: TASK_ESTIMATOR_VERSION,
    ...(value.repositoryIdentity === undefined ? {} : { repositoryIdentity: value.repositoryIdentity }),
    ...(routingObservation === undefined ? {} : { routingObservation }),
    ...(readPolicy === undefined ? {} : { readPolicy }),
    deliveredArtifacts,
    outcomes: outcomes as TaskOutcome[],
    events: events as TaskEvent[],
    ...(value.lastDisposition === undefined ? {} : { lastDisposition: value.lastDisposition }),
    ...(completedReport === undefined ? {} : { completedReport })
  };
  if (legacy && ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
  return ledger;
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  if (!isRecord(value)) return false;
  return ["repositoryId", "repositoryFingerprint", "workspaceId", "worktreeId", "branch", "headCommit"]
    .every((key) => isIdentifier(value[key]));
}

function reconstructRoutingObservation(value: unknown): TaskRoutingObservation | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.decision !== "activate" && value.decision !== "bypass") ||
    !Number.isInteger(value.stage) || (value.stage as number) < 0 ||
    typeof value.reason !== "string" ||
    typeof value.expectedOverheadTokens !== "number" || !Number.isFinite(value.expectedOverheadTokens) || value.expectedOverheadTokens < 0 ||
    !isLiteral(value.mode, ["shadow", "enforced", "always-activate", "always-advisory"] as const) ||
    typeof value.enforced !== "boolean"
  ) return undefined;
  return {
    decision: value.decision,
    stage: value.stage as number,
    reason: value.reason,
    expectedOverheadTokens: value.expectedOverheadTokens,
    mode: value.mode as TaskRoutingObservation["mode"],
    enforced: value.enforced
  };
}

function reconstructReadPolicy(value: unknown): ReadPolicyState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isLiteral(value.level, ["L0", "L1", "L2", "L3", "L4"] as const) ||
    typeof value.allowRawReads !== "boolean" ||
    typeof value.reason !== "string" ||
    (value.targetedReads !== undefined && (!Number.isInteger(value.targetedReads) || (value.targetedReads as number) < 0)) ||
    (value.recommendedReadsThisResponse !== undefined && (!Number.isInteger(value.recommendedReadsThisResponse) || (value.recommendedReadsThisResponse as number) < 0)) ||
    (value.requiresReassessment !== undefined && typeof value.requiresReassessment !== "boolean") ||
    (value.hasReassessed !== undefined && typeof value.hasReassessed !== "boolean") ||
    (value.evidenceGap !== undefined && typeof value.evidenceGap !== "string")
  ) return undefined;
  return {
    level: value.level as ReadPolicyState["level"],
    allowRawReads: value.allowRawReads,
    reason: value.reason,
    ...(value.targetedReads === undefined ? {} : { targetedReads: value.targetedReads as number }),
    ...(value.recommendedReadsThisResponse === undefined ? {} : { recommendedReadsThisResponse: value.recommendedReadsThisResponse as number }),
    ...(value.requiresReassessment === undefined ? {} : { requiresReassessment: value.requiresReassessment }),
    ...(value.hasReassessed === undefined ? {} : { hasReassessed: value.hasReassessed }),
    ...(value.evidenceGap === undefined ? {} : { evidenceGap: value.evidenceGap })
  };
}

async function quarantine(path: string, now = new Date()): Promise<void> {
  const timestamp = now.toISOString().replaceAll(":", "-");
  try {
    await rename(path, `${path}.quarantine-${timestamp}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sanitizeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sanitizeEvent(event: TaskEvent): TaskEvent {
  return {
    id: String(event.id),
    fingerprint: String(event.fingerprint),
    category: String(event.category),
    toolName: String(event.toolName),
    originalTokens: sanitizeNumber(event.originalTokens),
    compactTokens: sanitizeNumber(event.compactTokens),
    overheadTokens: sanitizeNumber(event.overheadTokens),
    confidence: ["low", "medium", "high"].includes(event.confidence) ? event.confidence : "low",
    timestamp: String(event.timestamp),
    qualityChecks: Array.isArray(event.qualityChecks)
      ? event.qualityChecks.map((check) => ({ name: String(check.name), passed: check.passed === true }))
      : []
  };
}

function netEstimate(event: TaskEvent): number {
  return event.originalTokens - event.compactTokens - event.overheadTokens;
}

async function enqueueLedgerOperation<T>(root: string, taskId: string, operation: () => Promise<T>): Promise<T> {
  assertTaskId(taskId);
  const lock = await canonicalTaskLock(root, `${taskId}.json`);
  const key = process.platform === "win32" ? lock.anchorPath.toLowerCase() : lock.anchorPath;
  const previous = taskLedgerWriteChains.get(key) ?? Promise.resolve();
  const runWithFileLock = async (): Promise<T> => runWithTaskLock(lock, operation);
  const current = previous.then(runWithFileLock, runWithFileLock);
  let settled: Promise<void>;
  const cleanUp = (): void => {
    if (taskLedgerWriteChains.get(key) === settled) {
      taskLedgerWriteChains.delete(key);
    }
  };
  settled = current.then(cleanUp, cleanUp);
  taskLedgerWriteChains.set(key, settled);
  return current;
}

/** @internal Test-only diagnostic; not part of the public task-ledger contract. */
export function __getTaskLedgerWriteQueueSizeForTests(): number {
  return taskLedgerWriteChains.size;
}

export async function createTaskLedger(root: string, options: CreateTaskLedgerOptions): Promise<TaskLedger> {
  if (options.sessionId !== undefined && !isIdentifier(options.sessionId)) throw new Error("Session id must be non-empty.");
  if (options.turnId !== undefined && !isIdentifier(options.turnId)) throw new Error("Turn id must be non-empty.");
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const repositoryIdentity = await readRepositoryIdentity(root);
  const ledger: TaskLedger = {
    schemaId: TASK_LEDGER_SCHEMA_ID,
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    taskId,
    host: options.host,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    status: "open",
    createdAt: now,
    updatedAt: now,
    estimatorVersion: TASK_ESTIMATOR_VERSION,
    repositoryIdentity,
    deliveredArtifacts: [],
    outcomes: [],
    events: []
  };
  await enqueueLedgerOperation(root, taskId, async () => {
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
  });
  return ledger;
}

export async function attachTaskHostContext(
  root: string,
  taskId: string,
  context: TaskHostContext
): Promise<TaskLedger> {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId, true);
    assertPausedTaskIsTerminal(ledger);
    if (context.host !== "codex" && context.host !== "claude" && context.host !== "unknown") {
      throw new Error("Host context must identify codex, claude, or unknown.");
    }
    if (!isIdentifier(context.sessionId)) throw new Error("Session id must be non-empty.");
    if (!isIdentifier(context.turnId)) throw new Error("Turn id must be non-empty.");
    if (context.host !== "unknown" && ledger.host !== "unknown" && ledger.host !== context.host) {
      throw new Error(`Host context conflict: task is already associated with ${ledger.host}.`);
    }
    if (ledger.sessionId !== undefined && ledger.sessionId !== context.sessionId) {
      throw new Error("Session context conflict: task is already associated with another session id.");
    }

    if (context.host !== "unknown") ledger.host = context.host;
    ledger.sessionId = context.sessionId;
    ledger.turnId = context.turnId;
    ledger.updatedAt = new Date().toISOString();
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

// `repairInsideLock` is set only by callers that already own the tasks domain
// anchor (the per-ledger write queue, prune, and the completed-outcomes scan);
// migration and quarantine are mutations that use unlocked primitives while
// that lock is held. A pure read before activation (or outside the tasks lock)
// returns the same reconstructed value without touching the filesystem.
export async function loadTaskLedger(root: string, taskId: string, repairInsideLock = false): Promise<TaskLedger | undefined> {
  const path = taskLedgerPath(root, taskId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > TASK_LEDGER_SCHEMA_VERSION) {
      throw new Error(`Task ledger schema ${parsed.schemaVersion} is newer than supported schema ${TASK_LEDGER_SCHEMA_VERSION}; refusing to modify it.`);
    }
    const ledger = reconstructTaskLedger(parsed, taskId);
    if (!ledger) {
      if (repairInsideLock) await quarantine(path);
      return undefined;
    }
    if (!ledger.repositoryIdentity || (isRecord(parsed) && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2))) {
      ledger.repositoryIdentity ??= await readRepositoryIdentity(root);
      ledger.schemaVersion = TASK_LEDGER_SCHEMA_VERSION;
      ledger.estimatorVersion = TASK_ESTIMATOR_VERSION;
      ledger.outcomes ??= [];
      if (ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
      if (repairInsideLock) await writeTaskJson(path, ledger);
    }
    return ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      if (repairInsideLock) await quarantine(path);
      return undefined;
    }
    throw error;
  }
}

export async function updateTaskRoutingObservation(root: string, taskId: string, observation: TaskRoutingObservation): Promise<TaskLedger> {
  const sanitized = reconstructRoutingObservation(observation);
  if (!sanitized) throw new Error("Routing observation is invalid.");
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId, true);
    assertPausedTaskIsTerminal(ledger);
    ledger.routingObservation = sanitized;
    ledger.updatedAt = new Date().toISOString();
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function updateTaskReadPolicy(root: string, taskId: string, state: ReadPolicyState): Promise<TaskLedger> {
  const sanitized = reconstructReadPolicy(state);
  if (!sanitized) throw new Error("Read policy state is invalid.");
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId, true);
    assertPausedTaskIsTerminal(ledger);
    ledger.readPolicy = sanitized;
    ledger.updatedAt = new Date().toISOString();
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function recordTaskArtifactDelivery(root: string, taskId: string, artifactKeys: string[]): Promise<TaskLedger> {
  const sanitized = [...new Set(artifactKeys.map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.length <= 512))];
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId, true);
    assertPausedTaskIsTerminal(ledger);
    ledger.deliveredArtifacts = [...new Set([...ledger.deliveredArtifacts, ...sanitized])];
    ledger.updatedAt = new Date().toISOString();
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function discardEmptyTaskLedger(root: string, taskId: string): Promise<boolean> {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await loadTaskLedger(root, taskId, true);
    if (!ledger || ledger.status !== "open" || ledger.events.length !== 0) return false;
    await rm(taskLedgerPath(root, taskId), { force: true });
    return true;
  });
}

async function requireTaskLedger(root: string, taskId: string, repairInsideLock = false): Promise<TaskLedger> {
  const ledger = await loadTaskLedger(root, taskId, repairInsideLock);
  if (!ledger) throw new Error(`Task ledger ${taskId} was not found or was corrupt.`);
  return ledger;
}

function assertPausedTaskIsTerminal(ledger: TaskLedger): void {
  if (ledger.status === "paused") {
    throw new Error(`Paused task ${ledger.taskId} is terminal and cannot accept task-aware calls or events. Start a new task with tokengraph_prepare_context or omit taskId on a direct intent call.`);
  }
}

export async function recordTaskEvent(root: string, taskId: string, event: TaskEvent): Promise<TaskLedger> {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId, true);
    assertPausedTaskIsTerminal(ledger);
    if (ledger.status === "completed") {
      throw new Error("A completed task ledger cannot accept new events.");
    }

    const candidate = sanitizeEvent(event);
    const existingIndex = ledger.events.findIndex((stored) => stored.fingerprint === candidate.fingerprint);
    if (existingIndex < 0) {
      ledger.events.push(candidate);
    } else if (netEstimate(candidate) > netEstimate(ledger.events[existingIndex]!)) {
      ledger.events[existingIndex] = candidate;
    }
    ledger.updatedAt = new Date().toISOString();
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function requireOpenTaskForOutcome(root: string, taskId: string, repairInsideLock = false): Promise<TaskLedger> {
  const ledger = await requireTaskLedger(root, taskId, repairInsideLock);
  if (ledger.status !== "open") {
    throw new Error(`Task ${taskId} must be open to record an outcome; current status is ${ledger.status}.`);
  }
  if (!ledger.repositoryIdentity) throw new Error(`Task ${taskId} has no repository identity.`);
  const currentIdentity = await readRepositoryIdentity(root);
  if (currentIdentity.repositoryId !== ledger.repositoryIdentity.repositoryId) {
    throw new Error(`Task ${taskId} belongs to a different repository.`);
  }
  if (currentIdentity.worktreeId !== ledger.repositoryIdentity.worktreeId) {
    throw new Error(`Task ${taskId} belongs to a different worktree.`);
  }
  if (currentIdentity.branch !== ledger.repositoryIdentity.branch) {
    throw new Error(`Task ${taskId} belongs to a different branch.`);
  }
  return ledger;
}

export async function recordTaskOutcome(root: string, taskId: string, outcome: TaskOutcome): Promise<TaskLedger> {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireOpenTaskForOutcome(root, taskId);
    const candidate = reconstructOutcome(outcome);
    if (!candidate) throw new Error("Task outcome is malformed.");
    if (candidate.taskId !== taskId) throw new Error("Task outcome task id does not match the ledger task id.");
    if (candidate.branch !== ledger.repositoryIdentity!.branch) {
      throw new Error("Task outcome branch does not match the ledger branch.");
    }
    if (candidate.worktreeId !== ledger.repositoryIdentity!.worktreeId) {
      throw new Error("Task outcome worktree does not match the ledger worktree.");
    }
    if (!ledger.outcomes.some((stored) => stored.id === candidate.id)) {
      ledger.outcomes.push(candidate);
      ledger.outcomes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      ledger.updatedAt = new Date().toISOString();
      await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    }
    return ledger;
  });
}

function orderOutcomes(outcomes: TaskOutcome[]): TaskOutcome[] {
  return [...outcomes]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_COMPLETED_OUTCOMES);
}

// `repairInsideLock` is set only by callers holding the tasks anchor (through
// `withCompletedOutcomesIndexLock`); quarantining is a mutation and is skipped
// on the unlocked fast-path read used by `listCompletedTaskOutcomes`.
async function readCompletedOutcomesIndex(root: string, repairInsideLock: boolean): Promise<TaskOutcome[] | undefined> {
  const path = completedOutcomesIndexPath(root);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaId !== COMPLETED_OUTCOMES_INDEX_SCHEMA_ID ||
      parsed.schemaVersion !== COMPLETED_OUTCOMES_INDEX_SCHEMA_VERSION ||
      !Array.isArray(parsed.outcomes)
    ) {
      if (repairInsideLock) await quarantine(path);
      return undefined;
    }
    const outcomes = parsed.outcomes.map(reconstructOutcome);
    if (outcomes.some((outcome) => outcome === undefined)) {
      if (repairInsideLock) await quarantine(path);
      return undefined;
    }
    return orderOutcomes(outcomes as TaskOutcome[]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      if (repairInsideLock) await quarantine(path);
      return undefined;
    }
    throw error;
  }
}

async function writeCompletedOutcomesIndex(root: string, outcomes: TaskOutcome[]): Promise<void> {
  await writeTaskJson(completedOutcomesIndexPath(root), {
    schemaId: COMPLETED_OUTCOMES_INDEX_SCHEMA_ID,
    schemaVersion: COMPLETED_OUTCOMES_INDEX_SCHEMA_VERSION,
    outcomes: orderOutcomes(outcomes)
  });
}

async function scanCompletedTaskOutcomes(root: string): Promise<TaskOutcome[]> {
  let files: string[];
  try {
    files = await readdir(tasksDirectory(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const outcomes: TaskOutcome[] = [];
  for (const file of files.filter((name) => UUID_PATTERN.test(name.slice(0, -".json".length)) && name.endsWith(".json")).sort()) {
    // The completed-outcomes index scan runs while owning the tasks anchor, so
    // repairing a legacy or corrupt ledger uses unlocked primitives safely.
    const ledger = await loadTaskLedger(root, file.slice(0, -".json".length), true);
    if (ledger?.status === "completed") outcomes.push(...ledger.outcomes);
  }
  return orderOutcomes(outcomes);
}

async function withCompletedOutcomesIndexLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = await canonicalTaskLock(root, "completed-outcomes.json");
  return runWithTaskLock(lock, operation);
}

async function updateCompletedOutcomesIndex(root: string, added: TaskOutcome[]): Promise<void> {
  await withCompletedOutcomesIndexLock(root, async () => {
    const cached = await readCompletedOutcomesIndex(root, true);
    if (!cached) {
      await writeCompletedOutcomesIndex(root, await scanCompletedTaskOutcomes(root));
      return;
    }
    const merged = new Map(cached.map((outcome) => [`${outcome.taskId}:${outcome.id}`, outcome]));
    for (const outcome of added) merged.set(`${outcome.taskId}:${outcome.id}`, outcome);
    await writeCompletedOutcomesIndex(root, [...merged.values()]);
  });
}

export async function listCompletedTaskOutcomes(root: string): Promise<TaskOutcome[]> {
  const cached = await readCompletedOutcomesIndex(root, false);
  if (cached) return cached;
  return withCompletedOutcomesIndexLock(root, async () => {
    const existing = await readCompletedOutcomesIndex(root, true);
    if (existing) return existing;
    const outcomes = await scanCompletedTaskOutcomes(root);
    await writeCompletedOutcomesIndex(root, outcomes);
    return outcomes;
  });
}

export async function setTaskDisposition(
  root: string,
  taskId: string,
  disposition: TaskDisposition,
  turnId?: string,
  calibration?: TaskCalibration,
  reportOverheadTokens = 0
): Promise<SetTaskDispositionResult> {
  const pending = await enqueueLedgerOperation(root, taskId, async (): Promise<{
    result: SetTaskDispositionResult;
    completedOutcomes?: TaskOutcome[];
  }> => {
    const ledger = await requireTaskLedger(root, taskId, true);
    assertPausedTaskIsTerminal(ledger);
    if (ledger.status === "completed" && ledger.completedReport) {
      if (disposition === "pause") {
        throw new Error("A completed task ledger cannot accept a pause disposition.");
      }
      return { result: { ledger, report: ledger.completedReport } };
    }

    const now = new Date().toISOString();
    if (turnId !== undefined) ledger.turnId = turnId;
    ledger.lastDisposition = disposition;
    ledger.updatedAt = now;

    if (disposition === "pause") {
      ledger.status = "paused";
      ledger.pausedAt = now;
      await writeTaskJson(taskLedgerPath(root, taskId), ledger);
      return { result: { ledger } };
    }

    ledger.status = "completed";
    ledger.completedAt = now;
    ledger.completedReport = buildTaskReport(ledger, calibration, reportOverheadTokens);
    await writeTaskJson(taskLedgerPath(root, taskId), ledger);
    return {
      result: { ledger, report: ledger.completedReport },
      completedOutcomes: ledger.outcomes
    };
  });
  if (pending.completedOutcomes) {
    try {
      await updateCompletedOutcomesIndex(root, pending.completedOutcomes);
    } catch {
      // The outcomes index is derived state; the completed ledger is already durable.
    }
  }
  return pending.result;
}

export async function pruneTaskLedgers(root: string, now = new Date()): Promise<PruneTaskLedgersResult> {
  // Retention deletion mutates persistent state and must run while owning the
  // canonical tasks domain anchor. Every tasks lock shares the same domain-root
  // anchor, so a single acquisition serializes prune against per-ledger writers
  // and the completed-outcomes index; all primitives inside are unlocked (the
  // completed-outcomes rewrite must not re-acquire the same anchor).
  const maintenanceLock = await canonicalTaskLock(root, "maintenance");
  return runWithTaskLock(maintenanceLock, () => pruneTaskLedgersUnlocked(root, now));
}

async function pruneTaskLedgersUnlocked(root: string, now: Date): Promise<PruneTaskLedgersResult> {
  const directory = tasksDirectory(root);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pruned: [], quarantined: [] };
    throw error;
  }

  const cutoff = now.getTime() - TASK_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result: PruneTaskLedgersResult = { pruned: [], quarantined: [] };
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const taskId = file.slice(0, -".json".length);
    if (!UUID_PATTERN.test(taskId)) continue;
    const ledger = await loadTaskLedger(root, taskId, true);
    if (!ledger) {
      result.quarantined.push(taskId);
      continue;
    }
    if (ledger.status === "open") {
      if (ledger.events.length === 0 && Date.parse(ledger.updatedAt) < cutoff) {
        await rm(taskLedgerPath(root, taskId), { force: true });
        result.pruned.push(taskId);
      }
      continue;
    }
    if (ledger.status !== "paused" && ledger.status !== "completed") continue;
    const relevantTimestamp = ledger.status === "completed" ? ledger.completedAt : ledger.pausedAt;
    if (relevantTimestamp && Date.parse(relevantTimestamp) < cutoff) {
      await rm(taskLedgerPath(root, taskId), { force: true });
      result.pruned.push(taskId);
    }
  }
  if (result.pruned.length) {
    const cached = await readCompletedOutcomesIndex(root, true);
    if (cached) {
      const pruned = new Set(result.pruned);
      await writeCompletedOutcomesIndex(root, cached.filter((outcome) => !pruned.has(outcome.taskId)));
    }
  }
  return result;
}
