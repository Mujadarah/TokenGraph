import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RepositoryIdentity } from "./types.js";
import { canonicalPersistenceLockKey, withFileLock, writeJsonAtomic, writeTextAtomic } from "./storage.js";

const execFileAsync = promisify(execFile);

export const LOCAL_EXCLUDE_WARNING = "TokenGraph could not update .git/info/exclude; add this exact line manually: .tokengraph/";
const setupWarnings = new Map<string, string[]>();

async function git(root: string, ...args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

async function ensureLocalExclude(root: string): Promise<void> {
  const exclude = await git(root, "rev-parse", "--git-path", "info/exclude");
  if (!exclude) return;
  const path = resolve(root, exclude);
  try {
    const lockKey = await canonicalPersistenceLockKey(path);
    await withFileLock(`${lockKey}.lock`, async () => {
      let existing = "";
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const lines = existing.split(/\r?\n/);
      if (lines.some((line) => line.trim() === ".tokengraph/")) return;
      const next = `${existing.replace(/[\r\n]*$/, "")}${existing ? "\n" : ""}.tokengraph/\n`;
      await writeTextAtomic(path, next);
    });
    setupWarnings.delete(resolve(root));
  } catch {
    setupWarnings.set(resolve(root), [LOCAL_EXCLUDE_WARNING]);
  }
}

export function getRepositorySetupWarnings(root: string): string[] {
  return [...(setupWarnings.get(resolve(root)) ?? [])];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function remoteIdentity(root: string): Promise<string | undefined> {
  const remotes = await git(root, "remote", "get-url", "--all", "origin");
  return remotes?.split(/\r?\n/).map((value) => sanitizeRemote(value.trim())).filter(Boolean).sort().join("\n");
}

function sanitizeRemote(value: string): string {
  const scpStyle = value.match(/^[^@\/\s]+@([^:\/\s]+):(.+)$/);
  if (scpStyle) return `ssh://${scpStyle[1]}/${scpStyle[2]}`;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/[^/@\s]+@/g, "//");
  }
}

interface PersistedIdentity {
  schemaVersion: 1;
  repositoryId: string;
}

async function loadOrCreateRepositoryId(directory: string): Promise<string> {
  const path = join(directory, "identity.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedIdentity>;
    if (parsed.schemaVersion === 1 && typeof parsed.repositoryId === "string" && parsed.repositoryId.length >= 16) return parsed.repositoryId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const repositoryId = digest(`${directory}\n${Date.now()}\n${Math.random()}`);
  const lockKey = await canonicalPersistenceLockKey(directory, "identity.json");
  await withFileLock(`${lockKey}.lock`, async () => {
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedIdentity>;
      if (existing.schemaVersion === 1 && typeof existing.repositoryId === "string" && existing.repositoryId.length >= 16) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await writeJsonAtomic(path, { schemaVersion: 1, repositoryId });
  });
  try {
    const persisted = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedIdentity>;
    return typeof persisted.repositoryId === "string" ? persisted.repositoryId : repositoryId;
  } catch {
    return repositoryId;
  }
}

export async function getRepositoryIdentity(root: string): Promise<RepositoryIdentity> {
  const workspaceRoot = resolve(root);
  // Branch and HEAD are intentionally refreshed on every call. Repository-id
  // persistence is cheap, while caching this full value silently cross-applies
  // branch-specific state after a checkout or commit.
  return getRepositoryIdentityUncached(workspaceRoot);
}

async function getRepositoryIdentityUncached(workspaceRoot: string): Promise<RepositoryIdentity> {
  const [topLevel, commonDir, gitDir, branch, headCommit, firstCommits, remote] = await Promise.all([
    git(workspaceRoot, "rev-parse", "--show-toplevel"),
    git(workspaceRoot, "rev-parse", "--git-common-dir"),
    git(workspaceRoot, "rev-parse", "--git-dir"),
    git(workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"),
    git(workspaceRoot, "rev-parse", "HEAD"),
    git(workspaceRoot, "rev-list", "--max-parents=0", "HEAD"),
    remoteIdentity(workspaceRoot)
  ]);
  const normalizedRoot = resolve(topLevel ?? workspaceRoot);
  const normalizedCommon = commonDir ? resolve(workspaceRoot, commonDir) : undefined;
  const normalizedGitDir = gitDir ? resolve(workspaceRoot, gitDir) : undefined;
  if (topLevel && commonDir) await ensureLocalExclude(workspaceRoot);
  const repositoryState = repositoryStateDirectory(normalizedRoot, normalizedCommon);
  const repositoryId = await loadOrCreateRepositoryId(repositoryState);
  const firstCommit = firstCommits?.split(/\r?\n/).filter(Boolean).sort()[0] ?? "unborn";
  const repositoryFingerprint = digest(`${repositoryId}\n${firstCommit}`);
  return {
    repositoryId,
    repositoryFingerprint,
    workspaceId: digest(normalizedRoot),
    worktreeId: digest(normalizedGitDir ?? normalizedRoot),
    branch: branch ?? "detached",
    headCommit: headCommit ?? "unborn",
    ...(remote ? { remoteIdentity: remote } : {})
  };
}

export async function gitCommonDirectory(root: string): Promise<string | undefined> {
  const commonDir = await git(resolve(root), "rev-parse", "--git-common-dir");
  if (!commonDir) return undefined;
  return resolve(root, commonDir);
}

export function repositoryStateDirectory(root: string, commonDirectory?: string): string {
  return commonDirectory ? join(commonDirectory, "tokengraph") : join(resolve(root), ".tokengraph", "repository");
}

export async function isGitWorkspace(root: string): Promise<boolean> {
  try {
    await access(join(resolve(root), ".git"));
    return Boolean(await git(resolve(root), "rev-parse", "--show-toplevel"));
  } catch {
    return false;
  }
}

export async function resolveRepositoryStateDirectory(root: string): Promise<string> {
  return repositoryStateDirectory(root, await gitCommonDirectory(root));
}
