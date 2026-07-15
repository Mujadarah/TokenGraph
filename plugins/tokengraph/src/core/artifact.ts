import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalHash, canonicalize } from "./canonical.js";
import { repositoryDir } from "./persistence.js";
import { canonicalPersistenceLockKey, quarantineCorruptJson, withFileLock, writeJsonAtomic } from "./storage.js";

export interface RoutingDecision {
  useTokenGraph: boolean;
  stage: 0 | 1;
  reason: string;
  expectedOverheadTokens: number;
  expectedBenefit: number;
  enforced: boolean;
}

export interface StableArtifact<T> {
  id: string;
  hash: string;
  artifactSchemaVersion: number;
  content: T;
  hashContext?: ArtifactHashContext;
}

export interface ArtifactHashContext {
  repositoryFingerprint?: string;
  sourceFingerprint?: string;
  parserVersion?: string;
  normalizedIntent?: string;
  retrievalConfig?: unknown;
  memoryFingerprint?: string;
  decisionFingerprint?: string;
}

export interface ArtifactEnvelope<T> {
  taskId: string;
  routing: RoutingDecision;
  artifact?: StableArtifact<T>;
  artifactReference?: { id: string; hash: string };
  deliveredArtifacts: string[];
}

export function createStableArtifact<T>(id: string, content: T, artifactSchemaVersion = 1, hashContext: ArtifactHashContext = {}): StableArtifact<T> {
  const normalized = canonicalize(content);
  const normalizedContext = canonicalize(hashContext);
  return {
    id,
    hash: canonicalHash({ artifactSchemaVersion, id, hashContext: normalizedContext, content: normalized }),
    artifactSchemaVersion,
    content: normalized,
    ...(Object.keys(normalizedContext).length ? { hashContext: normalizedContext } : {})
  };
}

export function artifactKey(artifact: Pick<StableArtifact<unknown>, "id" | "hash">): string {
  return `${artifact.id}@${artifact.hash}`;
}

export function shouldSuppressArtifact(artifact: Pick<StableArtifact<unknown>, "id" | "hash">, knownArtifacts?: string[]): boolean {
  return (knownArtifacts ?? []).includes(artifactKey(artifact));
}

function artifactPath(directory: string, hash: string): string {
  return join(directory, "artifacts", `${hash}.json`);
}

export async function saveStableArtifact<T>(root: string, artifact: StableArtifact<T>): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(artifact.hash)) throw new Error("Stable artifact hash is invalid.");
  const directory = await repositoryDir(root);
  const path = artifactPath(directory, artifact.hash);
  const key = await canonicalPersistenceLockKey(directory, "artifacts", `${artifact.hash}.json`);
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(path, artifact));
}

export async function loadStableArtifact<T = unknown>(root: string, hash: string): Promise<StableArtifact<T> | undefined> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
  const directory = await repositoryDir(root);
  const path = artifactPath(directory, hash);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StableArtifact<T>;
    if (!parsed || typeof parsed !== "object" || parsed.hash !== hash || typeof parsed.id !== "string" || typeof parsed.artifactSchemaVersion !== "number") return undefined;
    const expected = createStableArtifact(parsed.id, parsed.content, parsed.artifactSchemaVersion, parsed.hashContext);
    return expected.hash === hash ? expected : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(path);
      return undefined;
    }
    throw error;
  }
}
