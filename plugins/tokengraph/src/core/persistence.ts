import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { canonicalPersistenceLockKey, quarantineCorruptJson, resolveConfinedPath, withFileLock, writeJsonAtomic, writeTextAtomic, writeTextAtomicConfined, SAFE_WIKI_SLUG_PATTERN } from "./storage.js";
import type { ProjectIndex, ProjectWiki, WikiPage } from "./types.js";

export function stateDir(root: string): string {
  return join(root, ".tokengraph");
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

export function wikiDir(root: string): string {
  return join(stateDir(root), "wiki");
}

export function wikiManifestPath(root: string): string {
  return join(wikiDir(root), "manifest.json");
}

export async function saveProjectIndex(root: string, index: ProjectIndex): Promise<void> {
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "index.json");
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(indexPath(root), index));
}

function isProjectIndex(value: unknown): value is ProjectIndex {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProjectIndex>;
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
  try {
    const parsed = JSON.parse(await readFile(indexPath(root), "utf8")) as unknown;
    return isProjectIndex(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(indexPath(root));
      return undefined;
    }
    throw error;
  }
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

export async function saveProjectWiki(root: string, wiki: ProjectWiki): Promise<void> {
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
  await clearProjectWiki(root);
}

export async function clearProjectState(root: string): Promise<void> {
  await rm(stateDir(root), { recursive: true, force: true });
}
