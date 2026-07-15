import { canonicalHash, canonicalize } from "./canonical.js";

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
}

export interface ArtifactEnvelope<T> {
  taskId: string;
  routing: RoutingDecision;
  artifact?: StableArtifact<T>;
  artifactReference?: { id: string; hash: string };
  deliveredArtifacts: string[];
}

export function createStableArtifact<T>(id: string, content: T, artifactSchemaVersion = 1): StableArtifact<T> {
  const normalized = canonicalize(content);
  return {
    id,
    hash: canonicalHash({ artifactSchemaVersion, id, content: normalized }),
    artifactSchemaVersion,
    content: normalized
  };
}

export function artifactKey(artifact: Pick<StableArtifact<unknown>, "id" | "hash">): string {
  return `${artifact.id}@${artifact.hash}`;
}

export function shouldSuppressArtifact(artifact: Pick<StableArtifact<unknown>, "id" | "hash">, knownArtifacts?: string[]): boolean {
  return (knownArtifacts ?? []).includes(artifactKey(artifact));
}
