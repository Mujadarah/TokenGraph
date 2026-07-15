import { loadProjectIndex } from "./persistence.js";
import { indexProject } from "./projectIndexer.js";
import { scanProjectSignature } from "./fileScanner.js";
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

export async function getIndexStatus(root: string, options: { probeOnly?: boolean } = {}): Promise<IndexStatus> {
  const currentScanSignature = await scanProjectSignature(root);
  const stored = await loadProjectIndex(root);

  if (!stored) {
    return {
      root,
      state: "missing",
      hasIndex: false,
      currentScannedAt: new Date().toISOString(),
      currentFingerprint: currentScanSignature,
      currentScanSignature
    };
  }

  const storedFingerprint = typeof stored.fingerprint === "string" ? stored.fingerprint : undefined;
  const storedScanSignature = stored.scanSignature;
  const signatureFresh = storedScanSignature !== undefined && storedScanSignature === currentScanSignature;
  const current = signatureFresh || options.probeOnly ? undefined : await indexProject(root, { scanSignature: currentScanSignature });
  if (options.probeOnly && !signatureFresh) {
    return {
      root,
      state: "stale",
      hasIndex: true,
      storedScannedAt: stored.scannedAt,
      currentScannedAt: new Date().toISOString(),
      storedFingerprint,
      currentFingerprint: stored.fingerprint,
      storedScanSignature,
      currentScanSignature
    };
  }
  const state = signatureFresh || (current && isFreshProjectIndex(stored, current)) ? "fresh" : "stale";

  return {
    root,
    state,
    hasIndex: true,
    storedScannedAt: stored.scannedAt,
    currentScannedAt: current?.scannedAt ?? new Date().toISOString(),
    storedFingerprint,
    currentFingerprint: current?.fingerprint ?? stored.fingerprint,
    storedScanSignature,
    currentScanSignature
  };
}
