import { loadProjectIndex } from "./persistence.js";
import { indexProject } from "./projectIndexer.js";
import type { IndexStatus, ProjectIndex } from "./types.js";

function comparableIndex(project: ProjectIndex) {
  return {
    root: project.root,
    files: project.files,
    symbols: project.symbols,
    imports: project.imports,
    exclusions: project.exclusions,
    frameworks: project.frameworks,
    sql: project.sql
  };
}

export function isFreshProjectIndex(stored: ProjectIndex, current: ProjectIndex): boolean {
  return stored.fingerprint === current.fingerprint && JSON.stringify(comparableIndex(stored)) === JSON.stringify(comparableIndex(current));
}

export async function getIndexStatus(root: string): Promise<IndexStatus> {
  const current = await indexProject(root);
  const stored = await loadProjectIndex(root);

  if (!stored) {
    return {
      root,
      state: "missing",
      hasIndex: false,
      currentScannedAt: current.scannedAt,
      currentFingerprint: current.fingerprint
    };
  }

  const storedFingerprint = typeof stored.fingerprint === "string" ? stored.fingerprint : undefined;
  const state = isFreshProjectIndex(stored, current) ? "fresh" : "stale";

  return {
    root,
    state,
    hasIndex: true,
    storedScannedAt: stored.scannedAt,
    currentScannedAt: current.scannedAt,
    storedFingerprint,
    currentFingerprint: current.fingerprint
  };
}
