import { loadProjectIndex } from "./persistence.js";
import { indexProject, type ProjectIndexOptions } from "./projectIndexer.js";
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

export async function getIndexStatus(root: string, options: { probeOnly?: boolean; projectOptions?: ProjectIndexOptions } = {}): Promise<IndexStatus> {
  const stored = await loadProjectIndex(root);

  // Stage 0 routing is a cached-state decision. It must not walk or parse the
  // workspace before the advisor decides whether TokenGraph should activate.
  if (options.probeOnly) {
    return stored ? {
      root,
      state: "fresh",
      hasIndex: true,
      storedScannedAt: stored.scannedAt,
      currentScannedAt: stored.scannedAt,
      storedFingerprint: stored.fingerprint,
      currentFingerprint: stored.fingerprint,
      storedScanSignature: stored.scanSignature,
      currentScanSignature: stored.scanSignature
    } : {
      root,
      state: "missing",
      hasIndex: false,
      currentScannedAt: new Date().toISOString(),
      currentFingerprint: "not-scanned"
    };
  }

  const currentScanSignature = await scanProjectSignature(root, options.projectOptions?.parserLimits);

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
  const current = signatureFresh ? undefined : await indexProject(root, { ...options.projectOptions, scanSignature: currentScanSignature });
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
