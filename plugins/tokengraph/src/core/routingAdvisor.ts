import type { ExpectedBenefit, RoutingDecision } from "./artifact.js";

export type RoutingMode = "shadow" | "enforced" | "always-activate" | "always-advisory";
export type RoutingOverride = "auto" | "force-on" | "force-bypass";

export interface RoutingInput {
  task: string;
  knownArtifacts?: string[];
  routingOverride?: RoutingOverride;
  routingMode?: RoutingMode;
  indexAvailable?: boolean;
  cachedStatus?: "fresh" | "stale" | "missing";
  killSwitch?: boolean;
  promotion?: { enforcementEnabled: boolean };
}

export function failOpenRouting(reason = "routing-unavailable"): RoutingDecision {
  return { useTokenGraph: false, stage: 0, reason, expectedOverheadTokens: 0, expectedBenefit: "none", enforced: false };
}

const broadTaskPattern = /\b(repository|architecture|migration|security|debug|regression|dependencies|all files|risk)\b/i;
const localActionPattern = /\b(fix|change|update|rename|format|show|find|locate|where is)\b/i;
const relativeSourceLocationPattern = /(?:^|\s|["'`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.\[\]-]+\.(?:cjs|js|jsx|json|md|mjs|sql|ts|tsx|yaml|yml))(?::\d+(?::\d+)?)?/gi;

function boundedExactLocationTask(task: string): boolean {
  if (!localActionPattern.test(task) || broadTaskPattern.test(task)) return false;
  const locations = [...task.matchAll(relativeSourceLocationPattern)].map((match) => match[1]);
  return locations.length === 1;
}

function boundedTask(task: string): boolean {
  const normalized = task.trim();
  const singleUsageUpdate = /^update\s+[A-Za-z_$][\w$]*\s+usage\s+in\s+[A-Za-z_$][\w$]*[.!?]?$/i.test(normalized);
  return normalized.length > 0 && normalized.length <= 180 &&
    (/\b(what is|where is|show me|rename|format|explain)\b/i.test(normalized) || /^(find|locate)\b/i.test(normalized) || singleUsageUpdate || boundedExactLocationTask(normalized)) &&
    !broadTaskPattern.test(normalized);
}

export function adviseRouting(input: RoutingInput): RoutingDecision {
  const mode = input.routingMode ?? "shadow";
  const forcedOn = input.routingOverride === "force-on";
  const forcedBypass = input.routingOverride === "force-bypass";
  const killSwitch = input.killSwitch === true;
  if (killSwitch) return failOpenRouting("routing kill switch");
  const bypass = killSwitch || forcedBypass || (mode !== "always-activate" && !forcedOn && boundedTask(input.task));
  const useTokenGraph = !bypass && (mode === "always-activate" || forcedOn || !boundedTask(input.task));
  const stage: 0 | 1 = bypass ? 0 : input.indexAvailable ? 1 : 0;
  const reason = forcedOn
    ? "routing override force-on"
    : forcedBypass
      ? "routing override force-bypass"
      : bypass
        ? "bounded-task"
        : stage === 1 ? "indexed-discovery" : "context-discovery";
  const expectedBenefit: ExpectedBenefit = !useTokenGraph ? "none" : stage === 1 ? "high" : "medium";
  return {
    useTokenGraph,
    stage,
    reason,
    expectedOverheadTokens: useTokenGraph ? stage === 1 ? 25 : 80 : 0,
    expectedBenefit,
    enforced: !forcedBypass && Boolean(input.promotion?.enforcementEnabled) && (mode === "enforced" || mode === "always-activate" || forcedOn)
  };
}
