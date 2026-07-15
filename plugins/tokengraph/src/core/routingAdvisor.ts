import type { RoutingDecision } from "./artifact.js";

export type RoutingMode = "shadow" | "enforced" | "always-activate" | "always-advisory";
export type RoutingOverride = "auto" | "force-on" | "force-bypass";

export interface RoutingInput {
  task: string;
  knownArtifacts?: string[];
  routingOverride?: RoutingOverride;
  routingMode?: RoutingMode;
  indexAvailable?: boolean;
  cachedStatus?: "fresh" | "stale" | "missing";
}

function boundedTask(task: string): boolean {
  const normalized = task.trim();
  return normalized.length > 0 && normalized.length <= 180 &&
    /\b(what is|where is|show me|rename|format|explain)\b/i.test(normalized) &&
    !/\b(repository|architecture|migration|security|debug|regression|dependencies|all files)\b/i.test(normalized);
}

export function adviseRouting(input: RoutingInput): RoutingDecision {
  const mode = input.routingMode ?? "shadow";
  const forcedOn = input.routingOverride === "force-on";
  const forcedBypass = input.routingOverride === "force-bypass";
  const bypass = forcedBypass || (mode !== "always-activate" && !forcedOn && boundedTask(input.task));
  const useTokenGraph = mode === "always-activate" || forcedOn || !bypass;
  const stage: 0 | 1 = input.indexAvailable && (input.cachedStatus ?? "fresh") === "fresh" ? 1 : 0;
  const reason = forcedOn
    ? "routing override force-on"
    : forcedBypass
      ? "routing override force-bypass"
      : bypass
        ? "bounded-task"
        : stage === 1 ? "indexed-discovery" : "context-discovery";
  return {
    useTokenGraph,
    stage,
    reason,
    expectedOverheadTokens: useTokenGraph ? stage === 1 ? 25 : 80 : 0,
    expectedBenefit: useTokenGraph ? stage === 1 ? 160 : 120 : 0,
    enforced: mode === "enforced" || mode === "always-activate" || forcedOn || forcedBypass
  };
}
