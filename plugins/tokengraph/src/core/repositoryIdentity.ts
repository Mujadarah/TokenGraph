import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RepositoryIdentity, RetrievalSignals } from "./types.js";
import { canonicalPersistenceLock } from "./lockDomain.js";
import { withFileLock, writeJsonAtomic, writeTextAtomic } from "./storage.js";

const execFileAsync = promisify(execFile);

export const LOCAL_EXCLUDE_WARNING = "TokenGraph could not update .git/info/exclude; add this exact line manually: .tokengraph/";
const setupWarnings = new Map<string, string[]>();
const LEGACY_REPOSITORY_STATE_SCHEMA_VERSION = 1 as const;

async function git(root: string, ...args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export async function getGitFileRecency(
  root: string,
  requestedPaths: string[],
  requestedDepth = 50
): Promise<RetrievalSignals> {
  const historyDepth = Math.max(1, Math.min(50, Number.isFinite(requestedDepth) ? Math.trunc(requestedDepth) : 50));
  const neutral: RetrievalSignals = { source: "unavailable", historyDepth, fileCommitDistance: {} };
  const normalizedPaths = [...new Set(requestedPaths.map((path) => path.replaceAll("\\", "/")))].sort();
  const requested = new Set(normalizedPaths);
  try {
    const result = await execFileAsync("git", [
      "-C", resolve(root), "-c", "core.quotePath=false", "log", "-n", String(historyDepth),
      "--format=commit:%H%x00", "--name-only", "-z", "--no-renames", "HEAD", "--"
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const distances = new Map<string, number>();
    let commitDistance = -1;
    for (const rawToken of result.stdout.split("\0")) {
      if (rawToken.startsWith("commit:")) {
        commitDistance += 1;
        continue;
      }
      const path = rawToken.replace(/^\r?\n/, "").replaceAll("\\", "/");
      if (path && requested.has(path) && !distances.has(path)) distances.set(path, commitDistance);
    }
    return {
      source: "git-commit-distance",
      historyDepth,
      fileCommitDistance: Object.fromEntries([...distances.entries()].sort(([a], [b]) => a.localeCompare(b)))
    };
  } catch {
    return neutral;
  }
}

async function ensureLocalExclude(root: string): Promise<void> {
  const exclude = await git(root, "rev-parse", "--git-path", "info/exclude");
  if (!exclude) return;
  const path = resolve(root, exclude);
  try {
    const lock = await canonicalPersistenceLock(root, "git-info", "exclude");
    await withFileLock(lock, async () => {
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

const repositoryIdLoads = new Map<string, Promise<string>>();

async function loadOrCreateRepositoryIdUnqueued(workspaceRoot: string, directory: string): Promise<string> {
  const path = join(directory, "identity.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedIdentity>;
    if (parsed.schemaVersion === 1 && typeof parsed.repositoryId === "string" && parsed.repositoryId.length >= 16) return parsed.repositoryId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const repositoryId = digest(`${directory}\n${Date.now()}\n${Math.random()}`);
  const lock = await canonicalPersistenceLock(workspaceRoot, "repository-state", "identity.json");
  await withFileLock(lock, async () => {
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

async function loadOrCreateRepositoryId(workspaceRoot: string, directory: string): Promise<string> {
  const key = process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
  const existing = repositoryIdLoads.get(key);
  if (existing) return existing;
  const current = loadOrCreateRepositoryIdUnqueued(workspaceRoot, directory);
  repositoryIdLoads.set(key, current);
  try {
    return await current;
  } finally {
    if (repositoryIdLoads.get(key) === current) repositoryIdLoads.delete(key);
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
  const normalizedGitDir = gitDir ? resolve(workspaceRoot, gitDir) : undefined;
  if (topLevel && commonDir) await ensureLocalExclude(workspaceRoot);
  const repositoryState = await resolveRepositoryStateDirectory(normalizedRoot);
  const repositoryId = await loadOrCreateRepositoryId(workspaceRoot, repositoryState);
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
  // Repository knowledge is now owned by the active workspace. The optional
  // commonDirectory argument remains for source compatibility with callers
  // from the shared-store era; it is intentionally ignored.
  void commonDirectory;
  return join(resolve(root), ".tokengraph", "repository");
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
  const normalizedRoot = resolve(root);
  const target = repositoryStateDirectory(normalizedRoot);
  const commonDirectory = await gitCommonDirectory(normalizedRoot);
  if (commonDirectory) await migrateLegacyRepositoryState(normalizedRoot, join(commonDirectory, "tokengraph"), target);
  return target;
}

interface LegacyMigrationReport {
  schemaVersion: typeof LEGACY_REPOSITORY_STATE_SCHEMA_VERSION;
  source: string;
  migratedAt: string;
  migrated: string[];
  skippedExisting: string[];
  skippedInvalid: string[];
  skippedUnsupported: string[];
  skippedSymlink: string[];
}

async function migrateLegacyRepositoryState(workspaceRoot: string, source: string, target: string): Promise<void> {
  try {
    await lstat(join(target, "migration.json"));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let sourceStats: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceStats = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sourceStats.isDirectory()) return;

  const lock = await canonicalPersistenceLock(workspaceRoot, "repository-state", "migration.json");
  await withFileLock(lock, async () => {
    try {
      await lstat(join(target, "migration.json"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const report: LegacyMigrationReport = {
      schemaVersion: LEGACY_REPOSITORY_STATE_SCHEMA_VERSION,
      source,
      migratedAt: new Date().toISOString(),
      migrated: [],
      skippedExisting: [],
      skippedInvalid: [],
      skippedUnsupported: [],
      skippedSymlink: []
    };
    await migrateLegacyEntries(source, target, "", report);
    await writeJsonAtomic(join(target, "migration.json"), report);
  });
}

async function migrateLegacyEntries(sourceRoot: string, targetRoot: string, relativePath: string, report: LegacyMigrationReport): Promise<void> {
  const sourceDirectory = join(sourceRoot, relativePath);
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const entryRelativePath = relativePath ? join(relativePath, entry.name) : entry.name;
    const sourcePath = join(sourceRoot, entryRelativePath);
    if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) {
      report.skippedUnsupported.push(entryRelativePath);
      continue;
    }
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink()) {
      report.skippedSymlink.push(entryRelativePath);
      continue;
    }
    if (stats.isDirectory()) {
      await migrateLegacyEntries(sourceRoot, targetRoot, entryRelativePath, report);
      continue;
    }
    if (!stats.isFile() || !entry.name.endsWith(".json")) {
      report.skippedUnsupported.push(entryRelativePath);
      continue;
    }
    const targetPath = join(targetRoot, entryRelativePath);
    try {
      await lstat(targetPath);
      report.skippedExisting.push(entryRelativePath);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let contents: string;
    try {
      contents = await readFile(sourcePath, "utf8");
      JSON.parse(contents);
    } catch (error) {
      if (error instanceof SyntaxError) {
        report.skippedInvalid.push(entryRelativePath);
        continue;
      }
      throw error;
    }
    await writeTextAtomic(targetPath, contents);
    report.migrated.push(entryRelativePath);
  }
}
