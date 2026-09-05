import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalPersistenceLock } from "./lockDomain.js";
import { getLegacyRuntimeActivationStatus } from "./legacyRuntimeActivation.js";
import { CURRENT_INDEX_SCHEMA_VERSION, projectIndexFingerprint, validatedContentSetHash } from "./projectIndexer.js";
import { assertNoSymbolicLinkComponents, observeSuccessfulWrite, quarantineCorruptJson, resolveConfinedPath, withDestructiveMaintenance, withFileLock, writeTextAtomic, writeTextAtomicConfined, SAFE_WIKI_SLUG_PATTERN, type DestructiveMaintenanceConfirmation } from "./storage.js";
import { getRepositoryIdentity, resolveRepositoryStateDirectory } from "./repositoryIdentity.js";
import type { StorageClassQuotas } from "./storagePolicy.js";
import type { ProjectIndex, ProjectWiki, WikiPage } from "./types.js";
import type { VaultNote } from "./vaultProjection.js";

export function stateDir(root: string): string {
  return join(root, ".tokengraph");
}

export async function repositoryDir(root: string): Promise<string> {
  return resolveRepositoryStateDirectory(root);
}

export async function repositoryIndexPath(root: string): Promise<string> {
  return join(await repositoryDir(root), "index.json");
}

/** Repository-scoped durable knowledge paths. Worktree ledgers/runs remain in stateDir(). */
export async function repositoryMemoryPath(root: string): Promise<string> {
  return migrateRepositoryRecord(root, "memory.json");
}

export async function repositoryRulesPath(root: string): Promise<string> {
  return migrateRepositoryRecord(root, "rules.json");
}

async function migrateRepositoryRecord(root: string, fileName: "memory.json" | "rules.json"): Promise<string> {
  const directory = await repositoryDir(root);
  const target = join(directory, fileName);
  try {
    await readFile(target, "utf8");
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Copying legacy worktree knowledge into the repository store is a mutation
  // and only runs after activation while owning the repository-state domain. An
  // unactivated pure path lookup returns the target without migrating.
  if (!getLegacyRuntimeActivationStatus().activated) return target;
  const legacy = join(stateDir(root), fileName);
  try {
    const contents = await readFile(legacy, "utf8");
    const lock = await canonicalPersistenceLock(root, "repository-state", fileName);
    await withFileLock(lock, async () => {
      try {
        await readFile(target, "utf8");
      } catch (targetError) {
        if ((targetError as NodeJS.ErrnoException).code !== "ENOENT") throw targetError;
        await writeTextAtomic(target, contents, { telemetry: { root, storageClass: "durable" } });
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export function indexPath(root: string): string {
  return join(stateDir(root), "index.json");
}

export function indexManifestPath(root: string): string {
  return join(stateDir(root), ".index-manifest.json");
}

export function memoryPath(root: string): string {
  return join(stateDir(root), "memory.json");
}

export function configPath(root: string): string {
  return join(stateDir(root), "config.json");
}

export function rulesPath(root: string): string {
  return join(stateDir(root), "rules.json");
}

export function tokenEventsPath(root: string): string {
  return join(stateDir(root), "token-events.json");
}

export function benchmarkRunsPath(root: string): string {
  return join(stateDir(root), "benchmark-runs.json");
}

export function runsDir(root: string): string {
  return join(stateDir(root), "runs");
}

export function runPath(root: string, runId: string): string {
  return join(runsDir(root), `${runId}.json`);
}

export function wikiDir(root: string): string {
  return join(stateDir(root), "wiki");
}

export function wikiManifestPath(root: string): string {
  return join(wikiDir(root), "manifest.json");
}

export function vaultDir(root: string): string {
  return join(stateDir(root), "vault");
}

async function saveVaultProjectionUnlocked(root: string, notes: VaultNote[]): Promise<void> {
  const manifestPath = join(vaultDir(root), "manifest.json");
  let previous: Array<{ path: string }> = [];
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { notes?: Array<{ path?: unknown }> };
    previous = (parsed.notes ?? []).filter((note): note is { path: string } => typeof note.path === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const retained = new Set(notes.map((note) => note.path));
  await Promise.all(previous.filter((note) => !retained.has(note.path)).map(async (note) => rm(await resolveConfinedPath(root, join(".tokengraph", "vault", note.path)), { force: true })));
  for (const note of notes) await writeTextAtomicConfined(root, join(".tokengraph", "vault", note.path), note.body, { telemetry: { root, storageClass: "vault" } });
  await writeTextAtomicConfined(root, join(".tokengraph", "vault", "manifest.json"), `${JSON.stringify({ schemaVersion: 1, notes: notes.map(({ path, title, hash, backlinks, archived }) => ({ path, title, hash, backlinks, archived })) }, null, 2)}\n`, { telemetry: { root, storageClass: "vault" } });
}

export async function saveVaultProjection(root: string, notes: VaultNote[]): Promise<void> {
  const lock = await canonicalPersistenceLock(root, "vault", "manifest.json");
  await withFileLock(lock, () => saveVaultProjectionUnlocked(root, notes));
}

const INDEX_GENERATION_PATTERN = /^\.index-generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const INDEX_CANDIDATE_PATTERN = /^\.index-generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.candidate\.json$/;
const INDEX_MANIFEST_TEMP_PATTERN = /^\.index-manifest-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_RETRY_ATTEMPTS = 5;
const MANIFEST_RETRY_DELAY_MS = 12;
const MAX_INDEX_MANIFEST_BYTES = 4 * 1024;
const MAX_INDEX_GENERATION_BYTES = 256 * 1024 * 1024;

export interface ProjectIndexManifest {
  generationFile: string;
  generationId: string;
  contentHash: string;
}

export interface ProjectIndexPersistenceOptions {
  storageQuotas?: StorageClassQuotas;
}

export function indexGenerationPath(root: string, generationId: string): string {
  return join(stateDir(root), `.index-generation-${generationId}.json`);
}

export function isIndexGenerationArtifactName(name: string): boolean {
  return INDEX_GENERATION_PATTERN.test(name) || INDEX_CANDIDATE_PATTERN.test(name) || INDEX_MANIFEST_TEMP_PATTERN.test(name);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function sameRepositoryIdentity(left: ProjectIndex["repositoryIdentity"], right: ProjectIndex["repositoryIdentity"]): boolean {
  return Boolean(left && right &&
    left.repositoryId === right.repositoryId &&
    left.repositoryFingerprint === right.repositoryFingerprint &&
    left.workspaceId === right.workspaceId &&
    left.worktreeId === right.worktreeId &&
    left.branch === right.branch &&
    left.headCommit === right.headCommit &&
    left.remoteIdentity === right.remoteIdentity);
}

export function generationValidationFailure(
  root: string,
  index: ProjectIndex,
  currentIdentity: ProjectIndex["repositoryIdentity"]
): string | undefined {
  const generation = index.generation;
  if (!generation) return "generation metadata is missing";
  if (!INDEX_GENERATION_PATTERN.test(`.index-generation-${generation.id}.json`)) return "generation id is malformed";
  if (!isCanonicalIsoTimestamp(generation.createdAt) || generation.createdAt !== index.scannedAt) return "generation creation time is invalid";
  if (typeof index.scanSignature !== "string" || !SHA256_PATTERN.test(index.scanSignature) ||
      typeof generation.sourceScanSignature !== "string" || !SHA256_PATTERN.test(generation.sourceScanSignature)) {
    return "generation source scan signature is malformed";
  }
  if (generation.sourceScanSignature !== index.scanSignature) return "generation source scan signature does not match the index";
  if (!index.scanMetadata?.files || !Array.isArray(index.scanMetadata.exclusions)) return "scan metadata is missing";
  const metadataEntries = Object.entries(index.scanMetadata.files);
  if (metadataEntries.some(([path, metadata]) => path !== metadata.path || !isNormalizedRelativePath(path))) return "scan metadata paths are malformed";
  const indexedPaths = index.files.map((file) => file.path).sort();
  const metadataPaths = metadataEntries.map(([path]) => path).sort();
  if (new Set(indexedPaths).size !== indexedPaths.length || JSON.stringify(indexedPaths) !== JSON.stringify(metadataPaths)) {
    return "scan metadata and indexed file paths differ";
  }
  if (index.files.some((file) => index.scanMetadata?.files[file.path]?.contentHash !== file.contentHash)) {
    return "scan metadata and indexed content hashes differ";
  }
  const indexedPathSet = new Set(indexedPaths);
  const terminalPaths = new Set(index.exclusions.filter((entry) => !indexedPathSet.has(entry.path)).map((entry) => entry.path));
  const scannerTerminalExclusions = index.scanMetadata.exclusions
    .filter((entry) => !indexedPathSet.has(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  const indexedTerminalExclusions = index.exclusions
    .filter((entry) => !indexedPathSet.has(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  if (JSON.stringify(scannerTerminalExclusions) !== JSON.stringify(indexedTerminalExclusions)) {
    return "scanner terminal exclusions and indexed exclusions differ";
  }
  if (generation.intendedFileCount !== metadataPaths.length + terminalPaths.size) return "generation intended-file count is invalid";
  if (generation.terminalExclusionsHash !== sha256(JSON.stringify(scannerTerminalExclusions))) {
    return "generation terminal-exclusions hash is invalid";
  }
  if (generation.validatedContentSetHash !== validatedContentSetHash(index.scanMetadata, index.exclusions)) {
    return "generation content-set hash is invalid";
  }
  if (index.fingerprint !== projectIndexFingerprint(index)) return "index fingerprint is invalid";
  if (resolve(index.root) !== resolve(root)) return "index root does not match the requested workspace";
  if (!sameRepositoryIdentity(index.repositoryIdentity, currentIdentity)) return "repository identity changed before index promotion";
  return undefined;
}

async function assertValidGeneration(root: string, index: ProjectIndex): Promise<void> {
  const failure = generationValidationFailure(root, index, await getRepositoryIdentity(root));
  if (failure) throw new Error(`TokenGraph index generation validation failed: ${failure}.`);
}

interface StableFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly birthtimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function stableFileSnapshot(stats: BigIntStats): StableFileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    birthtimeNs: stats.birthtimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

function sameStableFile(left: StableFileSnapshot, right: StableFileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePublishedFile(left: StableFileSnapshot, right: StableFileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

export function parseManifest(value: unknown): ProjectIndexManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.keys(value);
  if (entries.length !== 3 || !entries.includes("generationFile") || !entries.includes("generationId") || !entries.includes("contentHash")) return undefined;
  const candidate = value as Partial<ProjectIndexManifest>;
  const match = typeof candidate.generationFile === "string" ? INDEX_GENERATION_PATTERN.exec(candidate.generationFile) : undefined;
  if (!match || basename(candidate.generationFile!) !== candidate.generationFile) return undefined;
  if (candidate.generationId !== match[1]) return undefined;
  if (typeof candidate.contentHash !== "string" || !SHA256_PATTERN.test(candidate.contentHash)) return undefined;
  return candidate as ProjectIndexManifest;
}

async function readRegularFileNoFollow(path: string, maximumBytes: number): Promise<string> {
  await assertNoSymbolicLinkComponents(path);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error(`Unsafe TokenGraph index file: ${path}`);
  if (before.size < 0n || before.size > BigInt(maximumBytes)) throw new Error("TokenGraph index file exceeds its bounded read limit.");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n ||
        !sameStableFile(stableFileSnapshot(before), stableFileSnapshot(after)) ||
        !sameStableFile(stableFileSnapshot(before), stableFileSnapshot(pathAfter))) {
      throw Object.assign(new Error(`TokenGraph index file changed while it was being read: ${path}`), {
        code: "UNSTABLE_INDEX_READ" as const
      });
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function flushDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Node does not expose portable directory fsync on Windows. The bounded
    // exception is documented in the Phase 5 directory-durability decision;
    // file contents are flushed and namespace replacement remains atomic.
    if (process.platform !== "win32" || !["EINVAL", "EPERM", "EACCES", "EBADF", "ENOTSUP"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeDurableExclusive(path: string, content: string): Promise<StableFileSnapshot> {
  const directory = dirname(path);
  await assertNoSymbolicLinkComponents(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkComponents(path);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  let opened: StableFileSnapshot;
  try {
    await handle.writeFile(content, "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n) throw new Error(`Unsafe TokenGraph index file after durable creation: ${path}`);
    opened = stableFileSnapshot(stats);
  } finally {
    await handle.close();
  }
  await flushDirectory(directory);
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameStableFile(opened!, stableFileSnapshot(after))) {
    throw new Error(`TokenGraph index file changed after durable creation: ${path}`);
  }
  return stableFileSnapshot(after);
}

function isTransientManifestReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function replaceManifestWithBoundedRetry(
  tempPath: string,
  manifestPath: string,
  temporaryIdentity: StableFileSnapshot,
  markNamespaceCommitted: () => void
): Promise<void> {
  for (let attempt = 0; attempt < MANIFEST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(tempPath, manifestPath);
      // The namespace commit is the irreversible boundary. Once rename has
      // succeeded, the generation may be reachable through the manifest even
      // if the durability flush or post-publication identity check fails. The
      // caller must retain that generation on every later failure path.
      markNamespaceCommitted();
      break;
    } catch (error) {
      if (!isTransientManifestReplaceError(error) || attempt === MANIFEST_RETRY_ATTEMPTS - 1) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  await flushDirectory(dirname(manifestPath));
  const published = await lstat(manifestPath, { bigint: true });
  if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n ||
      !samePublishedFile(temporaryIdentity, stableFileSnapshot(published))) {
    throw new Error("TokenGraph index manifest identity changed during publication.");
  }
}

async function removeWriterOwnedFile(path: string, expectedIdentity: StableFileSnapshot | undefined): Promise<void> {
  if (!expectedIdentity) return;
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
        !sameStableFile(expectedIdentity, stableFileSnapshot(info))) {
      throw new Error(`Refusing to remove replaced TokenGraph index artifact: ${path}`);
    }
    await rm(path);
    await flushDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unsafePublication(message: string): Error & { code: "UNSAFE_INDEX_PUBLICATION" } {
  return Object.assign(new Error(message), { code: "UNSAFE_INDEX_PUBLICATION" as const });
}

async function assertExistingPublicationSafe(root: string): Promise<void> {
  let manifestContent: string | undefined;
  try {
    manifestContent = await readRegularFileNoFollow(indexManifestPath(root), MAX_INDEX_MANIFEST_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (manifestContent !== undefined) {
    let manifest: ProjectIndexManifest | undefined;
    try {
      manifest = parseManifest(JSON.parse(manifestContent) as unknown);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!manifest) throw new Error("The active TokenGraph index manifest is malformed; refusing to replace it.");
    let generationContent: string;
    try {
      generationContent = await readRegularFileNoFollow(join(stateDir(root), manifest.generationFile), MAX_INDEX_GENERATION_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("The active TokenGraph index generation is missing; refusing to replace its manifest.");
      }
      throw error;
    }
    if (sha256(generationContent) !== manifest.contentHash) {
      throw new Error("The active TokenGraph index generation hash is invalid; refusing to replace its manifest.");
    }
    let generation: unknown;
    try {
      generation = JSON.parse(generationContent) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The active TokenGraph index generation is malformed; refusing to replace it.");
      throw error;
    }
    if (!isProjectIndex(generation) || generation.schemaVersion !== CURRENT_INDEX_SCHEMA_VERSION) {
      throw new Error("The active TokenGraph index generation schema is malformed; refusing to replace it.");
    }
    if (generation.generation?.id !== manifest.generationId || manifest.generationFile !== `.index-generation-${generation.generation.id}.json`) {
      throw new Error("The active TokenGraph index generation identity is inconsistent; refusing to replace its manifest.");
    }
    const currentIdentity = await getRepositoryIdentity(root);
    const failure = generationValidationFailure(root, generation, currentIdentity);
    if (failure) {
      throw new Error(`The active TokenGraph index generation is invalid (${failure}); refusing to replace its manifest.`);
    }
    return;
  }
  try {
    const legacy = JSON.parse(await readRegularFileNoFollow(indexPath(root), MAX_INDEX_GENERATION_BYTES)) as unknown;
    if (!isProjectIndex(legacy) || legacy.schemaVersion !== 4 || resolve(legacy.root) !== resolve(root) ||
        !legacy.repositoryIdentity || legacy.fingerprint !== projectIndexFingerprint(legacy)) {
      throw new Error("The legacy TokenGraph index publication is malformed; refusing to replace it.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof SyntaxError) throw new Error("The legacy TokenGraph index publication is malformed; refusing to replace it.");
    throw error;
  }
}

export async function readActiveIndexGenerationName(root: string): Promise<string | undefined> {
  try {
    const manifest = parseManifest(JSON.parse(await readRegularFileNoFollow(indexManifestPath(root), MAX_INDEX_MANIFEST_BYTES)) as unknown);
    if (!manifest) throw new Error("The active TokenGraph index manifest is malformed.");
    return manifest.generationFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveProjectIndex(root: string, index: ProjectIndex, options: ProjectIndexPersistenceOptions = {}): Promise<void> {
  if (typeof index.schemaVersion === "number" && index.schemaVersion > CURRENT_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported newer TokenGraph index schema version ${index.schemaVersion}; refusing to overwrite it.`);
  }
  if (index.schemaVersion !== CURRENT_INDEX_SCHEMA_VERSION) {
    throw new Error(`TokenGraph only promotes current schema-${CURRENT_INDEX_SCHEMA_VERSION} index generations.`);
  }
  if (!hasValidRetrievalSignals(index)) {
    throw new Error(`TokenGraph index schema ${CURRENT_INDEX_SCHEMA_VERSION} has malformed retrieval signals; refusing to persist it.`);
  }
  const worktreeLock = await canonicalPersistenceLock(root, "workspace-state", ".index-manifest.json");
  await withFileLock(worktreeLock, async () => {
    await assertExistingPublicationSafe(root);
    await assertValidGeneration(root, index);
    const serializedGeneration = `${JSON.stringify(index, null, 2)}\n`;
    const contentHash = sha256(serializedGeneration);
    const generationPath = indexGenerationPath(root, index.generation!.id);
    const manifestPath = indexManifestPath(root);
    const manifest: ProjectIndexManifest = {
      generationFile: basename(generationPath),
      generationId: index.generation!.id,
      contentHash
    };
    const serializedManifest = `${JSON.stringify(manifest)}\n`;
    if (options.storageQuotas) {
      const { assertIndexGenerationWriteAllowed } = await import("./storagePolicy.js");
      await assertIndexGenerationWriteAllowed(
        root,
        Buffer.byteLength(serializedGeneration, "utf8"),
        Buffer.byteLength(serializedManifest, "utf8"),
        options.storageQuotas
      );
    }
    const manifestTempPath = join(stateDir(root), `.index-manifest-${randomUUID()}.tmp`);
    let namespaceCommitted = false;
    let generationIdentity: StableFileSnapshot | undefined;
    let manifestTemporaryIdentity: StableFileSnapshot | undefined;
    let operationFailed = false;
    let operationFailure: unknown;
    try {
      // Index snapshots are derived caches and remain worktree-scoped.
      generationIdentity = await writeDurableExclusive(generationPath, serializedGeneration);
      const rereadGeneration = await readRegularFileNoFollow(generationPath, MAX_INDEX_GENERATION_BYTES);
      const parsedGeneration = JSON.parse(rereadGeneration) as unknown;
      if (!isProjectIndex(parsedGeneration) || parsedGeneration.schemaVersion !== CURRENT_INDEX_SCHEMA_VERSION) {
        throw new Error("TokenGraph index generation validation failed: generation schema is malformed.");
      }
      await assertValidGeneration(root, parsedGeneration);
      if (sha256(rereadGeneration) !== contentHash) {
        throw new Error("TokenGraph index generation hash changed before publication.");
      }
      manifestTemporaryIdentity = await writeDurableExclusive(manifestTempPath, serializedManifest);
      const rereadManifest = parseManifest(JSON.parse(await readRegularFileNoFollow(manifestTempPath, MAX_INDEX_MANIFEST_BYTES)) as unknown);
      if (!rereadManifest || rereadManifest.contentHash !== contentHash || rereadManifest.generationId !== index.generation!.id) {
        throw new Error("TokenGraph index manifest validation failed before publication.");
      }
      await replaceManifestWithBoundedRetry(
        manifestTempPath,
        manifestPath,
        manifestTemporaryIdentity,
        () => { namespaceCommitted = true; }
      );
      observeSuccessfulWrite(
        { root, storageClass: "cache" },
        Buffer.byteLength(serializedGeneration, "utf8") + Buffer.byteLength(serializedManifest, "utf8")
      );
    } catch (error) {
      operationFailed = true;
      operationFailure = error;
    }
    const cleanupFailures: unknown[] = [];
    try {
      await removeWriterOwnedFile(manifestTempPath, manifestTemporaryIdentity);
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (!namespaceCommitted) {
      try {
        await removeWriterOwnedFile(generationPath, generationIdentity);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (operationFailed) {
      if (cleanupFailures.length) {
        throw new AggregateError([operationFailure, ...cleanupFailures], "TokenGraph index promotion and cleanup both failed.");
      }
      throw operationFailure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "TokenGraph index promotion cleanup failed.");
    }
  });
}

function isNormalizedRelativePath(path: string): boolean {
  return path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasValidRetrievalSignals(index: Partial<ProjectIndex>): boolean {
  const signals = index.retrievalSignals;
  if (!signals || (signals.source !== "git-commit-distance" && signals.source !== "unavailable")) return false;
  if (!Number.isInteger(signals.historyDepth) || signals.historyDepth < 1 || signals.historyDepth > 50) return false;
  if (!signals.fileCommitDistance || typeof signals.fileCommitDistance !== "object" || Array.isArray(signals.fileCommitDistance)) return false;
  const entries = Object.entries(signals.fileCommitDistance);
  const indexedPaths = new Set(index.files?.map((file) => file.path) ?? []);
  if (signals.source === "unavailable" && entries.length > 0) return false;
  if (entries.some(([path, distance]) =>
    !isNormalizedRelativePath(path) ||
    !indexedPaths.has(path) ||
    !Number.isInteger(distance) ||
    distance < 0 ||
    distance >= signals.historyDepth
  )) return false;
  return entries.every(([path], index) => index === 0 || entries[index - 1]![0].localeCompare(path) < 0);
}

export function isProjectIndex(value: unknown): value is ProjectIndex {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProjectIndex>;
  if (typeof candidate.schemaVersion === "number" && candidate.schemaVersion > CURRENT_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported newer TokenGraph index schema version ${candidate.schemaVersion}; refusing to overwrite it.`);
  }
  return (
    (candidate.schemaVersion === 4 || candidate.schemaVersion === CURRENT_INDEX_SCHEMA_VERSION) &&
    typeof candidate.root === "string" &&
    typeof candidate.scannedAt === "string" &&
    typeof candidate.fingerprint === "string" &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.symbols) &&
    Array.isArray(candidate.imports) &&
    Array.isArray(candidate.exclusions) &&
    Array.isArray(candidate.frameworks) &&
    Boolean(candidate.sql) &&
    Array.isArray(candidate.sql?.tables) &&
    Array.isArray(candidate.sql?.relations) &&
    Array.isArray(candidate.sql?.policies) &&
    Array.isArray(candidate.sql?.indexes) &&
    Array.isArray(candidate.sql?.triggers) &&
    Array.isArray(candidate.sql?.functions) &&
    Array.isArray(candidate.sql?.views) &&
    Array.isArray(candidate.sql?.constraints) &&
    Array.isArray(candidate.sql?.enums) &&
    Array.isArray(candidate.sql?.extensions) &&
    Array.isArray(candidate.sql?.grants) &&
    Array.isArray(candidate.sql?.materializedViews) &&
    Array.isArray(candidate.sql?.history) &&
    hasValidRetrievalSignals(candidate) &&
    (candidate.schemaVersion === 4 || Boolean(
      candidate.generation &&
      typeof candidate.scanSignature === "string" &&
      SHA256_PATTERN.test(candidate.scanSignature) &&
      typeof candidate.generation.sourceScanSignature === "string" &&
      SHA256_PATTERN.test(candidate.generation.sourceScanSignature) &&
      typeof candidate.generation.terminalExclusionsHash === "string" &&
      SHA256_PATTERN.test(candidate.generation.terminalExclusionsHash) &&
      candidate.scanMetadata?.files &&
      Array.isArray(candidate.scanMetadata.exclusions)
    ))
  );
}

async function loadManifestProjectIndex(root: string, currentIdentity: ProjectIndex["repositoryIdentity"]): Promise<{ manifestPresent: boolean; index?: ProjectIndex }> {
  let manifestObserved = false;
  for (let attempt = 0; attempt < MANIFEST_RETRY_ATTEMPTS; attempt += 1) {
    let readingManifest = true;
    try {
      const manifestContent = await readRegularFileNoFollow(indexManifestPath(root), MAX_INDEX_MANIFEST_BYTES);
      manifestObserved = true;
      const manifest = parseManifest(JSON.parse(manifestContent) as unknown);
      if (!manifest) throw unsafePublication("The active TokenGraph index manifest is unsafe.");
      readingManifest = false;
      const generationContent = await readRegularFileNoFollow(join(stateDir(root), manifest.generationFile), MAX_INDEX_GENERATION_BYTES);
      if (sha256(generationContent) !== manifest.contentHash) {
        throw unsafePublication("The active TokenGraph index generation failed integrity validation.");
      }
      const parsed = JSON.parse(generationContent) as unknown;
      if (!isProjectIndex(parsed) || parsed.schemaVersion !== CURRENT_INDEX_SCHEMA_VERSION) {
        throw unsafePublication("The active TokenGraph index generation has an unsafe schema.");
      }
      if (parsed.generation?.id !== manifest.generationId || basename(manifest.generationFile) !== `.index-generation-${parsed.generation.id}.json`) {
        throw unsafePublication("The active TokenGraph index generation identity is inconsistent.");
      }
      const validationFailure = generationValidationFailure(root, parsed, currentIdentity);
      if (validationFailure) throw unsafePublication(`The active TokenGraph index generation is unsafe: ${validationFailure}.`);
      return { manifestPresent: true, index: parsed };
    } catch (error) {
      if (readingManifest && (error as NodeJS.ErrnoException).code === "UNSTABLE_INDEX_READ") {
        manifestObserved = true;
        if (attempt < MANIFEST_RETRY_ATTEMPTS - 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw unsafePublication("The active TokenGraph index manifest remained unstable during bounded resolution.");
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!manifestObserved) return { manifestPresent: false };
        if (attempt < MANIFEST_RETRY_ATTEMPTS - 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw unsafePublication("The active TokenGraph index generation disappeared during bounded resolution.");
      }
      if (error instanceof SyntaxError) throw unsafePublication("The active TokenGraph index publication is malformed.");
      throw error;
    }
  }
  return { manifestPresent: manifestObserved };
}

export async function loadProjectIndex(root: string): Promise<ProjectIndex | undefined> {
  const currentIdentity = await getRepositoryIdentity(root);
  const published = await loadManifestProjectIndex(root, currentIdentity);
  if (published.manifestPresent) return published.index;
  const paths = [indexPath(root), await repositoryIndexPath(root)];
  for (const path of paths.filter((candidate, index, all) => all.indexOf(candidate) === index)) {
    try {
      const parsed = JSON.parse(await readRegularFileNoFollow(path, MAX_INDEX_GENERATION_BYTES)) as unknown;
      if (isProjectIndex(parsed) && parsed.schemaVersion === 4) {
        if (resolve(parsed.root) !== resolve(root)) continue;
        const storedIdentity = parsed.repositoryIdentity;
        if (!storedIdentity || !sameRepositoryIdentity(storedIdentity, currentIdentity)) continue;
        if (parsed.fingerprint !== projectIndexFingerprint(parsed)) continue;
        return parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        // Quarantine mutates project state: only after activation and while
        // owning the domain that holds the corrupt snapshot. An unactivated
        // pure read continues without touching the filesystem.
        if (getLegacyRuntimeActivationStatus().activated) {
          const domain = path === indexPath(root) ? "workspace-state" : "repository-state";
          const relativeName = path === indexPath(root) ? "index.json" : "repository-index.json";
          const lock = await canonicalPersistenceLock(root, domain, relativeName);
          await withFileLock(lock, () => quarantineCorruptJson(path));
        }
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

interface WikiManifestPage {
  slug: string;
  title: string;
  estimatedTokens: number;
  file: string;
  sourceFingerprints?: string[];
  backlinks?: string[];
  contradictions?: string[];
  freshness?: "fresh" | "stale";
}

interface WikiManifest {
  schemaVersion: number;
  fingerprint: string;
  generatedAt: string;
  pages: WikiManifestPage[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWikiManifest(value: unknown): value is WikiManifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WikiManifest>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.generatedAt === "string" &&
    Array.isArray(candidate.pages) &&
    candidate.pages.every(
      (page) =>
        page &&
        typeof page === "object" &&
        typeof (page as Partial<WikiManifestPage>).slug === "string" &&
        SAFE_WIKI_SLUG_PATTERN.test((page as Partial<WikiManifestPage>).slug!) &&
        typeof (page as Partial<WikiManifestPage>).title === "string" &&
        typeof (page as Partial<WikiManifestPage>).estimatedTokens === "number" &&
        typeof (page as Partial<WikiManifestPage>).file === "string" &&
        ((page as Partial<WikiManifestPage>).sourceFingerprints === undefined || isStringArray((page as Partial<WikiManifestPage>).sourceFingerprints)) &&
        ((page as Partial<WikiManifestPage>).backlinks === undefined || isStringArray((page as Partial<WikiManifestPage>).backlinks)) &&
        ((page as Partial<WikiManifestPage>).contradictions === undefined || isStringArray((page as Partial<WikiManifestPage>).contradictions)) &&
        ((page as Partial<WikiManifestPage>).freshness === undefined || ["fresh", "stale"].includes((page as Partial<WikiManifestPage>).freshness!))
    )
  );
}

function isSafeWikiPageFile(root: string, file: string): boolean {
  if (!file || isAbsolute(file) || file.startsWith("../") || file.startsWith("..\\")) {
    return false;
  }
  const directory = resolve(wikiDir(root));
  const resolved = resolve(directory, file);
  const relativePath = relative(directory, resolved);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

async function saveProjectWikiUnlocked(root: string, wiki: ProjectWiki): Promise<void> {
  if (wiki.pages.some((page) => !SAFE_WIKI_SLUG_PATTERN.test(page.slug))) {
    throw new Error("Wiki page slugs must be safe relative logical identifiers.");
  }
  const previous = await loadProjectWiki(root);
  const pages = wiki.pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    estimatedTokens: page.estimatedTokens,
    file: `${page.slug}.md`,
    ...(page.sourceFingerprints === undefined ? {} : { sourceFingerprints: page.sourceFingerprints }),
    ...(page.backlinks === undefined ? {} : { backlinks: page.backlinks }),
    ...(page.contradictions === undefined ? {} : { contradictions: page.contradictions }),
    ...(page.freshness === undefined ? {} : { freshness: page.freshness })
  }));
  for (const wikiPage of wiki.pages) {
    const relativeFile = join(".tokengraph", "wiki", `${wikiPage.slug}.md`);
    const path = await resolveConfinedPath(root, relativeFile, true);
    let existing: string | undefined;
    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing !== wikiPage.body) await writeTextAtomic(path, wikiPage.body, { telemetry: { root, storageClass: "cache" } });
  }
  const retained = new Set(pages.map((page) => page.file));
  await Promise.all((previous?.pages ?? [])
    .filter((page) => !retained.has(`${page.slug}.md`))
    .map(async (page) => rm(await resolveConfinedPath(root, join(".tokengraph", "wiki", `${page.slug}.md`)), { force: true })));
  const manifest: WikiManifest = {
    schemaVersion: wiki.schemaVersion,
    fingerprint: wiki.fingerprint,
    generatedAt: new Date().toISOString(),
    pages
  };
  await writeTextAtomicConfined(root, join(".tokengraph", "wiki", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { telemetry: { root, storageClass: "cache" } });
}

export async function saveProjectWiki(root: string, wiki: ProjectWiki): Promise<void> {
  const lock = await canonicalPersistenceLock(root, "wiki", "manifest.json");
  await withFileLock(lock, () => saveProjectWikiUnlocked(root, wiki));
}

export async function loadProjectWiki(root: string): Promise<ProjectWiki | undefined> {
  try {
    const manifest = JSON.parse(await readFile(await resolveConfinedPath(root, join(".tokengraph", "wiki", "manifest.json")), "utf8")) as unknown;
    if (!isWikiManifest(manifest) || !manifest.pages.every((page) => isSafeWikiPageFile(root, page.file))) {
      return undefined;
    }
    const pages: WikiPage[] = [];
    for (const manifestPage of manifest.pages) {
      pages.push({
        slug: manifestPage.slug,
        title: manifestPage.title,
        estimatedTokens: manifestPage.estimatedTokens,
        body: await readFile(await resolveConfinedPath(root, join(".tokengraph", "wiki", manifestPage.file)), "utf8"),
        ...(manifestPage.sourceFingerprints === undefined ? {} : { sourceFingerprints: manifestPage.sourceFingerprints }),
        ...(manifestPage.backlinks === undefined ? {} : { backlinks: manifestPage.backlinks }),
        ...(manifestPage.contradictions === undefined ? {} : { contradictions: manifestPage.contradictions }),
        ...(manifestPage.freshness === undefined ? {} : { freshness: manifestPage.freshness })
      });
    }
    return {
      schemaVersion: manifest.schemaVersion,
      fingerprint: manifest.fingerprint,
      pages
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      // Quarantine mutates project state: only after activation and while owning
      // the wiki domain. An unactivated pure read returns undefined.
      if (getLegacyRuntimeActivationStatus().activated) {
        const lock = await canonicalPersistenceLock(root, "wiki", "manifest.json");
        await withFileLock(lock, () => quarantineCorruptJson(wikiManifestPath(root)));
      }
      return undefined;
    }
    throw error;
  }
}

export async function clearProjectWiki(root: string, confirmation: DestructiveMaintenanceConfirmation): Promise<void> {
  await withDestructiveMaintenance(root, ["wiki"], confirmation, async (context) => {
    await context.remove([{ domain: "wiki" }]);
  });
}

export async function getWikiStatus(root: string): Promise<{
  root: string;
  state: "missing" | "fresh" | "stale";
  hasWiki: boolean;
  wikiFingerprint?: string;
  indexFingerprint?: string;
}> {
  const wiki = await loadProjectWiki(root);
  if (!wiki) {
    return { root, state: "missing", hasWiki: false };
  }
  const index = await loadProjectIndex(root);
  const indexFingerprint = index?.fingerprint;
  return {
    root,
    state: indexFingerprint && indexFingerprint === wiki.fingerprint ? "fresh" : "stale",
    hasWiki: true,
    wikiFingerprint: wiki.fingerprint,
    indexFingerprint
  };
}

export async function clearProjectIndex(root: string, confirmation: DestructiveMaintenanceConfirmation): Promise<void> {
  await withDestructiveMaintenance(root, ["workspace-state", "repository-state", "wiki"], confirmation, async (context) => {
    const stateEntries = await readdir(stateDir(root)).catch((error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error)
    );
    await context.remove([
      { domain: "workspace-state", relativePath: "index.json" },
      { domain: "workspace-state", relativePath: ".index-manifest.json" },
      ...stateEntries.filter(isIndexGenerationArtifactName).map((entry) => ({ domain: "workspace-state" as const, relativePath: entry })),
      { domain: "repository-state", relativePath: "index.json" },
      { domain: "wiki" }
    ]);
  });
}

export async function clearProjectState(root: string, confirmation: DestructiveMaintenanceConfirmation): Promise<void> {
  const domains = ["workspace-state", "repository-state", "runs", "tasks", "vault", "wiki", "artifacts"] as const;
  await withDestructiveMaintenance(root, domains, confirmation, async (context) => {
    await context.remove(domains.map((domain) => ({ domain })));
  });
}
