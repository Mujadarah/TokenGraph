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

const confidenceRank: Record<EstimateConfidence, number> = { low: 0, medium: 1, high: 2 };

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function buildTaskReport(ledger: TaskLedger, calibration: TaskCalibration = {}): TaskReport {
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
    const net = Math.max(0, original - compact - eventOverhead);
    const gross = Math.max(0, original - compact);
    const categoryCalibration = calibration[event.category];
    const isCalibrated = Boolean(categoryCalibration && categoryCalibration.observations >= 10);

    likely += net;
    overhead += eventOverhead;
    if (isCalibrated && categoryCalibration) {
      low += Math.max(0, net + finite(categoryCalibration.lowResidual));
      high += Math.max(net, gross, net + finite(categoryCalibration.highResidual));
      basis.add(`${event.category}:calibrated:${categoryCalibration.observations}`);
      if (confidenceRank[event.confidence] < confidenceRank[confidence]) {
        confidence = event.confidence;
      }
    } else {
      high += gross;
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

  low = Math.min(Math.max(0, low), likely);
  high = Math.max(likely, high);

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
