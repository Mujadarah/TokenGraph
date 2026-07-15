import { readFile } from "node:fs/promises";

import { artifactKey, createStableArtifact, type StableArtifact } from "./artifact.js";
import { canonicalHash } from "./canonical.js";
import { resolveConfinedPath } from "./storage.js";
import type { CodeFile, CodeSymbol, ProjectIndex } from "./types.js";

export interface RetrievalCapsule {
  taskId: string;
  query: string;
  files: Array<Pick<CodeFile, "path" | "kind" | "language" | "estimatedTokens" | "contentHash">>;
  symbols: Array<Pick<CodeSymbol, "name" | "kind" | "filePath" | "exported" | "startLine" | "endLine">>;
  references: string[];
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
}

export interface DeltaHandshake {
  handshakeId: string;
  hostContextId: string;
  sequence: number;
}

export interface ArtifactDelta<T> {
  handshake: DeltaHandshake;
  artifacts: Array<StableArtifact<T>>;
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

export function buildRetrievalCapsule(taskId: string, query: string, index: ProjectIndex, paths: string[] = []): RetrievalCapsule {
  const selectedPaths = new Set(paths.length ? paths : rankFilesBm25(index, query, 8).map((entry) => entry.path));
  const files = index.files.filter((file) => selectedPaths.has(file.path)).map(({ path, kind, language, estimatedTokens, contentHash }) => ({ path, kind, language, estimatedTokens, contentHash }));
  const symbols = index.symbols.filter((symbol) => selectedPaths.has(symbol.filePath)).map(({ name, kind, filePath, exported, startLine, endLine }) => ({ name, kind, filePath, exported, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) }));
  const references = expandGraph(index, [...selectedPaths]);
  const content = { taskId, query, files, symbols, references };
  return { ...content, hash: canonicalHash(content) };
}

export function capsuleArtifact(capsule: RetrievalCapsule): StableArtifact<RetrievalCapsule> {
  return createStableArtifact(`capsule/${capsule.taskId}`, capsule);
}

export async function readExactSlice(root: string, path: string, startLine: number, endLine: number, maxBytes = 64 * 1024): Promise<{ path: string; startLine: number; endLine: number; text: string; hash: string }> {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine > 500) throw new Error("Exact slice line bounds are invalid.");
  const filePath = await resolveConfinedPath(root, path);
  const text = await readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/).slice(startLine - 1, endLine);
  const slice = lines.join("\n");
  if (Buffer.byteLength(slice, "utf8") > maxBytes) throw new Error("Exact slice exceeds the configured byte limit.");
  return { path, startLine, endLine: startLine + lines.length - 1, text: slice, hash: canonicalHash({ path, startLine, endLine, text: slice }) };
}

export function escalateReadPolicy(current: ReadPolicyState, requested: RetrievalLevel): ReadPolicyState {
  const levels: RetrievalLevel[] = ["L0", "L1", "L2", "L3", "L4"];
  const next = levels[Math.max(levels.indexOf(current.level), levels.indexOf(requested))] ?? current.level;
  return {
    level: next,
    allowRawReads: current.allowRawReads || next === "L3" || next === "L4",
    reason: next === current.level ? current.reason : `escalated to ${next} for validated task evidence`
  };
}

export function deliverDelta<T>(expected: DeltaHandshake, actual: DeltaHandshake, artifacts: Array<StableArtifact<T>>): ArtifactDelta<T> {
  if (expected.handshakeId !== actual.handshakeId || expected.hostContextId !== actual.hostContextId || actual.sequence !== expected.sequence + 1) {
    throw new Error("Host context handshake mismatch; refusing delta delivery.");
  }
  return { handshake: actual, artifacts: artifacts.filter((artifact, index, all) => all.findIndex((candidate) => artifactKey(candidate) === artifactKey(artifact)) === index) };
}
