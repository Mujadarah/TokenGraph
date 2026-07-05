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

export async function loadProjectIndex(root: string): Promise<ProjectIndex | undefined> {
  try {
    return JSON.parse(await readFile(indexPath(root), "utf8")) as ProjectIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
