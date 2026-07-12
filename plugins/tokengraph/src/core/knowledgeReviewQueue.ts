import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalPersistenceLockKey, quarantineCorruptJson, writeJsonAtomic } from "./storage.js";

export type KnowledgeSuggestionType = "wiki" | "memory" | "skill";
export type KnowledgeSuggestionStatus = "proposed" | "approved" | "rejected" | "expired";
export type KnowledgeReviewDecision = "approve" | "reject";

export interface KnowledgeProposalInput {
  type: KnowledgeSuggestionType;
  title: string;
  rationale: string;
  proposedContent: string;
  sourceFingerprints: string[];
  affectedIdentifiers: string[];
}

export interface KnowledgeSuggestion extends KnowledgeProposalInput {
  id: string;
  fingerprint: string;
  status: KnowledgeSuggestionStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewReason?: string;
}

export interface KnowledgeSuggestionListOptions {
  type?: KnowledgeSuggestionType | KnowledgeSuggestionType[];
  status?: KnowledgeSuggestionStatus | KnowledgeSuggestionStatus[];
}

export interface KnowledgeReviewResult {
  suggestion: KnowledgeSuggestion;
  applicationStatus: "pending";
}

const REVIEW_QUEUE_SCHEMA_VERSION = 1;
const SUGGESTION_TYPES = new Set<KnowledgeSuggestionType>(["wiki", "memory", "skill"]);
const SUGGESTION_STATUSES = new Set<KnowledgeSuggestionStatus>(["proposed", "approved", "rejected", "expired"]);
const REVIEW_DECISIONS = new Set<KnowledgeReviewDecision>(["approve", "reject"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const MEMORY_ID_PATTERN = /^mem_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const BASE_KEYS = [
  "affectedIdentifiers",
  "createdAt",
  "fingerprint",
  "id",
  "proposedContent",
  "rationale",
  "sourceFingerprints",
  "status",
  "title",
  "type",
  "updatedAt"
] as const;
const OPTIONAL_KEYS = ["reviewedAt", "reviewReason"] as const;
const queueWriteChains = new Map<string, Promise<void>>();

function queuePath(root: string): string {
  return join(resolve(root), ".tokengraph", "review-queue.json");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function normalizeUnique(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must contain at least one value.`);
  const normalized = values.map((value) => nonEmptyString(value, label));
  return Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
}

function validateAffectedIdentifiers(type: KnowledgeSuggestionType, values: unknown): string[] {
  const identifiers = normalizeUnique(values, "Affected identifiers");
  const pattern = type === "wiki" ? WIKI_SLUG_PATTERN : type === "memory" ? MEMORY_ID_PATTERN : SKILL_NAME_PATTERN;
  if (identifiers.some((identifier) => !pattern.test(identifier))) {
    throw new Error(`Affected identifiers must be safe logical ${type} identifiers, not absolute or traversing paths.`);
  }
  return identifiers;
}

function validateType(value: unknown): KnowledgeSuggestionType {
  if (!SUGGESTION_TYPES.has(value as KnowledgeSuggestionType)) throw new Error("Unknown knowledge suggestion type.");
  return value as KnowledgeSuggestionType;
}

function validateStatus(value: unknown): KnowledgeSuggestionStatus {
  if (!SUGGESTION_STATUSES.has(value as KnowledgeSuggestionStatus)) throw new Error("Unknown knowledge suggestion status.");
  return value as KnowledgeSuggestionStatus;
}

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return value;
}

function suggestionFingerprint(input: KnowledgeProposalInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        type: input.type,
        title: input.title,
        proposedContent: input.proposedContent,
        sourceFingerprints: input.sourceFingerprints,
        affectedIdentifiers: input.affectedIdentifiers
      })
    )
    .digest("hex");
}

function sanitizeProposal(input: KnowledgeProposalInput): KnowledgeProposalInput {
  const type = validateType(input.type);
  return {
    type,
    title: nonEmptyString(input.title, "Title"),
    rationale: nonEmptyString(input.rationale, "Rationale"),
    proposedContent: nonEmptyString(input.proposedContent, "Proposed content"),
    sourceFingerprints: normalizeUnique(input.sourceFingerprints, "Source fingerprints"),
    affectedIdentifiers: validateAffectedIdentifiers(type, input.affectedIdentifiers)
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function reconstructSuggestion(value: unknown): KnowledgeSuggestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Suggestion must be an object.");
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    ...BASE_KEYS,
    ...(candidate.reviewedAt === undefined ? [] : [OPTIONAL_KEYS[0]]),
    ...(candidate.reviewReason === undefined ? [] : [OPTIONAL_KEYS[1]])
  ];
  if (!hasExactKeys(candidate, expectedKeys)) throw new Error("Suggestion contains unknown or missing persisted fields.");

  if (typeof candidate.id !== "string" || !UUID_PATTERN.test(candidate.id)) throw new Error("Suggestion id must be a UUID.");
  const type = validateType(candidate.type);
  const status = validateStatus(candidate.status);
  const proposal = sanitizeProposal({
    type,
    title: candidate.title as string,
    rationale: candidate.rationale as string,
    proposedContent: candidate.proposedContent as string,
    sourceFingerprints: candidate.sourceFingerprints as string[],
    affectedIdentifiers: candidate.affectedIdentifiers as string[]
  });
  if (typeof candidate.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(candidate.fingerprint)) {
    throw new Error("Suggestion fingerprint is invalid.");
  }
  if (candidate.fingerprint !== suggestionFingerprint(proposal)) throw new Error("Suggestion fingerprint does not match its content.");
  const createdAt = validateTimestamp(candidate.createdAt, "Created timestamp");
  const updatedAt = validateTimestamp(candidate.updatedAt, "Updated timestamp");
  const reviewedAt = candidate.reviewedAt === undefined ? undefined : validateTimestamp(candidate.reviewedAt, "Reviewed timestamp");
  const reviewReason = candidate.reviewReason === undefined ? undefined : nonEmptyString(candidate.reviewReason, "Review reason");

  return {
    id: candidate.id,
    fingerprint: candidate.fingerprint,
    ...proposal,
    status,
    createdAt,
    updatedAt,
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    ...(reviewReason === undefined ? {} : { reviewReason })
  };
}

async function readQueue(root: string): Promise<KnowledgeSuggestion[]> {
  const path = queuePath(root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Queue must be an object.");
    const queue = parsed as Record<string, unknown>;
    if (!hasExactKeys(queue, ["schemaVersion", "suggestions"]) || queue.schemaVersion !== REVIEW_QUEUE_SCHEMA_VERSION || !Array.isArray(queue.suggestions)) {
      throw new Error("Queue schema is invalid.");
    }
    return queue.suggestions.map(reconstructSuggestion);
  } catch {
    await quarantineCorruptJson(path);
    return [];
  }
}

async function writeQueue(root: string, suggestions: KnowledgeSuggestion[]): Promise<void> {
  await writeJsonAtomic(queuePath(root), { schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION, suggestions });
}

async function enqueueQueueOperation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "review-queue.json");
  const previous = queueWriteChains.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  let settled: Promise<void>;
  const cleanUp = (): void => {
    if (queueWriteChains.get(key) === settled) queueWriteChains.delete(key);
  };
  settled = current.then(cleanUp, cleanUp);
  queueWriteChains.set(key, settled);
  return current;
}

export async function proposeKnowledgeChange(root: string, input: KnowledgeProposalInput): Promise<KnowledgeSuggestion> {
  const proposal = sanitizeProposal(input);
  const fingerprint = suggestionFingerprint(proposal);
  return enqueueQueueOperation(root, async () => {
    const suggestions = await readQueue(root);
    const duplicate = suggestions.find((suggestion) => suggestion.status === "proposed" && suggestion.fingerprint === fingerprint);
    if (duplicate) return duplicate;
    const timestamp = new Date().toISOString();
    const suggestion: KnowledgeSuggestion = {
      id: randomUUID(),
      fingerprint,
      ...proposal,
      status: "proposed",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    suggestions.push(suggestion);
    await writeQueue(root, suggestions);
    return suggestion;
  });
}

export async function listKnowledgeSuggestions(
  root: string,
  options: KnowledgeSuggestionListOptions = {}
): Promise<KnowledgeSuggestion[]> {
  const suggestions = await readQueue(root);
  const types = options.type === undefined ? undefined : Array.isArray(options.type) ? options.type : [options.type];
  const statuses = options.status === undefined ? undefined : Array.isArray(options.status) ? options.status : [options.status];
  types?.forEach(validateType);
  statuses?.forEach(validateStatus);
  return suggestions.filter(
    (suggestion) => (!types || types.includes(suggestion.type)) && (!statuses || statuses.includes(suggestion.status))
  );
}

export async function reviewKnowledgeSuggestion(
  root: string,
  id: string,
  decision: KnowledgeReviewDecision,
  reason?: string
): Promise<KnowledgeReviewResult> {
  if (!UUID_PATTERN.test(id)) throw new Error("Knowledge suggestion id must be a UUID.");
  if (!REVIEW_DECISIONS.has(decision)) throw new Error("Unknown review decision.");
  const nextStatus: KnowledgeSuggestionStatus = decision === "approve" ? "approved" : "rejected";
  return enqueueQueueOperation(root, async () => {
    const suggestions = await readQueue(root);
    const index = suggestions.findIndex((suggestion) => suggestion.id === id);
    if (index < 0) throw new Error(`Knowledge suggestion ${id} was not found.`);
    const current = suggestions[index]!;
    if (current.status === "expired") throw new Error("Expired knowledge suggestions cannot be reviewed.");
    if (current.status === nextStatus) return { suggestion: current, applicationStatus: "pending" };
    if (current.status !== "proposed") throw new Error(`Review decision conflicts with existing ${current.status} status.`);
    const timestamp = new Date().toISOString();
    const next: KnowledgeSuggestion = {
      ...current,
      status: nextStatus,
      updatedAt: timestamp,
      reviewedAt: timestamp,
      ...(reason?.trim() ? { reviewReason: reason.trim() } : {})
    };
    suggestions[index] = next;
    await writeQueue(root, suggestions);
    return { suggestion: next, applicationStatus: "pending" };
  });
}

/** @internal Test-only diagnostic; not part of the public review-queue contract. */
export function __getKnowledgeReviewQueueSizeForTests(): number {
  return queueWriteChains.size;
}
