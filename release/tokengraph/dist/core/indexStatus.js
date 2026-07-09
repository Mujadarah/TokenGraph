import { loadProjectIndex } from "./persistence.js";
import { indexProject } from "./projectIndexer.js";
import { scanProjectSignature } from "./fileScanner.js";
function comparableIndex(project) {
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
export function isFreshProjectIndex(stored, current) {
    return stored.fingerprint === current.fingerprint && JSON.stringify(comparableIndex(stored)) === JSON.stringify(comparableIndex(current));
}
export async function getIndexStatus(root) {
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
    const current = signatureFresh ? undefined : await indexProject(root, { scanSignature: currentScanSignature });
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
