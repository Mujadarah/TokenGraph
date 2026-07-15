import type { TaskLedger } from "./taskLedger.js";

export const TASK_ESTIMATOR_VERSION = "task-estimator-v1" as const;

export type EstimateConfidence = "low" | "medium" | "high";
export type QualityStatus = "passed" | "warning" | "not_evaluated";

export interface TaskCalibrationEntry {
  observations: number;
  lowResidual: number;
  highResidual: number;
}

export type TaskCalibration = Record<string, TaskCalibrationEntry>;

export interface TaskReport {
  taskId: string;
  eventCount: number;
  estimate: {
    range: {
      low: number;
      likely: number;
      high: number;
      unit: "estimated_tokens";
    };
    confidence: EstimateConfidence;
    basis: string[];
    overhead: number;
    estimatorVersion: typeof TASK_ESTIMATOR_VERSION;
  };
  quality: {
    status: QualityStatus;
    checks: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isConfidence(value: unknown): value is EstimateConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isQualityStatus(value: unknown): value is QualityStatus {
  return value === "passed" || value === "warning" || value === "not_evaluated";
}

export function reconstructTaskReport(
  value: unknown,
  expectedTaskId: string,
  expectedEventCount: number
): TaskReport | undefined {
  if (!isRecord(value) || !isRecord(value.estimate) || !isRecord(value.estimate.range) || !isRecord(value.quality)) {
    return undefined;
  }
  const range = value.estimate.range;
  const basis = value.estimate.basis;
  const checks = value.quality.checks;
  if (
    value.taskId !== expectedTaskId ||
    value.eventCount !== expectedEventCount ||
    !Number.isInteger(value.eventCount) ||
    !isFiniteNumber(range.low) ||
    !isFiniteNumber(range.likely) ||
    !isFiniteNumber(range.high) ||
    range.low > range.likely ||
    range.likely > range.high ||
    range.unit !== "estimated_tokens" ||
    !isConfidence(value.estimate.confidence) ||
    !Array.isArray(basis) ||
    !basis.every((item) => typeof item === "string") ||
    !isFiniteNumber(value.estimate.overhead) ||
    value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION ||
    !isQualityStatus(value.quality.status) ||
    !Array.isArray(checks) ||
    !checks.every((item) => typeof item === "string")
  ) {
    return undefined;
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

const confidenceRank: Record<EstimateConfidence, number> = { low: 0, medium: 1, high: 2 };

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function buildTaskReport(
  ledger: TaskLedger,
  calibration: TaskCalibration = {},
  reportOverheadTokens = 0
): TaskReport {
  let low = 0;
  let likely = 0;
  let high = 0;
  let overhead = 0;
  let confidence: EstimateConfidence = ledger.events.length > 0 ? "high" : "low";
  const basis = new Set<string>();
  const checks: string[] = [];
  let hasFailedCheck = false;

  for (const event of ledger.events) {
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
      if (confidenceRank[event.confidence] < confidenceRank[confidence]) {
        confidence = event.confidence;
      }
    } else {
      if (net < 0) low += net;
      high += Math.max(0, gross);
      confidence = "low";
      basis.add(`${event.category}:uncalibrated`);
    }

    for (const check of event.qualityChecks) {
      checks.push(`${check.name}:${check.passed ? "passed" : "failed"}`);
      if (!check.passed) {
        hasFailedCheck = true;
      }
    }
  }

  const reportOverhead = Math.max(0, finite(reportOverheadTokens));
  const hasNegativeEvent = ledger.events.some((event) => event.originalTokens - event.compactTokens - event.overheadTokens < 0);
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
    taskId: ledger.taskId,
    eventCount: ledger.events.length,
    estimate: {
      range: { low, likely, high, unit: "estimated_tokens" },
      confidence,
      basis: [...basis].sort(),
      overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    quality: {
      status: hasFailedCheck ? "warning" : checks.length > 0 ? "passed" : "not_evaluated",
      checks
    }
  };
}

export function formatTaskReportFooter(report: TaskReport): string {
  if (report.eventCount === 0) {
    return "TokenGraph: savings not measured (no qualifying task events).";
  }

  const { low, high } = report.estimate.range;
  const formatValue = (value: number): string => Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(1))}`;
  const savings = low === high
    ? formatValue(low)
    : low < 0 && high >= 0
      ? `${formatValue(low)} to ${formatValue(high)}`
      : `${formatValue(low)}-${formatValue(high)}`;
  const quality = report.quality.status === "not_evaluated" ? "not evaluated" : report.quality.status;
  return `TokenGraph: ~${savings} tokens saved (estimated, ${report.estimate.confidence} confidence); quality ${quality}.`;
}
