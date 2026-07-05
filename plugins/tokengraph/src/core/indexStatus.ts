import { loadProjectIndex } from "./persistence.js";
import { indexProject } from "./projectIndexer.js";
import type { IndexStatus } from "./types.js";

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
  const state = storedFingerprint === current.fingerprint ? "fresh" : "stale";

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
