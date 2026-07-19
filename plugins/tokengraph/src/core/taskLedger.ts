import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  TASK_ESTIMATOR_VERSION,
  buildTaskReport,
  reconstructTaskReport,
  type EstimateConfidence,
  type TaskCalibration,
  type TaskReport
} from "./taskEstimator.js";
import { canonicalPersistenceLockKey, withFileLock, writeJsonAtomic } from "./storage.js";
import { getRepositoryIdentity } from "./repositoryIdentity.js";
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
    !["verified", "proposed", "failed"].includes(String(value.status)) ||
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
    !["codex", "claude", "unknown"].includes(String(value.host)) ||
    !["open", "paused", "completed", "quarantined"].includes(String(value.status)) ||
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
    !["shadow", "enforced", "always-activate", "always-advisory"].includes(String(value.mode)) ||
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
    !["L0", "L1", "L2", "L3", "L4"].includes(String(value.level)) ||
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
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "tasks", `${taskId}.json`);
  const previous = taskLedgerWriteChains.get(key) ?? Promise.resolve();
  const runWithFileLock = async (): Promise<T> => withFileLock(`${taskLedgerPath(root, taskId)}.lock`, operation);
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
  const repositoryIdentity = await getRepositoryIdentity(root);
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
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
  });
  return ledger;
}

export async function attachTaskHostContext(
  root: string,
  taskId: string,
  context: TaskHostContext
): Promise<TaskLedger> {
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
    if (ledger.sessionId !== undefined && ledger.sessionId !== context.sessionId) {
      throw new Error("Session context conflict: task is already associated with another session id.");
    }

    if (context.host !== "unknown") ledger.host = context.host;
    ledger.sessionId = context.sessionId;
    ledger.turnId = context.turnId;
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function loadTaskLedger(root: string, taskId: string): Promise<TaskLedger | undefined> {
  const path = taskLedgerPath(root, taskId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > TASK_LEDGER_SCHEMA_VERSION) {
      throw new Error(`Task ledger schema ${parsed.schemaVersion} is newer than supported schema ${TASK_LEDGER_SCHEMA_VERSION}; refusing to modify it.`);
    }
    const ledger = reconstructTaskLedger(parsed, taskId);
    if (!ledger) {
      await quarantine(path);
      return undefined;
    }
    if (!ledger.repositoryIdentity || (isRecord(parsed) && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2))) {
      ledger.repositoryIdentity ??= await getRepositoryIdentity(root);
      ledger.schemaVersion = TASK_LEDGER_SCHEMA_VERSION;
      ledger.estimatorVersion = TASK_ESTIMATOR_VERSION;
      ledger.outcomes ??= [];
      if (ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
      await writeJsonAtomic(path, ledger);
    }
    return ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      await quarantine(path);
      return undefined;
    }
    throw error;
  }
}

export async function updateTaskRoutingObservation(root: string, taskId: string, observation: TaskRoutingObservation): Promise<TaskLedger> {
  const sanitized = reconstructRoutingObservation(observation);
  if (!sanitized) throw new Error("Routing observation is invalid.");
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId);
    assertPausedTaskIsTerminal(ledger);
    ledger.routingObservation = sanitized;
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function updateTaskReadPolicy(root: string, taskId: string, state: ReadPolicyState): Promise<TaskLedger> {
  const sanitized = reconstructReadPolicy(state);
  if (!sanitized) throw new Error("Read policy state is invalid.");
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId);
    assertPausedTaskIsTerminal(ledger);
    ledger.readPolicy = sanitized;
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function recordTaskArtifactDelivery(root: string, taskId: string, artifactKeys: string[]): Promise<TaskLedger> {
  const sanitized = [...new Set(artifactKeys.map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.length <= 512))];
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId);
    assertPausedTaskIsTerminal(ledger);
    ledger.deliveredArtifacts = [...new Set([...ledger.deliveredArtifacts, ...sanitized])];
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function discardEmptyTaskLedger(root: string, taskId: string): Promise<boolean> {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await loadTaskLedger(root, taskId);
    if (!ledger || ledger.status !== "open" || ledger.events.length !== 0) return false;
    await rm(taskLedgerPath(root, taskId), { force: true });
    return true;
  });
}

async function requireTaskLedger(root: string, taskId: string): Promise<TaskLedger> {
  const ledger = await loadTaskLedger(root, taskId);
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
    const ledger = await requireTaskLedger(root, taskId);
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
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    return ledger;
  });
}

export async function requireOpenTaskForOutcome(root: string, taskId: string): Promise<TaskLedger> {
  const ledger = await requireTaskLedger(root, taskId);
  if (ledger.status !== "open") {
    throw new Error(`Task ${taskId} must be open to record an outcome; current status is ${ledger.status}.`);
  }
  if (!ledger.repositoryIdentity) throw new Error(`Task ${taskId} has no repository identity.`);
  const currentIdentity = await getRepositoryIdentity(root);
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
      await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    }
    return ledger;
  });
}

function orderOutcomes(outcomes: TaskOutcome[]): TaskOutcome[] {
  return [...outcomes]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_COMPLETED_OUTCOMES);
}

async function readCompletedOutcomesIndex(root: string): Promise<TaskOutcome[] | undefined> {
  const path = completedOutcomesIndexPath(root);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaId !== COMPLETED_OUTCOMES_INDEX_SCHEMA_ID ||
      parsed.schemaVersion !== COMPLETED_OUTCOMES_INDEX_SCHEMA_VERSION ||
      !Array.isArray(parsed.outcomes)
    ) {
      await quarantine(path);
      return undefined;
    }
    const outcomes = parsed.outcomes.map(reconstructOutcome);
    if (outcomes.some((outcome) => outcome === undefined)) {
      await quarantine(path);
      return undefined;
    }
    return orderOutcomes(outcomes as TaskOutcome[]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      await quarantine(path);
      return undefined;
    }
    throw error;
  }
}

async function writeCompletedOutcomesIndex(root: string, outcomes: TaskOutcome[]): Promise<void> {
  await writeJsonAtomic(completedOutcomesIndexPath(root), {
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
    const ledger = await loadTaskLedger(root, file.slice(0, -".json".length));
    if (ledger?.status === "completed") outcomes.push(...ledger.outcomes);
  }
  return orderOutcomes(outcomes);
}

async function withCompletedOutcomesIndexLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "tasks", "completed-outcomes.json");
  return withFileLock(`${key}.lock`, operation);
}

async function updateCompletedOutcomesIndex(root: string, added: TaskOutcome[]): Promise<void> {
  await withCompletedOutcomesIndexLock(root, async () => {
    const cached = await readCompletedOutcomesIndex(root);
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
  const cached = await readCompletedOutcomesIndex(root);
  if (cached) return cached;
  return withCompletedOutcomesIndexLock(root, async () => {
    const existing = await readCompletedOutcomesIndex(root);
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
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireTaskLedger(root, taskId);
    assertPausedTaskIsTerminal(ledger);
    if (ledger.status === "completed" && ledger.completedReport) {
      if (disposition === "pause") {
        throw new Error("A completed task ledger cannot accept a pause disposition.");
      }
      return { ledger, report: ledger.completedReport };
    }

    const now = new Date().toISOString();
    if (turnId !== undefined) ledger.turnId = turnId;
    ledger.lastDisposition = disposition;
    ledger.updatedAt = now;

    if (disposition === "pause") {
      ledger.status = "paused";
      ledger.pausedAt = now;
      await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
      return { ledger };
    }

    ledger.status = "completed";
    ledger.completedAt = now;
    ledger.completedReport = buildTaskReport(ledger, calibration, reportOverheadTokens);
    await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
    try {
      await updateCompletedOutcomesIndex(root, ledger.outcomes);
    } catch {
      // The outcomes index is derived state; the completed ledger is already durable.
    }
    return { ledger, report: ledger.completedReport };
  });
}

export async function pruneTaskLedgers(root: string, now = new Date()): Promise<PruneTaskLedgersResult> {
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
    const ledger = await loadTaskLedger(root, taskId);
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
    await withCompletedOutcomesIndexLock(root, async () => {
      const cached = await readCompletedOutcomesIndex(root);
      if (cached) {
        const pruned = new Set(result.pruned);
        await writeCompletedOutcomesIndex(root, cached.filter((outcome) => !pruned.has(outcome.taskId)));
      }
    });
  }
  return result;
}
