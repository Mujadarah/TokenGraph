import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectIndex } from "./types.js";

export function stateDir(root: string): string {
  return join(root, ".tokengraph");
}

export function indexPath(root: string): string {
  return join(stateDir(root), "index.json");
}

export function memoryPath(root: string): string {
  return join(stateDir(root), "memory.json");
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
    Array.isArray(candidate.sql?.views)
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

export async function clearProjectIndex(root: string): Promise<void> {
  await rm(indexPath(root), { force: true });
}

export async function clearProjectState(root: string): Promise<void> {
  await rm(stateDir(root), { recursive: true, force: true });
}
