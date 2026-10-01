import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

import { runWithFileLock, type FileLockOptions } from "./fileLockLease.js";
import { canonicalHash } from "./canonical.js";
import { canonicalPersistenceLock, isCanonicalPersistenceLock, type CanonicalPersistenceLock, type LockDomain } from "./lockDomain.js";
import { getLegacyRuntimeActivationStatus, requireLegacyRuntimeShutdownCapability } from "./legacyRuntimeActivation.js";

export interface JsonTokenGraphStoreOptions {
  schemaVersion: number;
  dataKey: string;
}

export type WriteStorageClass = "runs" | "cache" | "vault" | "durable";

export interface WriteTelemetryContext {
  root: string;
  storageClass: WriteStorageClass;
}

export interface AtomicWriteOptions {
  telemetry?: WriteTelemetryContext;
}

export interface WriteTelemetryClassAggregate {
  operationCount: number;
  logicalBytes: number;
  physicalBytes?: number;
}

export interface DailyWriteTelemetry {
  date: string;
  sampledPeakRssBytes: number;
  classes: Partial<Record<WriteStorageClass, WriteTelemetryClassAggregate>>;
}

export interface WriteTelemetryDocument {
  schemaVersion: 1;
  days: DailyWriteTelemetry[];
}

export const MAX_PERSISTED_WRITE_TELEMETRY_DAYS = 14;
const MAX_ATOMIC_NOOP_READ_BYTES = 64 * 1024 * 1024;
const MAX_WRITE_TELEMETRY_BYTES = 256 * 1024;
const WRITE_STORAGE_CLASSES: readonly WriteStorageClass[] = ["runs", "cache", "vault", "durable"];
interface PendingWriteAggregate { operationCount: bigint; logicalBytes: bigint; physicalBytes?: bigint }
interface PendingWriteDay {
  date: string;
  sampledPeakRssBytes: number;
  classes: Partial<Record<WriteStorageClass, PendingWriteAggregate>>;
}
const pendingWriteTelemetry = new Map<string, Map<string, PendingWriteDay>>();
const writeTelemetryFlushChains = new Map<string, Promise<void>>();

function telemetryKey(root: string): string {
  const key = resolve(root);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function telemetryDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function isValidTelemetryDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function checkedTelemetrySum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error("TokenGraph write telemetry counter overflow; refusing to lose aggregate data.");
  }
  return sum;
}

function mergeAggregate(current: WriteTelemetryClassAggregate | undefined, incoming: WriteTelemetryClassAggregate): WriteTelemetryClassAggregate {
  if (!current) return { ...incoming };
  return {
    operationCount: checkedTelemetrySum(current?.operationCount ?? 0, incoming.operationCount),
    logicalBytes: checkedTelemetrySum(current?.logicalBytes ?? 0, incoming.logicalBytes),
    ...(current.physicalBytes === undefined || incoming.physicalBytes === undefined
      ? {}
      : { physicalBytes: checkedTelemetrySum(current?.physicalBytes ?? 0, incoming.physicalBytes ?? 0) })
  };
}

function mergeDailyTelemetry(current: DailyWriteTelemetry | undefined, incoming: DailyWriteTelemetry): DailyWriteTelemetry {
  const classes: Partial<Record<WriteStorageClass, WriteTelemetryClassAggregate>> = {};
  for (const storageClass of WRITE_STORAGE_CLASSES) {
    const existing = current?.classes[storageClass];
    const addition = incoming.classes[storageClass];
    if (addition) classes[storageClass] = mergeAggregate(existing, addition);
    else if (existing) classes[storageClass] = { ...existing };
  }
  return {
    date: incoming.date,
    sampledPeakRssBytes: Math.max(current?.sampledPeakRssBytes ?? 0, incoming.sampledPeakRssBytes),
    classes
  };
}

function mergePendingDay(current: PendingWriteDay | undefined, incoming: PendingWriteDay): PendingWriteDay {
  const classes = { ...current?.classes };
  for (const storageClass of WRITE_STORAGE_CLASSES) {
    const addition = incoming.classes[storageClass];
    if (!addition) continue;
    const existing = classes[storageClass];
    classes[storageClass] = !existing ? { ...addition } : {
      operationCount: existing.operationCount + addition.operationCount,
      logicalBytes: existing.logicalBytes + addition.logicalBytes,
      ...(existing.physicalBytes === undefined || addition.physicalBytes === undefined ? {} : {
        physicalBytes: existing.physicalBytes + addition.physicalBytes
      })
    };
  }
  return { date: incoming.date, sampledPeakRssBytes: Math.max(current?.sampledPeakRssBytes ?? 0, incoming.sampledPeakRssBytes), classes };
}

function serializePendingDay(day: PendingWriteDay): DailyWriteTelemetry {
  const safeNumber = (value: bigint): number => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("TokenGraph write telemetry counter overflow; exact pending counters are retained in memory.");
    return Number(value);
  };
  const classes: DailyWriteTelemetry["classes"] = {};
  for (const storageClass of WRITE_STORAGE_CLASSES) {
    const value = day.classes[storageClass];
    if (value) classes[storageClass] = {
      operationCount: safeNumber(value.operationCount), logicalBytes: safeNumber(value.logicalBytes),
      ...(value.physicalBytes === undefined ? {} : { physicalBytes: safeNumber(value.physicalBytes) })
    };
  }
  return { date: day.date, sampledPeakRssBytes: day.sampledPeakRssBytes, classes };
}

function isValidAggregate(value: unknown): value is WriteTelemetryClassAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WriteTelemetryClassAggregate>;
  return Number.isSafeInteger(candidate.operationCount) && candidate.operationCount! >= 0 &&
    Number.isSafeInteger(candidate.logicalBytes) && candidate.logicalBytes! >= 0 &&
    (candidate.physicalBytes === undefined || (Number.isSafeInteger(candidate.physicalBytes) && candidate.physicalBytes >= 0));
}

function isValidDailyTelemetry(value: unknown): value is DailyWriteTelemetry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DailyWriteTelemetry>;
  if (!isValidTelemetryDay(candidate.date) ||
    !Number.isSafeInteger(candidate.sampledPeakRssBytes) || candidate.sampledPeakRssBytes! < 0 ||
    !candidate.classes || typeof candidate.classes !== "object" || Array.isArray(candidate.classes)) return false;
  return Object.entries(candidate.classes).every(([storageClass, aggregate]) =>
    WRITE_STORAGE_CLASSES.includes(storageClass as WriteStorageClass) && isValidAggregate(aggregate)
  );
}

export function normalizeWriteTelemetry(value: unknown): WriteTelemetryDocument {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<WriteTelemetryDocument> : {};
  if (typeof candidate.schemaVersion === "number" && candidate.schemaVersion > 1) {
    throw new Error(`Unsupported newer TokenGraph write telemetry schema version ${candidate.schemaVersion}; refusing to overwrite it.`);
  }
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.days) || candidate.days.some((day) => !isValidDailyTelemetry(day))) {
    throw new Error("TokenGraph write telemetry is malformed; refusing to overwrite it.");
  }
  const byDate = new Map<string, DailyWriteTelemetry>();
  for (const day of candidate.days.filter(isValidDailyTelemetry)) byDate.set(day.date, mergeDailyTelemetry(byDate.get(day.date), day));
  return {
    schemaVersion: 1,
    days: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-MAX_PERSISTED_WRITE_TELEMETRY_DAYS)
  };
}

export function writeTelemetryPath(root: string): string {
  return join(root, ".tokengraph", "telemetry", "write-aggregates.json");
}

export async function readWriteTelemetry(root: string): Promise<WriteTelemetryDocument> {
  try {
    const content = await readStableAtomicTarget(writeTelemetryPath(root), MAX_WRITE_TELEMETRY_BYTES);
    if (content === undefined) return { schemaVersion: 1, days: [] };
    return normalizeWriteTelemetry(JSON.parse(content) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, days: [] };
    if (error instanceof SyntaxError) throw new Error("TokenGraph write telemetry is malformed; refusing to overwrite it.");
    throw error;
  }
}

export function observeSuccessfulWrite(context: WriteTelemetryContext, logicalBytes: number, physicalBytes?: number): void {
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0 ||
      (physicalBytes !== undefined && (!Number.isSafeInteger(physicalBytes) || physicalBytes < 0))) {
    throw new Error("TokenGraph write telemetry accepts only non-negative safe-integer byte counts.");
  }
  const key = telemetryKey(context.root);
  const day = telemetryDay();
  const days = pendingWriteTelemetry.get(key) ?? new Map<string, PendingWriteDay>();
  const current = mergePendingDay(days.get(day), {
    date: day, sampledPeakRssBytes: process.memoryUsage().rss,
    classes: { [context.storageClass]: {
      operationCount: 1n, logicalBytes: BigInt(logicalBytes),
      ...(physicalBytes === undefined ? {} : { physicalBytes: BigInt(physicalBytes) })
    } }
  });
  days.set(day, current);
  const retainedDates = [...days.keys()].sort().slice(-MAX_PERSISTED_WRITE_TELEMETRY_DAYS);
  for (const date of [...days.keys()]) if (!retainedDates.includes(date)) days.delete(date);
  pendingWriteTelemetry.set(key, days);
}

async function flushWriteTelemetryNow(root: string): Promise<boolean> {
  const key = telemetryKey(root);
  const snapshot = pendingWriteTelemetry.get(key);
  if (!snapshot?.size) return false;
  const writesDuringFlush = new Map<string, PendingWriteDay>();
  pendingWriteTelemetry.set(key, writesDuringFlush);
  try {
    const lock = await canonicalPersistenceLock(root, "workspace-state", "write-telemetry.json");
    await withFileLock(lock, async () => {
      const persisted = await readWriteTelemetry(root);
      const byDate = new Map(persisted.days.map((day) => [day.date, day]));
      for (const day of snapshot.values()) byDate.set(day.date, mergeDailyTelemetry(byDate.get(day.date), serializePendingDay(day)));
      await writeJsonAtomic(writeTelemetryPath(root), {
        schemaVersion: 1,
        days: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-MAX_PERSISTED_WRITE_TELEMETRY_DAYS)
      });
    });
    if (pendingWriteTelemetry.get(key) === writesDuringFlush && writesDuringFlush.size === 0) {
      pendingWriteTelemetry.delete(key);
    }
    return true;
  } catch (error) {
    const pending = pendingWriteTelemetry.get(key) ?? new Map<string, PendingWriteDay>();
    for (const day of snapshot.values()) pending.set(day.date, mergePendingDay(pending.get(day.date), day));
    pendingWriteTelemetry.set(key, pending);
    throw error;
  }
}

export async function flushWriteTelemetry(root: string): Promise<boolean> {
  const key = telemetryKey(root);
  const previous = writeTelemetryFlushChains.get(key) ?? Promise.resolve();
  let flushed = false;
  const current = previous.then(
    async () => { flushed = await flushWriteTelemetryNow(root); },
    async () => { flushed = await flushWriteTelemetryNow(root); }
  );
  const settled = current.then(() => undefined, () => undefined);
  writeTelemetryFlushChains.set(key, settled);
  try {
    await current;
    return flushed;
  } finally {
    if (writeTelemetryFlushChains.get(key) === settled) writeTelemetryFlushChains.delete(key);
  }
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

interface MaintenanceIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly birthtimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function pathIdentity(stats: BigIntStats): MaintenanceIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    birthtimeNs: stats.birthtimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

function sameMaintenanceIdentity(left: MaintenanceIdentity, right: MaintenanceIdentity, directory: boolean): boolean {
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode || left.birthtimeNs !== right.birthtimeNs) return false;
  return directory || (left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs);
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
  readonly identity: MaintenanceIdentity;
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
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error("Destructive maintenance refuses a symbolic-link or junction entry.");
  if (path.toLowerCase().endsWith(".lock")) throw new Error("Destructive maintenance refuses an unexplained legacy lock or compatibility barrier.");
  if (stats.isFile()) {
    if (stats.nlink !== 1n) throw new Error("Destructive maintenance refuses a multiply linked file.");
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
    const current = await lstat(entry.path, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Destructive maintenance target identity changed before deletion.");
      throw error;
    });
    if (!sameMaintenanceIdentity(entry.identity, pathIdentity(current), entry.directory) || current.isSymbolicLink() ||
        (entry.directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1n)) {
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

export async function readStableAtomicTarget(path: string, maximumBytes = MAX_ATOMIC_NOOP_READ_BYTES): Promise<string | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("TokenGraph stable-read limit is invalid.");
  await assertNoSymbolicLinkComponents(path);
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("TokenGraph atomic-write target is not a single-link regular file.");
  }
  if (before.size < 0n || before.size > BigInt(maximumBytes)) {
    throw new Error("TokenGraph atomic-write target exceeds its bounded validation limit.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile("utf8");
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
        !sameMaintenanceIdentity(pathIdentity(before), pathIdentity(opened), false) ||
        !sameMaintenanceIdentity(pathIdentity(before), pathIdentity(after), false)) {
      throw new Error("TokenGraph atomic-write target changed during no-op validation.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(path: string, value: unknown, options: AtomicWriteOptions = {}): Promise<boolean> {
  const payloadHash = canonicalHash(value);
  try {
    const existing = await readStableAtomicTarget(path);
    if (existing !== undefined && canonicalHash(JSON.parse(existing) as unknown) === payloadHash) return false;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeTextAtomic(path: string, content: string, options: AtomicWriteOptions = {}): Promise<boolean> {
  if (await readStableAtomicTarget(path) === content) return false;
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
  if (options.telemetry) observeSuccessfulWrite(options.telemetry, Buffer.byteLength(content, "utf8"));
  return true;
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

export async function writeTextAtomicConfined(root: string, relativeFile: string, content: string, options: AtomicWriteOptions = {}): Promise<boolean> {
  return writeTextAtomic(await resolveConfinedPath(root, relativeFile, true), content, options);
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
