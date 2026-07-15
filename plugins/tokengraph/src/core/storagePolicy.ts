import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { resolveRepositoryStateDirectory } from "./repositoryIdentity.js";
import { stateDir } from "./persistence.js";

export interface StorageQuota {
  maxBytes: number;
  maxFiles?: number;
}

export interface StorageUsage {
  bytes: number;
  files: number;
}

async function usage(path: string): Promise<StorageUsage> {
  try {
    const info = await stat(path);
    if (info.isFile()) return { bytes: info.size, files: 1 };
    if (!info.isDirectory()) return { bytes: 0, files: 0 };
    const entries = await readdir(path);
    const children = await Promise.all(entries.map((entry) => usage(join(path, entry))));
    return children.reduce((total, child) => ({ bytes: total.bytes + child.bytes, files: total.files + child.files }), { bytes: 0, files: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, files: 0 };
    throw error;
  }
}

export async function storageUsage(root: string): Promise<StorageUsage> {
  const [worktree, repository] = await Promise.all([usage(stateDir(root)), usage(await resolveRepositoryStateDirectory(root))]);
  return { bytes: worktree.bytes + repository.bytes, files: worktree.files + repository.files };
}

export async function enforceStorageQuota(root: string, quota: StorageQuota): Promise<StorageUsage> {
  if (!Number.isInteger(quota.maxBytes) || quota.maxBytes < 0) throw new Error("Storage maxBytes must be a non-negative integer.");
  const current = await storageUsage(root);
  if (current.bytes > quota.maxBytes || (quota.maxFiles !== undefined && current.files > quota.maxFiles)) {
    throw new Error(`TokenGraph storage quota exceeded (${current.bytes} bytes, ${current.files} files).`);
  }
  return current;
}

export async function hardenStoragePermissions(root: string): Promise<void> {
  if (process.platform === "win32") return;
  for (const directory of [stateDir(root), await resolveRepositoryStateDirectory(root)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function purgeTokenGraphStorage(root: string, options: { repository?: boolean } = {}): Promise<void> {
  await rm(stateDir(root), { recursive: true, force: true });
  if (options.repository) await rm(await resolveRepositoryStateDirectory(root), { recursive: true, force: true });
}

export function isConfinedStoragePath(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const relativePath = relative(base, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":") && !target.startsWith(`${base}:`));
}

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]+/gi,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g
];

export function filterUntrustedSourceText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:ignore previous|system message|developer message|assistant message|instructions?:)\b/i.test(line))
    .map((line) => SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), line))
    .join("\n");
}
