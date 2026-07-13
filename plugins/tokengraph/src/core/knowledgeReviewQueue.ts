import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { canonicalPersistenceLockKey, quarantineCorruptJson, resolveConfinedPath, withFileLock, writeJsonAtomic, writeTextAtomic } from "./storage.js";

export type KnowledgeSuggestionType = "wiki" | "memory" | "skill";
export type KnowledgeSuggestionStatus = "proposed" | "approved" | "rejected" | "expired";
export type KnowledgeReviewDecision = "approve" | "reject";

export interface KnowledgeSourceInput {
  kind: "path" | "id";
  sourceId: string;
  fingerprint: string;
}

export type KnowledgeSourceProvenance =
  | "pending-path-revalidation"
  | "revalidated-current"
  | "attested-unverifiable"
  | "legacy-unverifiable";

export interface KnowledgeSourceReference extends KnowledgeSourceInput {
  provenance: KnowledgeSourceProvenance;
}

export interface KnowledgeAffectedTargets {
  wikiPages: string[];
  memories: string[];
  skills: string[];
}

export interface KnowledgeProposalInput {
  type: KnowledgeSuggestionType;
  title: string;
  rationale: string;
  proposedContent: string;
  sourceFingerprints: string[];
  affectedIdentifiers: string[];
  sources?: KnowledgeSourceInput[];
  affectedTargets?: Partial<KnowledgeAffectedTargets>;
  conflictNotes?: string[];
  expiresAt?: string;
}

interface SanitizedKnowledgeProposal extends Omit<KnowledgeProposalInput, "sources" | "affectedTargets" | "conflictNotes"> {
  sources: KnowledgeSourceReference[];
  affectedTargets: KnowledgeAffectedTargets;
  conflictNotes: string[];
}

export interface KnowledgeSuggestion extends SanitizedKnowledgeProposal {
  id: string;
  fingerprint: string;
  status: KnowledgeSuggestionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  reviewedAt?: string;
  reviewReason?: string;
}

export interface AppliedKnowledge {
  suggestionId: string;
  fingerprint: string;
  type: KnowledgeSuggestionType;
  title: string;
  rationale: string;
  proposedContent: string;
  sources: KnowledgeSourceReference[];
  provenanceStatus: "revalidated-current" | "revalidated-with-attested-snapshots" | "attested-unverifiable";
  affectedTargets: KnowledgeAffectedTargets;
  conflictNotes: string[];
  appliedAt: string;
}

export interface KnowledgeSuggestionListOptions {
  type?: KnowledgeSuggestionType | KnowledgeSuggestionType[];
  status?: KnowledgeSuggestionStatus | KnowledgeSuggestionStatus[];
}

export interface KnowledgeReviewResult {
  suggestion: KnowledgeSuggestion;
  applicationStatus: "applied" | "not-applied";
  application?: AppliedKnowledge;
  provenanceStatus?: "revalidated-current" | "revalidated-with-attested-snapshots" | "attested-unverifiable";
}

const REVIEW_QUEUE_SCHEMA_VERSION = 3;
const APPLICATION_SCHEMA_VERSION = 2;
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;
const SUGGESTION_TYPES = new Set<KnowledgeSuggestionType>(["wiki", "memory", "skill"]);
const SUGGESTION_STATUSES = new Set<KnowledgeSuggestionStatus>(["proposed", "approved", "rejected", "expired"]);
const REVIEW_DECISIONS = new Set<KnowledgeReviewDecision>(["approve", "reject"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const MEMORY_ID_PATTERN = /^mem_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const queueWriteChains = new Map<string, Promise<void>>();

function queuePath(root: string): string {
  return join(resolve(root), ".tokengraph", "review-queue.json");
}

function applicationPath(root: string): string {
  return join(resolve(root), ".tokengraph", "knowledge-applications.json");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function normalizeUnique(values: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error(`${label} must contain ${allowEmpty ? "an array of" : "at least one"} value${allowEmpty ? "s" : ""}.`);
  }
  const normalized = values.map((value) => nonEmptyString(value, label));
  return Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
}

function validateAffectedIdentifiers(type: KnowledgeSuggestionType, values: unknown, allowEmpty = false): string[] {
  const identifiers = normalizeUnique(values, `Affected ${type} identifiers`, allowEmpty);
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

function normalizeSourceId(value: unknown): string {
  const sourceId = nonEmptyString(value, "Source id").replaceAll("\\", "/");
  if (isAbsolute(sourceId) || sourceId.startsWith("../") || sourceId.includes("/../") || !SOURCE_ID_PATTERN.test(sourceId)) {
    throw new Error("Source ids must be privacy-safe relative paths or stable logical ids.");
  }
  return sourceId;
}

function normalizeSources(value: unknown, legacyFingerprints: string[], persisted = false): KnowledgeSourceReference[] {
  const legacyOnly = value === undefined;
  const raw = value === undefined
    ? legacyFingerprints.map((fingerprint) => ({
      kind: "id" as const,
      sourceId: `source:${fingerprint}`,
      fingerprint,
      provenance: "legacy-unverifiable" as const
    }))
    : value;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Sources must contain at least one provenance reference.");
  const byKey = new Map<string, KnowledgeSourceReference>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Source references must be objects.");
    const source = item as Record<string, unknown>;
    const expectedKeys = persisted || legacyOnly ? ["kind", "sourceId", "fingerprint", "provenance"] : ["kind", "sourceId", "fingerprint"];
    if (!hasExactKeys(source, expectedKeys)) throw new Error("Source references contain unknown fields.");
    if (source.kind !== "path" && source.kind !== "id") throw new Error("Source kind must be path or id.");
    const provenance = persisted || legacyOnly
      ? source.provenance
      : source.kind === "path" ? "pending-path-revalidation" : "attested-unverifiable";
    const validProvenance = source.kind === "path"
      ? provenance === "pending-path-revalidation" || provenance === "revalidated-current"
      : provenance === "attested-unverifiable" || provenance === "legacy-unverifiable";
    if (!validProvenance) throw new Error("Source provenance does not match its source kind.");
    const normalized: KnowledgeSourceReference = {
      kind: source.kind,
      sourceId: normalizeSourceId(source.sourceId),
      fingerprint: nonEmptyString(source.fingerprint, "Source fingerprint"),
      provenance: provenance as KnowledgeSourceProvenance
    };
    byKey.set(`${normalized.sourceId}\0${normalized.fingerprint}`, normalized);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId) || left.fingerprint.localeCompare(right.fingerprint)
  );
}

function normalizeAffectedTargets(
  value: unknown,
  type: KnowledgeSuggestionType,
  legacyIdentifiers: string[]
): KnowledgeAffectedTargets {
  const raw = value === undefined ? {} : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Affected targets must be an object.");
  const target = raw as Record<string, unknown>;
  if (Object.keys(target).some((key) => !["wikiPages", "memories", "skills"].includes(key))) {
    throw new Error("Affected targets contain unknown fields.");
  }
  const result = {
    wikiPages: validateAffectedIdentifiers("wiki", target.wikiPages ?? (type === "wiki" ? legacyIdentifiers : []), true),
    memories: validateAffectedIdentifiers("memory", target.memories ?? (type === "memory" ? legacyIdentifiers : []), true),
    skills: validateAffectedIdentifiers("skill", target.skills ?? (type === "skill" ? legacyIdentifiers : []), true)
  };
  if (result.wikiPages.length + result.memories.length + result.skills.length === 0) {
    throw new Error("At least one affected knowledge target is required.");
  }
  return result;
}

function suggestionFingerprint(input: SanitizedKnowledgeProposal): string {
  return createHash("sha256")
    .update(JSON.stringify({
      type: input.type,
      title: input.title,
      rationale: input.rationale,
      proposedContent: input.proposedContent,
      sourceFingerprints: input.sourceFingerprints,
      affectedIdentifiers: input.affectedIdentifiers,
      sources: input.sources.map(({ kind, sourceId, fingerprint }) => ({ kind, sourceId, fingerprint })),
      affectedTargets: input.affectedTargets,
      conflictNotes: input.conflictNotes
    }))
    .digest("hex");
}

function sanitizeProposal(input: KnowledgeProposalInput): SanitizedKnowledgeProposal {
  const type = validateType(input.type);
  const sourceFingerprints = normalizeUnique(input.sourceFingerprints, "Source fingerprints");
  const affectedIdentifiers = validateAffectedIdentifiers(type, input.affectedIdentifiers);
  return {
    type,
    title: nonEmptyString(input.title, "Title"),
    rationale: nonEmptyString(input.rationale, "Rationale"),
    proposedContent: nonEmptyString(input.proposedContent, "Proposed content"),
    sourceFingerprints,
    affectedIdentifiers,
    sources: normalizeSources(input.sources, sourceFingerprints),
    affectedTargets: normalizeAffectedTargets(input.affectedTargets, type, affectedIdentifiers),
    conflictNotes: normalizeUnique(input.conflictNotes ?? [], "Conflict notes", true),
    ...(input.expiresAt === undefined ? {} : { expiresAt: validateTimestamp(input.expiresAt, "Expiry timestamp") })
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function reconstructSuggestion(value: unknown, schemaVersion: number): KnowledgeSuggestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Suggestion must be an object.");
  const candidate = value as Record<string, unknown>;
  const baseKeys = ["affectedIdentifiers", "createdAt", "fingerprint", "id", "proposedContent", "rationale", "sourceFingerprints", "status", "title", "type", "updatedAt"];
  const versionTwoKeys = ["sources", "affectedTargets", "conflictNotes", "expiresAt"];
  const expectedKeys = [
    ...baseKeys,
    ...(schemaVersion >= 2 ? versionTwoKeys : []),
    ...(candidate.reviewedAt === undefined ? [] : ["reviewedAt"]),
    ...(candidate.reviewReason === undefined ? [] : ["reviewReason"])
  ];
  if (!hasExactKeys(candidate, expectedKeys)) throw new Error("Suggestion contains unknown or missing persisted fields.");
  if (typeof candidate.id !== "string" || !UUID_PATTERN.test(candidate.id)) throw new Error("Suggestion id must be a UUID.");
  const type = validateType(candidate.type);
  const createdAt = validateTimestamp(candidate.createdAt, "Created timestamp");
  const persistedSources = schemaVersion >= 2
    ? normalizeSources(candidate.sources, [], schemaVersion >= 3)
    : undefined;
  const proposal = sanitizeProposal({
    type,
    title: candidate.title as string,
    rationale: candidate.rationale as string,
    proposedContent: candidate.proposedContent as string,
    sourceFingerprints: candidate.sourceFingerprints as string[],
    affectedIdentifiers: candidate.affectedIdentifiers as string[],
    ...(schemaVersion >= 2 ? {
      sources: persistedSources?.map(({ kind, sourceId, fingerprint }) => ({ kind, sourceId, fingerprint })),
      affectedTargets: candidate.affectedTargets as KnowledgeAffectedTargets,
      conflictNotes: candidate.conflictNotes as string[],
      expiresAt: candidate.expiresAt as string
    } : {})
  });
  if (persistedSources) proposal.sources = persistedSources;
  const expectedFingerprint = schemaVersion === 1
    ? createHash("sha256").update(JSON.stringify({
      type: proposal.type,
      title: proposal.title,
      proposedContent: proposal.proposedContent,
      sourceFingerprints: proposal.sourceFingerprints,
      affectedIdentifiers: proposal.affectedIdentifiers
    })).digest("hex")
    : suggestionFingerprint(proposal);
  if (typeof candidate.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(candidate.fingerprint) || candidate.fingerprint !== expectedFingerprint) {
    throw new Error("Suggestion fingerprint is invalid or does not match its content.");
  }
  return {
    id: candidate.id,
    fingerprint: schemaVersion === 1 ? suggestionFingerprint(proposal) : candidate.fingerprint,
    ...proposal,
    expiresAt: schemaVersion === 1
      ? new Date(Date.parse(createdAt) + DEFAULT_EXPIRY_MS).toISOString()
      : validateTimestamp(candidate.expiresAt, "Expiry timestamp"),
    status: validateStatus(candidate.status),
    createdAt,
    updatedAt: validateTimestamp(candidate.updatedAt, "Updated timestamp"),
    ...(candidate.reviewedAt === undefined ? {} : { reviewedAt: validateTimestamp(candidate.reviewedAt, "Reviewed timestamp") }),
    ...(candidate.reviewReason === undefined ? {} : { reviewReason: nonEmptyString(candidate.reviewReason, "Review reason") })
  };
}

async function readQueue(root: string): Promise<KnowledgeSuggestion[]> {
  const path = queuePath(root);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Queue must be an object.");
    const queue = parsed as Record<string, unknown>;
    if (!hasExactKeys(queue, ["schemaVersion", "suggestions"]) || ![1, 2, 3].includes(queue.schemaVersion as number) || !Array.isArray(queue.suggestions)) {
      throw new Error("Queue schema is invalid.");
    }
    return queue.suggestions.map((suggestion) => reconstructSuggestion(suggestion, queue.schemaVersion as number));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    await quarantineCorruptJson(path);
    return [];
  }
}

async function writeQueue(root: string, suggestions: KnowledgeSuggestion[]): Promise<void> {
  await writeJsonAtomic(queuePath(root), { schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION, suggestions });
}

function applicationProvenanceStatus(sources: KnowledgeSourceReference[]): AppliedKnowledge["provenanceStatus"] {
  const hasPath = sources.some((source) => source.kind === "path");
  if (!hasPath) return "attested-unverifiable";
  return sources.some((source) => source.kind === "id")
    ? "revalidated-with-attested-snapshots"
    : "revalidated-current";
}

function revalidatedApplicationSources(sources: KnowledgeSourceReference[]): KnowledgeSourceReference[] {
  return sources.map((source) => source.kind === "path"
    ? { ...source, provenance: "revalidated-current" }
    : source);
}

function reconstructApplication(value: unknown, schemaVersion: number): AppliedKnowledge {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Applied knowledge must be an object.");
  const candidate = value as Record<string, unknown>;
  const keys = [
    "affectedTargets", "appliedAt", "conflictNotes", "fingerprint", "proposedContent", "rationale", "sources", "suggestionId", "title", "type",
    ...(schemaVersion >= 2 ? ["provenanceStatus"] : [])
  ];
  if (!hasExactKeys(candidate, keys) || typeof candidate.suggestionId !== "string" || !UUID_PATTERN.test(candidate.suggestionId)) {
    throw new Error("Applied knowledge schema is invalid.");
  }
  const sourceItemsHaveProvenance = Array.isArray(candidate.sources) && candidate.sources.every((source) =>
    Boolean(source && typeof source === "object" && !Array.isArray(source) && "provenance" in source));
  const sources = schemaVersion >= 2
    ? normalizeSources(candidate.sources, [], true)
    : revalidatedApplicationSources(normalizeSources(candidate.sources, [], sourceItemsHaveProvenance));
  const provenanceStatus = applicationProvenanceStatus(sources);
  if (schemaVersion >= 2 && candidate.provenanceStatus !== provenanceStatus) {
    throw new Error("Applied knowledge provenance status does not match its sources.");
  }
  return {
    suggestionId: candidate.suggestionId,
    fingerprint: nonEmptyString(candidate.fingerprint, "Application fingerprint"),
    type: validateType(candidate.type),
    title: nonEmptyString(candidate.title, "Application title"),
    rationale: nonEmptyString(candidate.rationale, "Application rationale"),
    proposedContent: nonEmptyString(candidate.proposedContent, "Applied content"),
    sources,
    provenanceStatus,
    affectedTargets: normalizeAffectedTargets(candidate.affectedTargets, validateType(candidate.type), []),
    conflictNotes: normalizeUnique(candidate.conflictNotes, "Conflict notes", true),
    appliedAt: validateTimestamp(candidate.appliedAt, "Applied timestamp")
  };
}

async function readApplications(root: string): Promise<AppliedKnowledge[]> {
  const path = applicationPath(root);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Application store must be an object.");
    const store = parsed as Record<string, unknown>;
    if (!hasExactKeys(store, ["schemaVersion", "applications"]) || ![1, 2].includes(store.schemaVersion as number) || !Array.isArray(store.applications)) {
      throw new Error("Application store schema is invalid.");
    }
    const applications = store.applications.map((application) => reconstructApplication(application, store.schemaVersion as number));
    if (new Set(applications.map((application) => application.suggestionId)).size !== applications.length) {
      throw new Error("Application ids must be unique.");
    }
    return applications;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    await quarantineCorruptJson(path);
    return [];
  }
}

function targetFiles(root: string, application: AppliedKnowledge): string[] {
  const base = join(resolve(root), ".tokengraph", "knowledge");
  return [
    ...application.affectedTargets.wikiPages.map((slug) => join(base, "wiki", ...slug.split("/"), `${application.suggestionId}.md`)),
    ...application.affectedTargets.memories.map((id) => join(base, "memories", id, `${application.suggestionId}.md`)),
    ...application.affectedTargets.skills.map((name) => join(base, "skills", name, `${application.suggestionId}.md`))
  ];
}

function applicationMarkdown(application: AppliedKnowledge): string {
  return [
    "---",
    `suggestion_id: "${application.suggestionId}"`,
    `title: ${JSON.stringify(application.title)}`,
    `applied_at: "${application.appliedAt}"`,
    "---",
    "",
    application.proposedContent,
    ""
  ].join("\n");
}

async function writeApplication(root: string, applications: AppliedKnowledge[], application: AppliedKnowledge): Promise<void> {
  await ensureApplicationTargets(root, application);
  await writeJsonAtomic(applicationPath(root), { schemaVersion: APPLICATION_SCHEMA_VERSION, applications: [...applications, application] });
}

async function ensureApplicationTargets(root: string, application: AppliedKnowledge): Promise<void> {
  const expected = applicationMarkdown(application);
  const logicalBase = join(resolve(root), ".tokengraph", "knowledge");
  for (const logicalPath of targetFiles(root, application)) {
    const path = await resolveConfinedPath(root, join(".tokengraph", "knowledge", relative(logicalBase, logicalPath)), true);
    try {
      const existing = await readFile(path, "utf8");
      if (existing !== expected) throw new Error("Applied knowledge target differs from its reviewed payload.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeTextAtomic(path, expected);
    }
  }
}

function applicationMatchesSuggestion(application: AppliedKnowledge, suggestion: KnowledgeSuggestion): boolean {
  return application.suggestionId === suggestion.id &&
    application.fingerprint === suggestion.fingerprint &&
    application.type === suggestion.type &&
    application.title === suggestion.title &&
    application.rationale === suggestion.rationale &&
    application.proposedContent === suggestion.proposedContent &&
    JSON.stringify(application.sources) === JSON.stringify(revalidatedApplicationSources(suggestion.sources)) &&
    application.provenanceStatus === applicationProvenanceStatus(application.sources) &&
    JSON.stringify(application.affectedTargets) === JSON.stringify(suggestion.affectedTargets) &&
    JSON.stringify(application.conflictNotes) === JSON.stringify(suggestion.conflictNotes);
}

async function assertFreshForApproval(root: string, suggestion: KnowledgeSuggestion): Promise<void> {
  if (!suggestion.sources.some((source) => source.kind === "path")) {
    throw new Error("ID-only or legacy unverifiable knowledge cannot be approved without at least one canonical path source.");
  }
  for (const source of suggestion.sources) {
    if (source.kind !== "path") continue;
    let content: Buffer;
    try {
      const canonicalRoot = await realpath(resolve(root));
      const canonicalSource = await realpath(join(canonicalRoot, ...source.sourceId.split("/")));
      const confined = relative(canonicalRoot, canonicalSource);
      if (!confined || confined.startsWith("..") || isAbsolute(confined)) {
        throw new Error(`Knowledge source ${source.sourceId} resolves outside the trusted workspace.`);
      }
      content = await readFile(canonicalSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Knowledge suggestion is stale because source ${source.sourceId} is missing.`);
      throw error;
    }
    const current = createHash("sha256").update(content.toString("utf8").replace(/\r\n?/g, "\n")).digest("hex");
    if (current !== source.fingerprint) throw new Error(`Knowledge suggestion is stale because source ${source.sourceId} fingerprint changed.`);
  }
}

async function enqueueQueueOperation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "review-queue.json");
  const previous = queueWriteChains.get(key) ?? Promise.resolve();
  const current = previous.then(
    () => withFileLock(`${key}.lock`, operation),
    () => withFileLock(`${key}.lock`, operation)
  );
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
      expiresAt: proposal.expiresAt ?? new Date(Date.parse(timestamp) + DEFAULT_EXPIRY_MS).toISOString(),
      status: "proposed",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    suggestions.push(suggestion);
    await writeQueue(root, suggestions);
    return suggestion;
  });
}

export async function listKnowledgeSuggestions(root: string, options: KnowledgeSuggestionListOptions = {}): Promise<KnowledgeSuggestion[]> {
  const suggestions = await readQueue(root);
  const types = options.type === undefined ? undefined : Array.isArray(options.type) ? options.type : [options.type];
  const statuses = options.status === undefined ? undefined : Array.isArray(options.status) ? options.status : [options.status];
  types?.forEach(validateType);
  statuses?.forEach(validateStatus);
  return suggestions.filter((suggestion) => (!types || types.includes(suggestion.type)) && (!statuses || statuses.includes(suggestion.status)));
}

export async function listAppliedKnowledge(root: string): Promise<AppliedKnowledge[]> {
  const [applications, suggestions] = await Promise.all([readApplications(root), readQueue(root)]);
  return applications.filter((application) => {
    const suggestion = suggestions.find((candidate) => candidate.id === application.suggestionId && candidate.status === "approved");
    return Boolean(suggestion && applicationMatchesSuggestion(application, suggestion));
  });
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
    const applications = await readApplications(root);
    const existingApplication = applications.find((application) => application.suggestionId === id);
    if (decision === "approve" && existingApplication && !applicationMatchesSuggestion(existingApplication, current)) {
      throw new Error("Durable application does not match the reviewed proposal payload.");
    }

    if (current.status === "expired") throw new Error("Expired knowledge suggestions cannot be reviewed.");
    if (current.status === nextStatus) {
      if (decision === "approve") {
        if (existingApplication) return {
          suggestion: current,
          applicationStatus: "applied",
          application: existingApplication,
          provenanceStatus: existingApplication.provenanceStatus
        };
        if (Date.parse(current.expiresAt) <= Date.now()) {
          suggestions[index] = { ...current, status: "expired", updatedAt: new Date().toISOString() };
          await writeQueue(root, suggestions);
          throw new Error("Knowledge suggestion has expired and cannot be recovered or applied.");
        }
        await assertFreshForApproval(root, current);
        const migratedApplication = applicationForSuggestion(current, current.reviewedAt ?? current.updatedAt);
        await writeApplication(root, applications, migratedApplication);
        await writeQueue(root, suggestions);
        return {
          suggestion: current,
          applicationStatus: "applied",
          application: migratedApplication,
          provenanceStatus: migratedApplication.provenanceStatus
        };
      }
      return { suggestion: current, applicationStatus: "not-applied" };
    }
    if (current.status !== "proposed") throw new Error(`Review decision conflicts with existing ${current.status} status.`);

    if (decision === "reject" && existingApplication) {
      throw new Error("An application record already exists; resume approval to recover it before any later review action.");
    }
    if (decision === "approve" && Date.parse(current.expiresAt) <= Date.now()) {
      suggestions[index] = { ...current, status: "expired", updatedAt: new Date().toISOString() };
      await writeQueue(root, suggestions);
      throw new Error("Knowledge suggestion has expired and cannot be applied.");
    }
    if (decision === "approve") await assertFreshForApproval(root, current);
    const timestamp = decision === "approve" ? (existingApplication?.appliedAt ?? current.reviewedAt ?? current.updatedAt) : new Date().toISOString();
    const next: KnowledgeSuggestion = {
      ...current,
      status: nextStatus,
      updatedAt: timestamp,
      reviewedAt: timestamp,
      ...(reason?.trim() ? { reviewReason: reason.trim() } : {})
    };
    suggestions[index] = next;

    if (decision === "reject") {
      await writeQueue(root, suggestions);
      return { suggestion: next, applicationStatus: "not-applied" };
    }

    const application: AppliedKnowledge = existingApplication ?? applicationForSuggestion(current, timestamp);
    if (existingApplication) await ensureApplicationTargets(root, existingApplication);
    else await writeApplication(root, applications, application);
    await writeQueue(root, suggestions);
    return {
      suggestion: next,
      applicationStatus: "applied",
      application,
      provenanceStatus: application.provenanceStatus
    };
  });
}

function applicationForSuggestion(suggestion: KnowledgeSuggestion, appliedAt: string): AppliedKnowledge {
  const sources = revalidatedApplicationSources(suggestion.sources);
  return {
    suggestionId: suggestion.id,
    fingerprint: suggestion.fingerprint,
    type: suggestion.type,
    title: suggestion.title,
    rationale: suggestion.rationale,
    proposedContent: suggestion.proposedContent,
    sources,
    provenanceStatus: applicationProvenanceStatus(sources),
    affectedTargets: suggestion.affectedTargets,
    conflictNotes: suggestion.conflictNotes,
    appliedAt
  };
}

/** @internal Test-only diagnostic; not part of the public review-queue contract. */
export function __getKnowledgeReviewQueueSizeForTests(): number {
  return queueWriteChains.size;
}
