import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

import { runWithFileLock, type FileLockOptions } from "./fileLockLease.js";
import { canonicalPersistenceLock, isCanonicalPersistenceLock, type CanonicalPersistenceLock, type LockDomain } from "./lockDomain.js";
import { getLegacyRuntimeActivationStatus, requireLegacyRuntimeShutdownCapability } from "./legacyRuntimeActivation.js";

export interface JsonTokenGraphStoreOptions {
  schemaVersion: number;
  dataKey: string;
}

export interface DestructiveMaintenanceConfirmation {
  readonly confirmedNoLegacyTokenGraphProcesses: true;
}

export interface DestructiveMaintenanceTarget {
  readonly domain: LockDomain;
  readonly relativePath?: string;
}

export interface DestructiveMaintenanceContext {
  readonly locks: readonly CanonicalPersistenceLock[];
  remove(targets: readonly DestructiveMaintenanceTarget[]): Promise<ReadonlySet<string>>;
}

export class DestructiveMaintenanceConfirmationError extends Error {
  readonly code = "DESTRUCTIVE_MAINTENANCE_UNCONFIRMED" as const;

  constructor() {
    super("Destructive TokenGraph maintenance requires a fresh confirmation that no legacy TokenGraph process is running.");
    this.name = "DestructiveMaintenanceConfirmationError";
  }
}

export const SAFE_WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

export async function withFileLock<T>(
  lock: CanonicalPersistenceLock,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  return runWithFileLock(lock, operation, options);
}

function maintenanceSortKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export async function canonicalMaintenanceLocks(
  root: string,
  domains: readonly LockDomain[]
): Promise<readonly CanonicalPersistenceLock[]> {
  const locks = await Promise.all([...new Set(domains)].map((domain) => canonicalPersistenceLock(root, domain, "maintenance")));
  const unique = new Map<string, CanonicalPersistenceLock>();
  for (const lock of locks) unique.set(maintenanceSortKey(lock.anchorPath), lock);
  return Object.freeze([...unique.values()].sort((left, right) => {
    const leftKey = maintenanceSortKey(left.anchorPath);
    const rightKey = maintenanceSortKey(right.anchorPath);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));
}

function assertMaintenanceConfirmation(value: unknown): asserts value is DestructiveMaintenanceConfirmation {
  if (value === null || typeof value !== "object" ||
      (value as { confirmedNoLegacyTokenGraphProcesses?: unknown }).confirmedNoLegacyTokenGraphProcesses !== true) {
    throw new DestructiveMaintenanceConfirmationError();
  }
}

function pathIdentity(stats: Awaited<ReturnType<typeof lstat>>): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

function safeMaintenanceRelativePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || isAbsolute(value) || value.includes("\0")) throw new Error("Maintenance target must be a safe relative path.");
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new Error("Maintenance target must be a safe relative path.");
  return segments.join("/");
}

interface PlannedMaintenanceEntry {
  readonly path: string;
  readonly identity: string;
  readonly directory: boolean;
}

async function planMaintenanceEntry(
  path: string,
  protectedPaths: ReadonlySet<string>,
  plan: PlannedMaintenanceEntry[]
): Promise<void> {
  const key = maintenanceSortKey(path);
  if (protectedPaths.has(key)) return;
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error("Destructive maintenance refuses a symbolic-link or junction entry.");
  if (path.toLowerCase().endsWith(".lock")) throw new Error("Destructive maintenance refuses an unexplained legacy lock or compatibility barrier.");
  if (stats.isFile()) {
    if (stats.nlink !== 1) throw new Error("Destructive maintenance refuses a multiply linked file.");
    plan.push({ path, identity: pathIdentity(stats), directory: false });
    return;
  }
  if (!stats.isDirectory()) throw new Error("Destructive maintenance refuses a non-regular filesystem entry.");
  for (const entry of (await readdir(path)).sort()) await planMaintenanceEntry(join(path, entry), protectedPaths, plan);
  plan.push({ path, identity: pathIdentity(stats), directory: true });
}

async function removePlannedMaintenanceEntries(plan: readonly PlannedMaintenanceEntry[]): Promise<ReadonlySet<string>> {
  const removed = new Set<string>();
  for (const entry of plan) {
    const current = await lstat(entry.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Destructive maintenance target identity changed before deletion.");
      throw error;
    });
    if (pathIdentity(current) !== entry.identity || current.isSymbolicLink() ||
        (entry.directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1)) {
      throw new Error("Destructive maintenance target identity changed before deletion.");
    }
    if (entry.directory) await rmdir(entry.path);
    else await unlink(entry.path);
    removed.add(entry.path);
  }
  return removed;
}

function createMaintenanceContext(locks: readonly CanonicalPersistenceLock[]): DestructiveMaintenanceContext {
  const byDomain = new Map<LockDomain, CanonicalPersistenceLock>();
  const protectedPaths = new Set<string>();
  for (const lock of locks) {
    if (!isCanonicalPersistenceLock(lock)) throw new Error("Maintenance requires canonical persistence locks.");
    byDomain.set(lock.domain, lock);
    for (const path of [
      lock.domainRoot,
      lock.anchorPath,
      lock.journalPath,
      `${lock.journalPath}.tokengraph-write-v2.tmp`,
      lock.compatibilityPath
    ]) protectedPaths.add(maintenanceSortKey(path));
  }
  return Object.freeze({
    locks,
    async remove(targets: readonly DestructiveMaintenanceTarget[]): Promise<ReadonlySet<string>> {
      const plans: PlannedMaintenanceEntry[] = [];
      const roots = new Set<string>();
      for (const target of targets) {
        const lock = byDomain.get(target.domain);
        if (!lock) throw new Error("Maintenance target domain was not acquired.");
        const relativePath = safeMaintenanceRelativePath(target.relativePath);
        const targetPath = relativePath === undefined ? lock.domainRoot : join(lock.domainRoot, ...relativePath.split("/"));
        const difference = relative(lock.domainRoot, targetPath);
        if (difference.startsWith("..") || isAbsolute(difference)) throw new Error("Maintenance target escapes its canonical domain.");
        if (relativePath === undefined) {
          let entries: string[];
          try { entries = (await readdir(lock.domainRoot)).sort(); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          for (const entry of entries) await planMaintenanceEntry(join(lock.domainRoot, entry), protectedPaths, plans);
        } else if (!roots.has(maintenanceSortKey(targetPath))) {
          roots.add(maintenanceSortKey(targetPath));
          await planMaintenanceEntry(targetPath, protectedPaths, plans);
        }
      }
      return removePlannedMaintenanceEntries(plans);
    }
  });
}

async function withMaintenanceLocks<T>(
  root: string,
  domains: readonly LockDomain[],
  operation: (context: DestructiveMaintenanceContext) => Promise<T>
): Promise<T> {
  const locks = await canonicalMaintenanceLocks(root, domains);
  const context = createMaintenanceContext(locks);
  const acquire = async (index: number): Promise<T> => index === locks.length
    ? operation(context)
    : withFileLock(locks[index]!, () => acquire(index + 1));
  return acquire(0);
}

export async function withDestructiveMaintenance<T>(
  root: string,
  domains: readonly LockDomain[],
  confirmation: DestructiveMaintenanceConfirmation,
  operation: (context: DestructiveMaintenanceContext) => Promise<T>
): Promise<T> {
  assertMaintenanceConfirmation(confirmation);
  requireLegacyRuntimeShutdownCapability();
  return withMaintenanceLocks(root, domains, operation);
}

export async function withAutomaticMaintenance<T>(
  root: string,
  domains: readonly LockDomain[],
  operation: (context: DestructiveMaintenanceContext) => Promise<T>
): Promise<T> {
  requireLegacyRuntimeShutdownCapability();
  return withMaintenanceLocks(root, domains, operation);
}

export async function canonicalPersistenceLockKey(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalRoot = resolvedRoot;
  }
  const key = join(canonicalRoot, ...segments);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await assertNoSymbolicLinkComponents(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkComponents(path);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  for (const segment of remainder) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`State write cannot traverse symbolic-link or junction component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function resolveConfinedPath(root: string, relativeFile: string, createParents = false): Promise<string> {
  if (!relativeFile || isAbsolute(relativeFile) || relativeFile.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("Confined path must be a safe relative file path.");
  }
  const canonicalRoot = await realpath(resolve(root));
  const segments = relativeFile.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) throw new Error("Confined path must name a file.");
  let parent = canonicalRoot;
  for (const segment of segments) {
    const candidate = join(parent, segment);
    // Created restrictively so TokenGraph never produces a project-state
    // directory that its own persistence-lock layer would later refuse.
    if (createParents) await mkdir(candidate, { recursive: false, mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    parent = await realpath(candidate);
    const confined = relative(canonicalRoot, parent);
    if (!confined || confined.startsWith("..") || isAbsolute(confined)) {
      throw new Error("Path resolves outside the trusted workspace.");
    }
  }
  const filePath = join(parent, fileName);
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error("Confined file path cannot be a symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return filePath;
}

export async function writeTextAtomicConfined(root: string, relativeFile: string, content: string): Promise<void> {
  await writeTextAtomic(await resolveConfinedPath(root, relativeFile, true), content);
}

export async function quarantineCorruptJson(path: string): Promise<void> {
  const corruptPath = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(path, corruptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export class JsonTokenGraphStore<T = unknown> {
  constructor(
    private readonly filePath: string,
    private readonly options: JsonTokenGraphStoreOptions
  ) {}

  async read(): Promise<T[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as T[];
      }
      if (parsed && typeof parsed === "object") {
        const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
        if (typeof schemaVersion === "number" && schemaVersion !== this.options.schemaVersion) {
          throw new Error(`Unsupported TokenGraph store schema version ${schemaVersion}; expected ${this.options.schemaVersion}.`);
        }
        const value = (parsed as Record<string, unknown>)[this.options.dataKey];
        return Array.isArray(value) ? (value as T[]) : [];
      }
      return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      if (error instanceof SyntaxError) {
        // Quarantine mutates project state, so it is deferred until the process
        // is activated. An unactivated pure read returns the same empty list.
        if (getLegacyRuntimeActivationStatus().activated) await quarantineCorruptJson(this.filePath);
        return [];
      }
      throw error;
    }
  }

  async write(data: T[]): Promise<void> {
    await writeJsonAtomic(resolve(this.filePath), {
      schemaVersion: this.options.schemaVersion,
      [this.options.dataKey]: data
    });
  }
}

export class SqliteTokenGraphStore {
  constructor(_databasePath: string) {
    throw new Error("The optional SQLite backend is not implemented; JSON storage remains the default.");
  }
}
