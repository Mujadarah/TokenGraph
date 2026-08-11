import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LOCK_DOMAINS = Object.freeze([
  "workspace-state",
  "repository-state",
  "runs",
  "tasks",
  "vault",
  "wiki",
  "artifacts",
  "git-info"
] as const);

export type LockDomain = (typeof LOCK_DOMAINS)[number];

export interface CanonicalPersistenceLock {
  readonly domain: LockDomain;
  readonly domainRoot: string;
  readonly compatibilityPath: string;
  readonly anchorPath: string;
  readonly journalPath: string;
}

export class LockDomainError extends Error {
  readonly code = "INVALID_LOCK_DOMAIN" as const;

  constructor() {
    super("Persistence lock domain or key is not authorized.");
    this.name = "LockDomainError";
  }
}

const lockBrand = new WeakSet<object>();
const domainSet = new Set<string>(LOCK_DOMAINS);
const ANCHOR_NAME = ".tokengraph-native-anchor-v2.lock";
const JOURNAL_NAME = ".tokengraph-native-journal-v2.lock";
const MAX_SEGMENT_BYTES = 240;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function fail(): never {
  throw new LockDomainError();
}

function isSafeSingleSegment(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (/[<>:"|?*\u0000-\u001f]/u.test(value) || /[. ]$/u.test(value)) return false;
  if (WINDOWS_DEVICE_NAME.test(value)) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_SEGMENT_BYTES) return false;
  const compatibilityName = `${value}.lock`;
  const portableName = compatibilityName.toLowerCase();
  return portableName !== ANCHOR_NAME && portableName !== JOURNAL_NAME;
}

function confinedDirectChild(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference.length > 0 && !difference.startsWith(`..${sep}`) && difference !== ".." &&
    !isAbsolute(difference) && dirname(candidate) === root && !difference.includes(sep);
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  const canonical = await realpath(path).catch(fail);
  const stats = await lstat(canonical).catch(fail);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail();
  return canonical;
}

function fileIdentity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

async function stableMarker(path: string): Promise<string> {
  const before = await lstat(path, { bigint: true }).catch(fail);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) fail();
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(fail);
  try {
    const opened = await handle.stat({ bigint: true }).catch(fail);
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > 4096n ||
      fileIdentity(opened) !== fileIdentity(before)) fail();
    const bytes = await handle.readFile().catch(fail);
    const after = await handle.stat({ bigint: true }).catch(fail);
    const entryAfter = await lstat(path, { bigint: true }).catch(fail);
    if (bytes.length > 4096 || fileIdentity(after) !== fileIdentity(opened) ||
      fileIdentity(entryAfter) !== fileIdentity(opened) || !entryAfter.isFile() ||
      entryAfter.isSymbolicLink() || entryAfter.nlink !== 1n) fail();
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function oneLinePath(marker: string): string {
  const match = /^([^\r\n]+)\r?\n?$/u.exec(marker);
  if (match === null || match[1].length === 0 || match[1].includes("\0")) fail();
  return match[1];
}

async function resolveGitCommonDirectory(workspaceRoot: string): Promise<string> {
  const dotGit = join(workspaceRoot, ".git");
  const dotGitStats = await lstat(dotGit).catch(fail);
  let gitDirectory: string;
  if (dotGitStats.isDirectory() && !dotGitStats.isSymbolicLink()) {
    gitDirectory = await canonicalExistingDirectory(dotGit);
    const unexpectedCommonMarker = await lstat(join(gitDirectory, "commondir")).then(() => true, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail();
    });
    if (unexpectedCommonMarker) fail();
    return gitDirectory;
  } else if (dotGitStats.isFile() && !dotGitStats.isSymbolicLink() && dotGitStats.nlink === 1) {
    const marker = await stableMarker(dotGit);
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(marker);
    if (match === null || match[1].includes("\0")) fail();
    gitDirectory = await canonicalExistingDirectory(resolve(workspaceRoot, match[1]));
  } else {
    fail();
  }

  const commonPath = oneLinePath(await stableMarker(join(gitDirectory, "commondir")));
  const commonDirectory = await canonicalExistingDirectory(resolve(gitDirectory, commonPath));
  const worktreesDirectory = await canonicalExistingDirectory(join(commonDirectory, "worktrees"));
  if (dirname(gitDirectory) !== worktreesDirectory) fail();

  const backlinkPath = oneLinePath(await stableMarker(join(gitDirectory, "gitdir")));
  const backlink = await realpath(resolve(gitDirectory, backlinkPath)).catch(fail);
  const canonicalDotGit = await realpath(dotGit).catch(fail);
  if (backlink !== canonicalDotGit) fail();
  return commonDirectory;
}

async function domainRoot(workspaceRoot: string, domain: LockDomain): Promise<string> {
  const stateRoot = join(workspaceRoot, ".tokengraph");
  switch (domain) {
    case "workspace-state": return stateRoot;
    case "repository-state": return join(stateRoot, "repository");
    case "runs": return join(stateRoot, "runs");
    case "tasks": return join(stateRoot, "tasks");
    case "vault": return join(stateRoot, "vault");
    case "wiki": return join(stateRoot, "wiki");
    case "artifacts": return join(stateRoot, "repository", "artifacts");
    case "git-info": return join(await resolveGitCommonDirectory(workspaceRoot), "info");
  }
}

export async function canonicalPersistenceLock(
  workspaceRoot: string,
  domain: LockDomain,
  relativeDataName: string
): Promise<CanonicalPersistenceLock> {
  if (typeof workspaceRoot !== "string" || !domainSet.has(domain) ||
    typeof relativeDataName !== "string" || !isSafeSingleSegment(relativeDataName)) fail();
  const canonicalWorkspace = await canonicalExistingDirectory(resolve(workspaceRoot));
  const root = resolve(await domainRoot(canonicalWorkspace, domain));
  const compatibilityPath = join(root, `${relativeDataName}.lock`);
  if (!confinedDirectChild(root, compatibilityPath)) fail();
  const lock = Object.freeze({
    domain,
    domainRoot: root,
    compatibilityPath,
    anchorPath: join(root, ANCHOR_NAME),
    journalPath: join(root, JOURNAL_NAME)
  });
  lockBrand.add(lock);
  return lock;
}

export function isCanonicalPersistenceLock(value: unknown): value is CanonicalPersistenceLock {
  return typeof value === "object" && value !== null && lockBrand.has(value);
}

export function relativeLegacyName(lock: CanonicalPersistenceLock): string {
  if (!isCanonicalPersistenceLock(lock)) fail();
  const value = relative(lock.domainRoot, lock.compatibilityPath);
  if (!confinedDirectChild(lock.domainRoot, lock.compatibilityPath)) fail();
  return value;
}
