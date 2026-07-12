import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  TASK_ESTIMATOR_VERSION,
  buildTaskReport,
  type EstimateConfidence,
  type TaskCalibration,
  type TaskReport
} from "./taskEstimator.js";
import { writeJsonAtomic } from "./storage.js";

export const TASK_LEDGER_SCHEMA_ID = "tokengraph-task-ledger" as const;
export const TASK_LEDGER_SCHEMA_VERSION = 1 as const;
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
  events: TaskEvent[];
  lastDisposition?: TaskDisposition;
  completedReport?: TaskReport;
}

export interface CreateTaskLedgerOptions {
  host: TaskHost;
  sessionId?: string;
  turnId?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTaskLedger(value: unknown, expectedTaskId: string): value is TaskLedger {
  if (!isRecord(value)) return false;
  return (
    value.schemaId === TASK_LEDGER_SCHEMA_ID &&
    value.schemaVersion === TASK_LEDGER_SCHEMA_VERSION &&
    value.taskId === expectedTaskId &&
    ["codex", "claude", "unknown"].includes(String(value.host)) &&
    ["open", "paused", "completed", "quarantined"].includes(String(value.status)) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    value.estimatorVersion === TASK_ESTIMATOR_VERSION &&
    Array.isArray(value.events)
  );
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
  return Math.max(0, event.originalTokens - event.compactTokens - event.overheadTokens);
}

export async function createTaskLedger(root: string, options: CreateTaskLedgerOptions): Promise<TaskLedger> {
  const taskId = randomUUID();
  const now = new Date().toISOString();
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
    events: []
  };
  await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
  return ledger;
}

export async function loadTaskLedger(root: string, taskId: string): Promise<TaskLedger | undefined> {
  const path = taskLedgerPath(root, taskId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isTaskLedger(parsed, taskId)) {
      await quarantine(path);
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      await quarantine(path);
      return undefined;
    }
    throw error;
  }
}

async function requireTaskLedger(root: string, taskId: string): Promise<TaskLedger> {
  const ledger = await loadTaskLedger(root, taskId);
  if (!ledger) throw new Error(`Task ledger ${taskId} was not found or was corrupt.`);
  return ledger;
}

export async function recordTaskEvent(root: string, taskId: string, event: TaskEvent): Promise<TaskLedger> {
  const ledger = await requireTaskLedger(root, taskId);
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
}

export async function setTaskDisposition(
  root: string,
  taskId: string,
  disposition: TaskDisposition,
  turnId?: string,
  calibration?: TaskCalibration
): Promise<SetTaskDispositionResult> {
  const ledger = await requireTaskLedger(root, taskId);
  if (ledger.status === "completed" && ledger.completedReport) {
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
  ledger.completedReport = buildTaskReport(ledger, calibration);
  await writeJsonAtomic(taskLedgerPath(root, taskId), ledger);
  return { ledger, report: ledger.completedReport };
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
    if (ledger.status === "open") continue;
    if (ledger.status !== "paused" && ledger.status !== "completed") continue;
    const relevantTimestamp = ledger.status === "completed" ? ledger.completedAt : ledger.pausedAt;
    if (relevantTimestamp && Date.parse(relevantTimestamp) < cutoff) {
      await rm(taskLedgerPath(root, taskId), { force: true });
      result.pruned.push(taskId);
    }
  }
  return result;
}
