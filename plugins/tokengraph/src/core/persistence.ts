import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalPersistenceLock } from "./lockDomain.js";
import { getLegacyRuntimeActivationStatus } from "./legacyRuntimeActivation.js";
import { CURRENT_INDEX_SCHEMA_VERSION, projectIndexFingerprint, validatedContentSetHash } from "./projectIndexer.js";
import { assertNoSymbolicLinkComponents, quarantineCorruptJson, resolveConfinedPath, withDestructiveMaintenance, withFileLock, writeTextAtomic, writeTextAtomicConfined, SAFE_WIKI_SLUG_PATTERN, type DestructiveMaintenanceConfirmation } from "./storage.js";
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
        await writeTextAtomic(target, contents);
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
  for (const note of notes) await writeTextAtomicConfined(root, join(".tokengraph", "vault", note.path), note.body);
  await writeTextAtomicConfined(root, join(".tokengraph", "vault", "manifest.json"), `${JSON.stringify({ schemaVersion: 1, notes: notes.map(({ path, title, hash, backlinks, archived }) => ({ path, title, hash, backlinks, archived })) }, null, 2)}\n`);
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

function generationValidationFailure(
  root: string,
  index: ProjectIndex,
  currentIdentity: ProjectIndex["repositoryIdentity"]
): string | undefined {
  const generation = index.generation;
  if (!generation) return "generation metadata is missing";
  if (!INDEX_GENERATION_PATTERN.test(`.index-generation-${generation.id}.json`)) return "generation id is malformed";
  if (!isCanonicalIsoTimestamp(generation.createdAt) || generation.createdAt !== index.scannedAt) return "generation creation time is invalid";
  if (generation.sourceScanSignature !== index.scanSignature) return "generation source scan signature does not match the index";
  if (!index.scanMetadata?.files) return "scan metadata is missing";
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
  if (generation.intendedFileCount !== metadataPaths.length + terminalPaths.size) return "generation intended-file count is invalid";
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

function parseManifest(value: unknown): ProjectIndexManifest | undefined {
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

async function readRegularFileNoFollow(path: string): Promise<string> {
  await assertNoSymbolicLinkComponents(path);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error(`Unsafe TokenGraph index file: ${path}`);
  const handle = await open(path, "r");
  try {
    const content = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error(`TokenGraph index file changed while it was being read: ${path}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function writeDurableExclusive(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await assertNoSymbolicLinkComponents(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkComponents(path);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isTransientManifestReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function replaceManifestWithBoundedRetry(tempPath: string, manifestPath: string): Promise<void> {
  for (let attempt = 0; attempt < MANIFEST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(tempPath, manifestPath);
      return;
    } catch (error) {
      if (!isTransientManifestReplaceError(error) || attempt === MANIFEST_RETRY_ATTEMPTS - 1) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

async function removeWriterOwnedFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to remove unsafe TokenGraph index artifact: ${path}`);
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertNoFuturePublication(root: string): Promise<void> {
  let manifestContent: string | undefined;
  try {
    manifestContent = await readRegularFileNoFollow(indexManifestPath(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (manifestContent !== undefined) {
    const manifest = parseManifest(JSON.parse(manifestContent) as unknown);
    if (!manifest) throw new Error("The active TokenGraph index manifest is malformed; refusing to replace it.");
    let generationContent: string;
    try {
      generationContent = await readRegularFileNoFollow(join(stateDir(root), manifest.generationFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("The active TokenGraph index generation is missing; refusing to replace its manifest.");
      }
      throw error;
    }
    if (sha256(generationContent) !== manifest.contentHash) {
      throw new Error("The active TokenGraph index generation hash is invalid; refusing to replace its manifest.");
    }
    const generation = JSON.parse(generationContent) as { schemaVersion?: unknown };
    if (typeof generation.schemaVersion === "number" && generation.schemaVersion > CURRENT_INDEX_SCHEMA_VERSION) {
      throw new Error(`Unsupported newer TokenGraph index schema version ${generation.schemaVersion}; refusing to overwrite it.`);
    }
    return;
  }
  try {
    const legacy = JSON.parse(await readRegularFileNoFollow(indexPath(root))) as { schemaVersion?: unknown };
    if (typeof legacy.schemaVersion === "number" && legacy.schemaVersion > CURRENT_INDEX_SCHEMA_VERSION) {
      throw new Error(`Unsupported newer TokenGraph index schema version ${legacy.schemaVersion}; refusing to overwrite it.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

export async function readActiveIndexGenerationName(root: string): Promise<string | undefined> {
  try {
    const manifest = parseManifest(JSON.parse(await readRegularFileNoFollow(indexManifestPath(root))) as unknown);
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
    await assertNoFuturePublication(root);
    await assertValidGeneration(root, index);
    const serializedGeneration = `${JSON.stringify(index, null, 2)}\n`;
    if (options.storageQuotas) {
      const { assertIndexGenerationWriteAllowed } = await import("./storagePolicy.js");
      await assertIndexGenerationWriteAllowed(root, Buffer.byteLength(serializedGeneration, "utf8"), options.storageQuotas);
    }
    const generationPath = indexGenerationPath(root, index.generation!.id);
    const manifestPath = indexManifestPath(root);
    const manifestTempPath = join(stateDir(root), `.index-manifest-${randomUUID()}.tmp`);
    let published = false;
    try {
      // Index snapshots are derived caches and remain worktree-scoped.
      await writeDurableExclusive(generationPath, serializedGeneration);
      const rereadGeneration = await readRegularFileNoFollow(generationPath);
      const parsedGeneration = JSON.parse(rereadGeneration) as unknown;
      if (!isProjectIndex(parsedGeneration) || parsedGeneration.schemaVersion !== CURRENT_INDEX_SCHEMA_VERSION) {
        throw new Error("TokenGraph index generation validation failed: generation schema is malformed.");
      }
      await assertValidGeneration(root, parsedGeneration);
      const contentHash = sha256(rereadGeneration);
      const manifest: ProjectIndexManifest = {
        generationFile: basename(generationPath),
        generationId: index.generation!.id,
        contentHash
      };
      const serializedManifest = `${JSON.stringify(manifest)}\n`;
      await writeDurableExclusive(manifestTempPath, serializedManifest);
      const rereadManifest = parseManifest(JSON.parse(await readRegularFileNoFollow(manifestTempPath)) as unknown);
      if (!rereadManifest || rereadManifest.contentHash !== contentHash || rereadManifest.generationId !== index.generation!.id) {
        throw new Error("TokenGraph index manifest validation failed before publication.");
      }
      await replaceManifestWithBoundedRetry(manifestTempPath, manifestPath);
      published = true;
    } finally {
      await removeWriterOwnedFile(manifestTempPath);
      if (!published) await removeWriterOwnedFile(generationPath);
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

function isProjectIndex(value: unknown): value is ProjectIndex {
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
    (candidate.schemaVersion === 4 || Boolean(candidate.generation && candidate.scanMetadata?.files))
  );
}

async function loadManifestProjectIndex(root: string, currentIdentity: ProjectIndex["repositoryIdentity"]): Promise<{ manifestPresent: boolean; index?: ProjectIndex }> {
  let manifestObserved = false;
  for (let attempt = 0; attempt < MANIFEST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const manifestContent = await readRegularFileNoFollow(indexManifestPath(root));
      manifestObserved = true;
      const manifest = parseManifest(JSON.parse(manifestContent) as unknown);
      if (!manifest) return { manifestPresent: true };
      const generationContent = await readRegularFileNoFollow(join(stateDir(root), manifest.generationFile));
      if (sha256(generationContent) !== manifest.contentHash) {
        if (attempt < MANIFEST_RETRY_ATTEMPTS - 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        return { manifestPresent: true };
      }
      const parsed = JSON.parse(generationContent) as unknown;
      if (!isProjectIndex(parsed) || parsed.schemaVersion !== CURRENT_INDEX_SCHEMA_VERSION) return { manifestPresent: true };
      if (parsed.generation?.id !== manifest.generationId || basename(manifest.generationFile) !== `.index-generation-${parsed.generation.id}.json`) {
        return { manifestPresent: true };
      }
      if (generationValidationFailure(root, parsed, currentIdentity)) return { manifestPresent: true };
      return { manifestPresent: true, index: parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!manifestObserved) return { manifestPresent: false };
        if (attempt < MANIFEST_RETRY_ATTEMPTS - 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        return { manifestPresent: true };
      }
      if (error instanceof SyntaxError) return { manifestPresent: true };
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
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isProjectIndex(parsed) && parsed.schemaVersion === 4) {
        if (resolve(parsed.root) !== resolve(root)) continue;
        const storedIdentity = parsed.repositoryIdentity;
        if (storedIdentity && (
          storedIdentity.repositoryId !== currentIdentity.repositoryId ||
          storedIdentity.repositoryFingerprint !== currentIdentity.repositoryFingerprint ||
          storedIdentity.worktreeId !== currentIdentity.worktreeId ||
          storedIdentity.branch !== currentIdentity.branch ||
          storedIdentity.headCommit !== currentIdentity.headCommit
        )) continue;
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
    if (existing !== wikiPage.body) await writeTextAtomic(path, wikiPage.body);
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
  await writeTextAtomicConfined(root, join(".tokengraph", "wiki", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
