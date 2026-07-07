import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

export function wikiDir(root: string): string {
  return join(stateDir(root), "wiki");
}

export function wikiManifestPath(root: string): string {
  return join(wikiDir(root), "manifest.json");
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function saveProjectIndex(root: string, index: ProjectIndex): Promise<void> {
  await mkdir(stateDir(root), { recursive: true });
  await writeFile(indexPath(root), `${JSON.stringify(index, null, 2)}\n`);
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
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
}

interface WikiManifest {
  schemaVersion: number;
  fingerprint: string;
  generatedAt: string;
  pages: WikiManifestPage[];
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
        typeof (page as Partial<WikiManifestPage>).title === "string" &&
        typeof (page as Partial<WikiManifestPage>).estimatedTokens === "number" &&
        typeof (page as Partial<WikiManifestPage>).file === "string"
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
  await mkdir(wikiDir(root), { recursive: true });
  const pages = wiki.pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    estimatedTokens: page.estimatedTokens,
    file: `${page.slug}.md`
  }));
  for (const wikiPage of wiki.pages) {
    await writeAtomic(join(wikiDir(root), `${wikiPage.slug}.md`), wikiPage.body);
  }
  const manifest: WikiManifest = {
    schemaVersion: wiki.schemaVersion,
    fingerprint: wiki.fingerprint,
    generatedAt: new Date().toISOString(),
    pages
  };
  await writeAtomic(wikiManifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function loadProjectWiki(root: string): Promise<ProjectWiki | undefined> {
  try {
    const manifest = JSON.parse(await readFile(wikiManifestPath(root), "utf8")) as unknown;
    if (!isWikiManifest(manifest) || !manifest.pages.every((page) => isSafeWikiPageFile(root, page.file))) {
      return undefined;
    }
    const pages: WikiPage[] = [];
    for (const manifestPage of manifest.pages) {
      pages.push({
        slug: manifestPage.slug,
        title: manifestPage.title,
        estimatedTokens: manifestPage.estimatedTokens,
        body: await readFile(join(wikiDir(root), manifestPage.file), "utf8")
      });
    }
    return {
      schemaVersion: manifest.schemaVersion,
      fingerprint: manifest.fingerprint,
      pages
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
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
