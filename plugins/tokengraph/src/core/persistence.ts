import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { canonicalPersistenceLockKey, quarantineCorruptJson, resolveConfinedPath, withFileLock, writeJsonAtomic, writeTextAtomic, writeTextAtomicConfined, SAFE_WIKI_SLUG_PATTERN } from "./storage.js";
import { getRepositoryIdentity, resolveRepositoryStateDirectory } from "./repositoryIdentity.js";
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
  const legacy = join(stateDir(root), fileName);
  try {
    const contents = await readFile(legacy, "utf8");
    const key = await canonicalPersistenceLockKey(directory, fileName);
    await withFileLock(`${key}.lock`, async () => {
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
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "vault", "manifest.json");
  await withFileLock(`${key}.lock`, () => saveVaultProjectionUnlocked(root, notes));
}

export async function saveProjectIndex(root: string, index: ProjectIndex): Promise<void> {
  if (typeof index.schemaVersion === "number" && index.schemaVersion > 3) {
    throw new Error(`Unsupported newer TokenGraph index schema version ${index.schemaVersion}; refusing to overwrite it.`);
  }
  const worktreePath = indexPath(root);
  const worktreeKey = await canonicalPersistenceLockKey(worktreePath);
  await withFileLock(`${worktreeKey}.lock`, async () => {
    // Index snapshots are derived caches and remain worktree-scoped. Repository
    // knowledge uses the git-common store, but branch/HEAD snapshots must not.
    await writeJsonAtomic(worktreePath, index);
  });
}

function isProjectIndex(value: unknown): value is ProjectIndex {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProjectIndex>;
  if (typeof candidate.schemaVersion === "number" && candidate.schemaVersion > 3) {
    throw new Error(`Unsupported newer TokenGraph index schema version ${candidate.schemaVersion}; refusing to overwrite it.`);
  }
  return (
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
    Array.isArray(candidate.sql?.history)
  );
}

export async function loadProjectIndex(root: string): Promise<ProjectIndex | undefined> {
  const paths = [indexPath(root), await repositoryIndexPath(root)];
  const currentIdentity = await getRepositoryIdentity(root);
  for (const path of paths.filter((candidate, index, all) => all.indexOf(candidate) === index)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isProjectIndex(parsed)) {
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
        await quarantineCorruptJson(path);
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
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "wiki", "manifest.json");
  await withFileLock(`${key}.lock`, () => saveProjectWikiUnlocked(root, wiki));
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
      await quarantineCorruptJson(wikiManifestPath(root));
      return undefined;
    }
    throw error;
  }
}

export async function clearProjectWiki(root: string): Promise<void> {
  await rm(wikiDir(root), { recursive: true, force: true });
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

export async function clearProjectIndex(root: string): Promise<void> {
  await rm(indexPath(root), { force: true });
  await rm(await repositoryIndexPath(root), { force: true });
  await clearProjectWiki(root);
}

export async function clearProjectState(root: string): Promise<void> {
  await rm(stateDir(root), { recursive: true, force: true });
}
