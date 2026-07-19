import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { artifactKey, createStableArtifact, shouldSuppressArtifact, type StableArtifact } from "./artifact.js";
import { canonicalHash } from "./canonical.js";
import { resolveConfinedPath } from "./storage.js";
import type { CodeFile, CodeSymbol, EvidenceStatement, ProjectIndex } from "./types.js";

type FileStatement = Pick<CodeFile, "path" | "kind" | "language" | "estimatedTokens" | "contentHash"> & EvidenceStatement;
type SymbolStatement = Pick<CodeSymbol, "name" | "kind" | "filePath" | "exported" | "startLine" | "endLine"> & EvidenceStatement;
type ReferenceStatement = { path: string } & EvidenceStatement;

export interface RetrievalCapsule {
  query: string;
  files: FileStatement[];
  symbols: SymbolStatement[];
  references: ReferenceStatement[];
  hash: string;
}

export interface RankedFile {
  path: string;
  score: number;
  rank: number;
}

export type RetrievalLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export interface ReadPolicyState {
  level: RetrievalLevel;
  allowRawReads: boolean;
  reason: string;
  targetedReads?: number;
  recommendedReadsThisResponse?: number;
  requiresReassessment?: boolean;
  hasReassessed?: boolean;
  evidenceGap?: string;
}

export interface DeltaHandshake {
  handshakeId: string;
  hostContextId: string;
  sequence: number;
}

export interface ArtifactDelta<T> {
  handshake: DeltaHandshake;
  artifacts: Array<StableArtifact<T>>;
  artifactReferences: Array<{ id: string; hash: string }>;
}

export interface ExactReadRecommendation {
  allowed: boolean;
  reason: string;
  state: ReadPolicyState;
}

export function buildEvidenceBackedSliceRecommendation(path: string, startLine: number, endLine: number, contentHash: string) {
  return {
    mode: "slice" as const, file: path, startLine, endLine, contentHash,
    text: `Read the indexed symbol range ${path}:${startLine}-${endLine}.`,
    evidenceClass: "derived" as const,
    confidence: "high" as const,
    source: `index:symbol-range:${path}@${contentHash}:${startLine}-${endLine}`
  };
}

function terms(value: string): string[] {
  return value.toLocaleLowerCase().match(/[a-z0-9_/-]+/g) ?? [];
}

function documentText(file: CodeFile, index: ProjectIndex): string {
  const symbols = index.symbols.filter((symbol) => symbol.filePath === file.path).map((symbol) => `${symbol.name} ${symbol.kind}`).join(" ");
  return `${file.path} ${file.kind} ${file.language} ${symbols}`.toLocaleLowerCase();
}

export function rankFilesBm25(index: ProjectIndex, query: string, limit = 10): RankedFile[] {
  const queryTerms = terms(query);
  if (!queryTerms.length) return [];
  const documents = index.files.map((file) => ({ file, tokens: terms(documentText(file, index)) }));
  const averageLength = documents.reduce((sum, entry) => sum + entry.tokens.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const term of new Set(queryTerms)) documentFrequency.set(term, documents.filter((entry) => entry.tokens.includes(term)).length);
  const scored = documents.map(({ file, tokens: docTokens }) => {
    const length = docTokens.length;
    let score = 0;
    for (const term of queryTerms) {
      const frequency = docTokens.filter((token) => token === term).length;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / Math.max(1, averageLength))));
    }
    return { path: file.path, score: Number(score.toFixed(6)) };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, Math.max(0, limit)).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function expandGraph(index: ProjectIndex, paths: string[], depth = 1): string[] {
  const selected = new Set(paths);
  let frontier = new Set(paths);
  for (let level = 0; level < Math.max(0, depth); level += 1) {
    const next = new Set<string>();
    for (const edge of index.imports) {
      if (frontier.has(edge.filePath) && edge.resolvedPath) next.add(edge.resolvedPath);
    }
    for (const path of next) selected.add(path);
    frontier = next;
  }
  return [...selected].sort();
}

export function buildRetrievalCapsule(_taskId: string, query: string, index: ProjectIndex, paths: string[] = [], graphDepth = 1): RetrievalCapsule {
  const selectedPaths = new Set(paths.length ? paths : rankFilesBm25(index, query, 8).map((entry) => entry.path));
  const files = index.files.filter((file) => selectedPaths.has(file.path)).map(({ path, kind, language, estimatedTokens, contentHash }) => ({
    path, kind, language, estimatedTokens, contentHash,
    text: `${path} is an indexed ${language} ${kind} (${estimatedTokens} estimated tokens).`,
    evidenceClass: "indexed" as const,
    confidence: "high" as const,
    source: `index:file:${path}@${contentHash}`
  }));
  const symbols = index.symbols.filter((symbol) => selectedPaths.has(symbol.filePath)).map(({ name, kind, filePath, exported, startLine, endLine }) => ({
    name, kind, filePath, exported,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    text: `${name} is an indexed ${kind} in ${filePath}${startLine === undefined ? "." : ` at lines ${startLine}-${endLine ?? startLine}.`}`,
    evidenceClass: "indexed" as const,
    confidence: startLine === undefined ? "medium" as const : "high" as const,
    source: `index:symbol:${filePath}:${name}${startLine === undefined ? "" : `:${startLine}-${endLine ?? startLine}`}`
  }));
  const references = expandGraph(index, [...selectedPaths], graphDepth).map((path) => ({
    path,
    text: `${path} is reachable from the selected files in the indexed import graph.`,
    evidenceClass: "derived" as const,
    confidence: "high" as const,
    source: `index:import-graph:${path}`
  }));
  const content = { query, files, symbols, references };
  return { ...content, hash: canonicalHash(content) };
}

export function capsuleArtifact(capsule: RetrievalCapsule): StableArtifact<RetrievalCapsule> {
  return createStableArtifact("capsule/retrieval", capsule, 3);
}

export async function readExactSlice(root: string, path: string, startLine: number, endLine: number, maxBytes = 64 * 1024, expectedContentHash?: string, maxSourceBytes = 512 * 1024): Promise<{ path: string; startLine: number; endLine: number; text: string; hash: string; contentHash: string }> {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine > 500) throw new Error("Exact slice line bounds are invalid.");
  if (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1) throw new Error("Exact slice source byte limit is invalid.");
  const filePath = await resolveConfinedPath(root, path);
  const handle = await open(filePath, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(maxSourceBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxSourceBytes) throw new Error("Exact slice source file exceeds the configured byte limit.");
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const normalizedText = text.replace(/\r\n?/g, "\n");
  const contentHash = createHash("sha256").update(normalizedText).digest("hex");
  if (expectedContentHash !== undefined && contentHash !== expectedContentHash) {
    throw new Error("The requested exact slice does not match the current source hash after reading the file.");
  }
  const lines = normalizedText.split("\n").slice(startLine - 1, endLine);
  const slice = lines.join("\n");
  if (Buffer.byteLength(slice, "utf8") > maxBytes) throw new Error("Exact slice exceeds the configured byte limit.");
  return { path, startLine, endLine: startLine + lines.length - 1, text: slice, hash: canonicalHash({ path, startLine, endLine, text: slice }), contentHash };
}

export function escalateReadPolicy(current: ReadPolicyState, requested: RetrievalLevel): ReadPolicyState {
  const levels: RetrievalLevel[] = ["L0", "L1", "L2", "L3", "L4"];
  const next = levels[Math.max(levels.indexOf(current.level), levels.indexOf(requested))] ?? current.level;
  return {
    level: next,
    allowRawReads: current.allowRawReads || next === "L3" || next === "L4",
    reason: next === current.level ? current.reason : `escalated to ${next} for validated task evidence`,
    targetedReads: current.targetedReads ?? 0,
    recommendedReadsThisResponse: current.recommendedReadsThisResponse ?? 0,
    requiresReassessment: current.requiresReassessment ?? false,
    hasReassessed: current.hasReassessed ?? false,
    ...(current.evidenceGap ? { evidenceGap: current.evidenceGap } : {})
  };
}

export function startReadPolicyResponse(current: ReadPolicyState): ReadPolicyState {
  return { ...current, recommendedReadsThisResponse: 0 };
}

export function recommendExactRead(current: ReadPolicyState, options: { reassessed?: boolean; evidenceGap?: string } = {}): ExactReadRecommendation {
  const targetedReads = current.targetedReads ?? 0;
  const recommendedReadsThisResponse = current.recommendedReadsThisResponse ?? 0;
  const evidenceGap = options.evidenceGap?.trim();
  const hasReassessed = current.hasReassessed === true || options.reassessed === true;
  const state = {
    ...current,
    targetedReads,
    recommendedReadsThisResponse,
    requiresReassessment: current.requiresReassessment ?? false,
    hasReassessed
  };
  if (!current.allowRawReads) return { allowed: false, reason: "Exact reads require an evidence-backed L3 or L4 escalation.", state };
  if (recommendedReadsThisResponse >= 1) return { allowed: false, reason: "At most one exact read may be recommended per response.", state };
  if (targetedReads >= 3 && !hasReassessed) return { allowed: false, reason: "Evidence sufficiency reassessment is required after three targeted reads.", state: { ...state, requiresReassessment: true } };
  if (targetedReads >= 3 && !evidenceGap) return { allowed: false, reason: "Further exact reads require an explicit evidence gap.", state };
  const nextReads = targetedReads + 1;
  return {
    allowed: true,
    reason: evidenceGap ? `Exact read justified by evidence gap: ${evidenceGap}` : "Exact read is within the targeted-read budget.",
    state: {
      ...state,
      targetedReads: nextReads,
      recommendedReadsThisResponse: 1,
      requiresReassessment: nextReads >= 3 && !hasReassessed,
      ...(evidenceGap ? { evidenceGap } : {})
    }
  };
}

export function deliverDelta<T>(expected: DeltaHandshake, actual: DeltaHandshake, artifacts: Array<StableArtifact<T>>, knownArtifacts?: string[]): ArtifactDelta<T> {
  if (expected.handshakeId !== actual.handshakeId || expected.hostContextId !== actual.hostContextId || actual.sequence !== expected.sequence + 1) {
    throw new Error("Host context handshake mismatch; refusing delta delivery.");
  }
  const unique = artifacts.filter((artifact, index, all) => all.findIndex((candidate) => artifactKey(candidate) === artifactKey(artifact)) === index);
  return {
    handshake: actual,
    artifacts: unique.filter((artifact) => !shouldSuppressArtifact(artifact, knownArtifacts)),
    artifactReferences: unique.filter((artifact) => shouldSuppressArtifact(artifact, knownArtifacts)).map(({ id, hash }) => ({ id, hash }))
  };
}
