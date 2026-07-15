import { readFile } from "node:fs/promises";

import { canonicalPersistenceLockKey, quarantineCorruptJson, withFileLock, writeJsonAtomic } from "./storage.js";
import { repositoryDir } from "./persistence.js";
import type { RoutingControl, RoutingPromotionReport } from "./types.js";

const CURRENT_ROUTING_CONTROL_SCHEMA = 1;
const REQUIRED_PROMOTION_GATES = [
  "minimumSamples",
  "qualityNonInferiority",
  "tokenSuperiority",
  "resources",
  "routerRates",
  "executionMedian",
  "executionP25",
  "nonNegativeActivated"
] as const;

function routingControlPath(directory: string): string {
  return `${directory}/routing-control.json`;
}

function validPromotion(value: unknown): value is RoutingPromotionReport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoutingPromotionReport>;
  const gateRecord = candidate.gates && typeof candidate.gates === "object" ? candidate.gates as Record<string, unknown> : undefined;
  const gates = gateRecord ? Object.values(gateRecord) : [];
  const hasRequiredGates = Boolean(gateRecord) && REQUIRED_PROMOTION_GATES.every((name) => typeof gateRecord?.[name] === "boolean") && Object.keys(gateRecord ?? {}).length === REQUIRED_PROMOTION_GATES.length;
  const allGatesPass = hasRequiredGates && gates.every((gate) => gate === true);
  return candidate.schemaVersion === 1 && typeof candidate.generatedAt === "string" && typeof candidate.enforcementEnabled === "boolean" && hasRequiredGates && (!candidate.enforcementEnabled || allGatesPass);
}

function normalize(value: unknown): RoutingControl {
  const candidate = value && typeof value === "object" ? value as Partial<RoutingControl> : {};
  const envKillSwitch = process.env.TOKENGRAPH_ROUTING_KILL_SWITCH;
  return {
    schemaVersion: CURRENT_ROUTING_CONTROL_SCHEMA,
    killSwitch: envKillSwitch === "1" || envKillSwitch === "true" || candidate.killSwitch === true,
    ...(validPromotion(candidate.promotion) ? { promotion: candidate.promotion } : {})
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
