import { readFile } from "node:fs/promises";

import { canonicalPersistenceLockKey, quarantineCorruptJson, withFileLock, writeJsonAtomic } from "./storage.js";
import { repositoryDir } from "./persistence.js";
import type { RoutingControl, RoutingPromotionReport } from "./types.js";

const CURRENT_ROUTING_CONTROL_SCHEMA = 1;
const REQUIRED_PROMOTION_GATES = [
  "minimumSamples",
  "realHostEvidence",
  "qualityNonInferiority",
  "tokenSuperiority",
  "resources",
  "routerRates",
  "routerLatency",
  "executionMedian",
  "executionP25",
  "nonNegativeActivated"
] as const;

function routingControlPath(directory: string): string {
  return `${directory}/routing-control.json`;
}

export function isValidatedPromotion(value: unknown): value is RoutingPromotionReport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoutingPromotionReport>;
  const gateRecord = candidate.gates && typeof candidate.gates === "object" ? candidate.gates as Record<string, unknown> : undefined;
  const gates = gateRecord ? Object.values(gateRecord) : [];
  const hasRequiredGates = Boolean(gateRecord) && REQUIRED_PROMOTION_GATES.every((name) => typeof gateRecord?.[name] === "boolean") && Object.keys(gateRecord ?? {}).length === REQUIRED_PROMOTION_GATES.length;
  const allGatesPass = hasRequiredGates && gates.every((gate) => gate === true);
  const categoryCounts = candidate.categoryCounts && typeof candidate.categoryCounts === "object"
    ? Object.values(candidate.categoryCounts)
    : [];
  const evidencePasses = categoryCounts.length > 0 && categoryCounts.every((count) => Number.isInteger(count) && count >= 10) &&
    candidate.evidenceSource === "real-host" && candidate.reviewed === true &&
    Number.isInteger(candidate.beneficialCount) && candidate.beneficialCount! > 0 &&
    Number.isInteger(candidate.boundedCount) && candidate.boundedCount! > 0 &&
    typeof candidate.falseBypassRate === "number" && Number.isFinite(candidate.falseBypassRate) && candidate.falseBypassRate >= 0 && candidate.falseBypassRate < 0.1 &&
    typeof candidate.falseActivationRate === "number" && Number.isFinite(candidate.falseActivationRate) && candidate.falseActivationRate >= 0 && candidate.falseActivationRate < 0.1 &&
    typeof candidate.stage0LatencyMs === "number" && Number.isFinite(candidate.stage0LatencyMs) && candidate.stage0LatencyMs >= 0 &&
    typeof candidate.activationLatencyMs === "number" && Number.isFinite(candidate.activationLatencyMs) && candidate.activationLatencyMs > candidate.stage0LatencyMs &&
    Number.isInteger(candidate.stage0LatencySamples) && candidate.stage0LatencySamples! > 0 &&
    Number.isInteger(candidate.activationLatencySamples) && candidate.activationLatencySamples! > 0 &&
    candidate.stage0FasterThanActivation === true &&
    typeof candidate.executionInclusiveMedian === "number" && Number.isFinite(candidate.executionInclusiveMedian) && candidate.executionInclusiveMedian > 0 &&
    typeof candidate.executionInclusiveP25 === "number" && Number.isFinite(candidate.executionInclusiveP25) && candidate.executionInclusiveP25 >= 0 &&
    typeof candidate.nonNegativeActivatedRate === "number" && Number.isFinite(candidate.nonNegativeActivatedRate) && candidate.nonNegativeActivatedRate >= 0.8 && candidate.nonNegativeActivatedRate <= 1;
  return candidate.schemaVersion === 2 && typeof candidate.generatedAt === "string" && typeof candidate.enforcementEnabled === "boolean" && hasRequiredGates && evidencePasses && (!candidate.enforcementEnabled || allGatesPass);
}

function normalize(value: unknown): RoutingControl {
  const candidate = value && typeof value === "object" ? value as Partial<RoutingControl> : {};
  const envKillSwitch = process.env.TOKENGRAPH_ROUTING_KILL_SWITCH;
  return {
    schemaVersion: CURRENT_ROUTING_CONTROL_SCHEMA,
    killSwitch: envKillSwitch === "1" || envKillSwitch === "true" || candidate.killSwitch === true,
    ...(isValidatedPromotion(candidate.promotion) ? { promotion: candidate.promotion } : {})
  };
}

export async function loadRoutingControl(root: string): Promise<RoutingControl> {
  const directory = await repositoryDir(root);
  const path = routingControlPath(directory);
  try {
    return normalize(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalize(undefined);
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(path);
      return normalize(undefined);
    }
    throw error;
  }
}

export async function saveRoutingControl(root: string, control: RoutingControl): Promise<RoutingControl> {
  const directory = await repositoryDir(root);
  const path = routingControlPath(directory);
  const normalized = normalize(control);
  const key = await canonicalPersistenceLockKey(directory, "routing-control.json");
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(path, normalized));
  return normalized;
}
