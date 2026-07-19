import { createHash } from "node:crypto";

import { filterUntrustedSourceText } from "./storagePolicy.js";
import { estimateTokens } from "./token.js";
import type { EvidenceStatement } from "./types.js";

export type MemoryScope = "user" | "repository" | "worktree" | "task";

export interface ScopedPreference {
  id: string;
  key: string;
  value: string;
  scope: MemoryScope;
  scopeId: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface TaskOutcome {
  id: string;
  taskId: string;
  summary: string;
  status: "verified" | "proposed" | "failed";
  evidence: string[];
  createdAt: string;
  staleAt?: string;
  sourceFingerprint?: string;
  branch: string;
  worktreeId: string;
  headCommit: string;
}

export type TaskOutcomeProvenance = "runner" | "hook" | "filesystem-diff" | "agent" | "inferred";

export function createTaskOutcome(
  input: Omit<TaskOutcome, "id" | "status"> & { id?: string; provenance: TaskOutcomeProvenance }
): TaskOutcome {
  const status: TaskOutcome["status"] = ["runner", "hook", "filesystem-diff"].includes(input.provenance)
    ? "verified"
    : "proposed";
  const summary = filterUntrustedSourceText(input.summary).trim();
  if (!summary) throw new Error("Task outcome summary is empty after safety filtering.");
  const content: Omit<TaskOutcome, "id"> = {
    taskId: input.taskId.trim(),
    summary,
    status,
    evidence: [...new Set(input.evidence.map((entry) => entry.trim()).filter(Boolean))].sort(),
    createdAt: input.createdAt,
    ...(input.staleAt ? { staleAt: input.staleAt } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
    branch: input.branch,
    worktreeId: input.worktreeId,
    headCommit: input.headCommit
  };
  const id = input.id?.trim() || createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
    .slice(0, 24);
  return { id, ...content };
}

export interface ProjectBrief {
  repositoryId: string;
  sourceFingerprint: string;
  generatedAt: string;
  sections: Array<{ id: string; estimatedTokens: number } & EvidenceStatement>;
  estimatedTokens: number;
}

export interface MemoryContextInput {
  repositoryId: string;
  worktreeId?: string;
  branch?: string;
  taskId?: string;
  sourceFingerprint?: string;
  preferences?: ScopedPreference[];
  outcomes?: TaskOutcome[];
  projectBrief?: ProjectBrief;
  indexedFacts?: string[];
  capsules?: string[];
  reviewedDecisions?: string[];
  maxTokens?: number;
}

function isExpired(value: { expiresAt?: string; staleAt?: string }, now: Date): boolean {
  return Boolean((value.expiresAt && new Date(value.expiresAt) <= now) || (value.staleAt && new Date(value.staleAt) <= now));
}

function idFor(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function filterScopedPreferences(preferences: ScopedPreference[], input: Pick<MemoryContextInput, "repositoryId" | "worktreeId" | "taskId">, now = new Date()): ScopedPreference[] {
  return preferences.filter((preference) => !isExpired(preference, now) && (
    preference.scope === "user" ||
    (preference.scope === "repository" && preference.scopeId === input.repositoryId) ||
    (preference.scope === "worktree" && preference.scopeId === input.worktreeId) ||
    (preference.scope === "task" && preference.scopeId === input.taskId)
  )).sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key) || b.updatedAt.localeCompare(a.updatedAt));
}

export function verifiedOutcomes(outcomes: TaskOutcome[], scope: Pick<MemoryContextInput, "sourceFingerprint" | "branch" | "worktreeId"> = {}, now = new Date()): TaskOutcome[] {
  return outcomes.filter((outcome) => outcome.status === "verified" && !isExpired(outcome, now) &&
      (!scope.sourceFingerprint || !outcome.sourceFingerprint || outcome.sourceFingerprint === scope.sourceFingerprint) &&
      (!scope.branch || outcome.branch === scope.branch) &&
      (!scope.worktreeId || outcome.worktreeId === scope.worktreeId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function buildAdaptiveProjectBrief(input: { repositoryId: string; sourceFingerprint: string; generatedAt?: string; sections: Array<{ id: string } & EvidenceStatement> }, maxTokens = 800): ProjectBrief {
  const selected: ProjectBrief["sections"] = [];
  let used = 0;
  for (const section of [...input.sections].sort((a, b) => a.id.localeCompare(b.id))) {
    const text = filterUntrustedSourceText(section.text).trim();
    const tokens = estimateTokens(text);
    if (!text || used + tokens > maxTokens) continue;
    selected.push({ id: section.id, text, evidenceClass: section.evidenceClass, confidence: section.confidence, source: section.source, estimatedTokens: tokens });
    used += tokens;
  }
  return { repositoryId: input.repositoryId, sourceFingerprint: input.sourceFingerprint, generatedAt: input.generatedAt ?? new Date().toISOString(), sections: selected, estimatedTokens: used };
}

export function composeMemoryContext(input: MemoryContextInput): { preferences: ScopedPreference[]; indexedFacts: string[]; capsules: string[]; reviewedDecisions: string[]; outcomes: TaskOutcome[]; projectBrief?: ProjectBrief; estimatedTokens: number; contextId: string } {
  const preferences = filterScopedPreferences(input.preferences ?? [], input);
  const outcomes = verifiedOutcomes(input.outcomes ?? [], input);
  const projectBrief = input.projectBrief && (!input.sourceFingerprint || input.projectBrief.sourceFingerprint === input.sourceFingerprint) ? input.projectBrief : undefined;
  const indexedFacts = Array.from(new Set((input.indexedFacts ?? []).filter((value) => value.trim()))).slice(0, 50);
  const capsules = Array.from(new Set((input.capsules ?? []).filter((value) => value.trim()))).slice(0, 20);
  const reviewedDecisions = Array.from(new Set((input.reviewedDecisions ?? []).filter((value) => value.trim()))).slice(0, 50);
  const maxTokens = input.maxTokens ?? 1200;
  const result = { preferences, indexedFacts, capsules, reviewedDecisions, outcomes, ...(projectBrief ? { projectBrief } : {}) };
  let contextId = idFor(result);
  while (estimateTokens(JSON.stringify(result)) > maxTokens && result.indexedFacts.length) { result.indexedFacts.pop(); contextId = idFor(result); }
  while (estimateTokens(JSON.stringify(result)) > maxTokens && result.reviewedDecisions.length) { result.reviewedDecisions.pop(); contextId = idFor(result); }
  while (estimateTokens(JSON.stringify(result)) > maxTokens && result.capsules.length) { result.capsules.pop(); contextId = idFor(result); }
  while (estimateTokens(JSON.stringify(result)) > maxTokens && result.outcomes.length) { result.outcomes.pop(); contextId = idFor(result); }
  while (estimateTokens(JSON.stringify(result)) > maxTokens && result.preferences.length) { result.preferences.pop(); contextId = idFor(result); }
  if (estimateTokens(JSON.stringify(result)) > maxTokens) delete result.projectBrief;
  return { ...result, estimatedTokens: estimateTokens(JSON.stringify(result)), contextId };
}
