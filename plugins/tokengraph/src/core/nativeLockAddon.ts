import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NativeLockErrorCode =
  | "LOCK_BUSY"
  | "UNSAFE_ANCHOR"
  | "NATIVE_LOCK_ERROR"
  | "ADDON_MISSING"
  | "ADDON_INTEGRITY"
  | "ADDON_UNSUPPORTED"
  | "ADDON_ABI";

const ERROR_MESSAGES: Readonly<Record<NativeLockErrorCode, string>> = Object.freeze({
  LOCK_BUSY: "The native lock is busy.",
  UNSAFE_ANCHOR: "The native lock anchor is unsafe.",
  NATIVE_LOCK_ERROR: "The native lock operation failed.",
  ADDON_MISSING: "The native lock addon is unavailable.",
  ADDON_INTEGRITY: "The native lock addon failed integrity verification.",
  ADDON_UNSUPPORTED: "The native lock addon is unsupported on this runtime.",
  ADDON_ABI: "The native lock addon interface is incompatible."
});

const RETRIABLE_ERROR_CODES: ReadonlySet<NativeLockErrorCode> = new Set(["LOCK_BUSY"]);

export class NativeLockError extends Error {
  readonly code: NativeLockErrorCode;
  readonly retriable: boolean;

  constructor(code: NativeLockErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "NativeLockError";
    this.code = code;
    this.retriable = RETRIABLE_ERROR_CODES.has(code);
  }
}

export interface NativeLockHandle {
  protectCompatibilityDirectory(lockPath: string): void;
  releaseCompatibilityDirectory(): void;
  release(): void;
}

export interface NativeLockAddon {
  readonly targetId: string;
  readonly implementation: "lockfileex" | "flock";
  tryAcquireAnchor(anchorPath: string): NativeLockHandle;
}

export interface NativeLockAddonRuntime {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly glibcVersionRuntime?: string;
  readonly moduleUrl?: string | URL;
  readonly assetsRoot?: string;
  readonly loadModule?: (modulePath: string) => unknown;
  readonly afterArtifactRead?: () => void | Promise<void>;
  readonly tempDirectory?: string;
  readonly processId?: number;
  readonly probeProcess?: (pid: number) => void;
  readonly beforeStagedLoad?: (context: NativeLockStagingContext) => void | Promise<void>;
  readonly beforeStaleCleanup?: (context: NativeLockStaleContext) => void | Promise<void>;
  readonly inspectProductionRetention?: (isRetained: (candidate: object) => boolean) => void;
  readonly stagingIo?: NativeLockStagingIo;
}

export interface NativeLockStagingContext {
  readonly root: string;
  readonly sourcePath: string;
  readonly stagedPath: string;
  readonly markerPath: string;
  readonly targetId: string;
  readonly sha256: string;
}

export interface NativeLockStaleContext {
  readonly root: string;
  readonly stagedPath?: string;
  readonly markerPath?: string;
  readonly pid: number;
}

export interface NativeLockStagingIo {
  readonly makeReadOnly?: (path: string, mode: number) => Promise<void>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  readonly unlink?: (path: string) => Promise<void>;
  readonly rmdir?: (path: string) => Promise<void>;
}

interface NativeLockTarget {
  readonly id: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly libc: "glibc" | "none";
  readonly rustTarget: string;
  readonly file: string;
  readonly osFloor: string;
}

interface NativeLockManifestArtifactV1 extends NativeLockTarget {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeLockManifestV1 {
  readonly schemaVersion: 1;
  readonly addonAbiVersion: 1;
  readonly nodeApiVersion: 9;
  readonly rustToolchain: "1.97.1";
  readonly artifacts: readonly NativeLockManifestArtifactV1[];
}

const TARGET_DEFINITIONS = [
  { id: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", rustTarget: "aarch64-apple-darwin", file: "tokengraph-lock.darwin-arm64.node", osFloor: "macos-11.0" },
  { id: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", rustTarget: "x86_64-apple-darwin", file: "tokengraph-lock.darwin-x64.node", osFloor: "macos-11.0" },
  { id: "linux-arm64-gnu", platform: "linux", arch: "arm64", libc: "glibc", rustTarget: "aarch64-unknown-linux-gnu", file: "tokengraph-lock.linux-arm64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "linux-x64-gnu", platform: "linux", arch: "x64", libc: "glibc", rustTarget: "x86_64-unknown-linux-gnu", file: "tokengraph-lock.linux-x64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "win32-arm64", platform: "win32", arch: "arm64", libc: "none", rustTarget: "aarch64-pc-windows-msvc", file: "tokengraph-lock.win32-arm64.node", osFloor: "windows-10" },
  { id: "win32-x64", platform: "win32", arch: "x64", libc: "none", rustTarget: "x86_64-pc-windows-msvc", file: "tokengraph-lock.win32-x64.node", osFloor: "windows-10-server-2016" }
] as const satisfies readonly NativeLockTarget[];
const TARGETS: readonly NativeLockTarget[] = Object.freeze(TARGET_DEFINITIONS.map((target) => Object.freeze(target)));

const MANIFEST_MAX_BYTES = 256 * 1024;
const ADDON_MAX_BYTES = 64 * 1024 * 1024;
const MARKER_MAX_BYTES = 4 * 1024;
const STAGING_PREFIX = "tokengraph-native-addon-v1-";
const STALE_SWEEP_LIMIT = 32;
const STAGING_CHMOD_ATTEMPTS = 3;
const STAGING_CHMOD_RETRY_MS = 25;
const MANIFEST_KEYS = ["schemaVersion", "addonAbiVersion", "nodeApiVersion", "rustToolchain", "artifacts"] as const;
const ARTIFACT_KEYS = ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor", "path", "bytes", "sha256"] as const;
const OWNER_KEYS = ["schemaVersion", "pid", "targetId", "sha256", "addonFile"] as const;

type BigIntStats = Awaited<ReturnType<typeof lstat>> & {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

interface VerifiedSnapshot {
  readonly bytes: Buffer;
  readonly entry: BigIntStats;
  readonly parent: BigIntStats;
}

interface StagingOwnerV1 {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly targetId: string;
  readonly sha256: string;
  readonly addonFile: string;
}

interface StagingLifecycle {
  readonly root: string;
  readonly sourcePath: string;
  readonly stagedPath: string;
  readonly markerPath: string;
  readonly targetId: string;
  readonly sha256: string;
  readonly pid: number;
  readonly rootIdentity: BigIntStats;
  readonly markerBytes: Buffer;
  markerIdentity?: BigIntStats;
  stagedIdentity?: BigIntStats;
}

interface LoaderState {
  readonly cache: Map<string, NativeLockAddon>;
  readonly boundIdentities: Map<string, string>;
  readonly inFlight: Map<string, { identity: string; promise: Promise<NativeLockAddon> }>;
}

interface RetainedLoad {
  readonly loadedModule: LoadedNativeModule;
  readonly addon: NativeLockAddon;
  readonly source: VerifiedSnapshot;
  readonly staged: VerifiedSnapshot;
  readonly lifecycle: StagingLifecycle;
}

interface ProductionLoadedNativeModule {
  readonly provenance: "production";
  readonly holder: { exports: unknown };
  readonly rawAddon: unknown;
}

interface InjectedLoadedNativeModule {
  readonly provenance: "injected";
  readonly rawAddon: unknown;
}

type LoadedNativeModule = ProductionLoadedNativeModule | InjectedLoadedNativeModule;

interface StaleEntrySnapshot {
  readonly path: string;
  readonly identity: BigIntStats;
}

interface StaleSafeSubset {
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly pid: number;
  readonly marker?: StaleEntrySnapshot;
  readonly staged?: StaleEntrySnapshot;
}

interface CleanupResult {
  readonly complete: boolean;
  readonly phase?: "addon" | "marker" | "root" | "validation";
  readonly code?: string;
}

const productionLoaderState = createLoaderState();
const injectedLoaderStates = new WeakMap<(modulePath: string) => unknown, LoaderState>();
const stagingSweeps = new Map<string, Promise<void>>();
const stagingChains = new Map<string, Promise<void>>();
const preservedStagingRoots = new Map<string, string>();
const retainedLoads: RetainedLoad[] = [];
const retainedFailedModules: Array<{ loadedModule: ProductionLoadedNativeModule; lifecycle: StagingLifecycle }> = [];

function fail(code: NativeLockErrorCode): never {
  throw new NativeLockError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataDescriptorValue(value: object, property: PropertyKey, ownOnly = false): unknown {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) {
      return Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
    }
    if (ownOnly) return undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function descriptorString(value: unknown, property: PropertyKey): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = dataDescriptorValue(value, property);
  return typeof candidate === "string" ? candidate : undefined;
}

function errnoCode(error: unknown): string | undefined {
  return descriptorString(error, "code");
}

function createLoaderState(): LoaderState {
  return {
    cache: new Map(),
    boundIdentities: new Map(),
    inFlight: new Map()
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameObjectIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory();
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectoryIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function snapshotIdentity(pathKey: string, stats: BigIntStats): string {
  return [pathKey, stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

async function bigIntLstat(path: string): Promise<BigIntStats> {
  return await lstat(path, { bigint: true }) as BigIntStats;
}

function validateDirectory(stats: BigIntStats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("ADDON_INTEGRITY");
}

function validateFile(stats: BigIntStats, maxBytes: number): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size <= 0n || stats.size > BigInt(maxBytes)) {
    fail("ADDON_INTEGRITY");
  }
}

async function readVerifiedFile(
  path: string,
  maxBytes: number,
  missingCode: NativeLockErrorCode,
  afterRead?: () => void | Promise<void>
): Promise<VerifiedSnapshot> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parent = await bigIntLstat(dirname(path));
    validateDirectory(parent);
    const entry = await bigIntLstat(path);
    validateFile(entry, maxBytes);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    validateFile(opened, maxBytes);
    if (!sameFileIdentity(entry, opened)) fail("ADDON_INTEGRITY");

    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== opened.size) fail("ADDON_INTEGRITY");
    if (afterRead) await afterRead();

    const openedAfter = await handle.stat({ bigint: true }) as BigIntStats;
    const entryAfter = await bigIntLstat(path);
    const parentAfter = await bigIntLstat(dirname(path));
    validateFile(openedAfter, maxBytes);
    validateFile(entryAfter, maxBytes);
    validateDirectory(parentAfter);
    if (!sameFileIdentity(opened, openedAfter) ||
        !sameFileIdentity(opened, entryAfter) ||
        !sameDirectoryIdentity(parent, parentAfter)) {
      fail("ADDON_INTEGRITY");
    }
    return {
      bytes,
      entry: opened,
      parent
    };
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    if (errnoCode(error) === "ENOENT") throw new NativeLockError(missingCode);
    throw new NativeLockError("ADDON_INTEGRITY");
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        throw new NativeLockError("ADDON_INTEGRITY");
      }
    }
  }
}

function assertManifest(value: unknown): NativeLockManifestV1 {
  if (!isObject(value) || !hasExactKeys(value, MANIFEST_KEYS) ||
      value.schemaVersion !== 1 || value.addonAbiVersion !== 1 ||
      value.nodeApiVersion !== 9 || value.rustToolchain !== "1.97.1" ||
      !Array.isArray(value.artifacts) || value.artifacts.length !== TARGETS.length) {
    fail("ADDON_INTEGRITY");
  }
  for (let index = 0; index < TARGETS.length; index += 1) {
    const expected = TARGETS[index]!;
    const artifact = value.artifacts[index];
    if (!isObject(artifact) || !hasExactKeys(artifact, ARTIFACT_KEYS)) fail("ADDON_INTEGRITY");
    for (const key of ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor"] as const) {
      if (artifact[key] !== expected[key]) fail("ADDON_INTEGRITY");
    }
    if (artifact.path !== `${expected.id}/${expected.file}` ||
        !Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) <= 0 || (artifact.bytes as number) > ADDON_MAX_BYTES ||
        typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      fail("ADDON_INTEGRITY");
    }
  }
  return value as unknown as NativeLockManifestV1;
}

async function readManifest(assetsRoot: string): Promise<NativeLockManifestV1> {
  const snapshot = await readVerifiedFile(resolve(assetsRoot, "manifest.json"), MANIFEST_MAX_BYTES, "ADDON_MISSING");
  try {
    return assertManifest(JSON.parse(snapshot.bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    fail("ADDON_INTEGRITY");
  }
}

function atLeastGlibc228(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 28);
}

function reportedGlibcVersion(): string | undefined {
  const report = process.report?.getReport?.();
  const value = (report as { header?: { glibcVersionRuntime?: unknown } } | undefined)?.header?.glibcVersionRuntime;
  return typeof value === "string" ? value : undefined;
}

function selectTarget(runtime: NativeLockAddonRuntime): NativeLockTarget {
  const platform = runtime.platform ?? process.platform;
  const arch = runtime.arch ?? process.arch;
  if (platform === "linux") {
    const glibc = Object.prototype.hasOwnProperty.call(runtime, "glibcVersionRuntime")
      ? runtime.glibcVersionRuntime
      : reportedGlibcVersion();
    if (!atLeastGlibc228(glibc)) fail("ADDON_UNSUPPORTED");
  }
  const target = TARGETS.find((entry) => entry.platform === platform && entry.arch === arch);
  if (target === undefined) fail("ADDON_UNSUPPORTED");
  return target;
}

function resolveAssetsRoot(runtime: NativeLockAddonRuntime): string {
  if (runtime.assetsRoot !== undefined) {
    if (runtime.assetsRoot.length === 0) fail("ADDON_INTEGRITY");
    return resolve(runtime.assetsRoot);
  }
  let modulePath: string;
  try {
    modulePath = fileURLToPath(runtime.moduleUrl ?? import.meta.url);
  } catch {
    fail("ADDON_INTEGRITY");
  }
  const moduleDirectory = dirname(modulePath);
  if (basename(moduleDirectory) === "core" && basename(dirname(moduleDirectory)) === "src") {
    return resolve(moduleDirectory, "..", "..", "assets", "native-lock");
  }
  if (basename(moduleDirectory) === "dist") {
    return resolve(moduleDirectory, "..", "assets", "native-lock");
  }
  if (basename(moduleDirectory) === "core" && basename(dirname(moduleDirectory)) === "dist") {
    return resolve(moduleDirectory, "..", "..", "assets", "native-lock");
  }
  fail("ADDON_INTEGRITY");
}

function canonicalOwner(owner: StagingOwnerV1): Buffer {
  return Buffer.from(`${JSON.stringify(owner)}\n`);
}

function assertOwner(value: unknown, expectedPid?: number): StagingOwnerV1 {
  if (!isObject(value) || !hasExactKeys(value, OWNER_KEYS) || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
      typeof value.targetId !== "string" || !TARGETS.some((target) => target.id === value.targetId) ||
      typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256) ||
      typeof value.addonFile !== "string" || value.addonFile !== `${value.targetId}-${value.sha256}.node` ||
      (expectedPid !== undefined && value.pid !== expectedPid)) {
    fail("ADDON_INTEGRITY");
  }
  return value as unknown as StagingOwnerV1;
}

function validatePrivateMode(stats: BigIntStats, expected: bigint): void {
  if (process.platform !== "win32" && (stats.mode & 0o777n) !== expected) fail("ADDON_INTEGRITY");
}

async function writeExclusiveSynced(
  path: string,
  bytes: Buffer,
  platform: NodeJS.Platform,
  makeReadOnly: (path: string, mode: number) => Promise<void>
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    fail("ADDON_INTEGRITY");
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        fail("ADDON_INTEGRITY");
      }
    }
  }
  for (let attempt = 0; attempt < STAGING_CHMOD_ATTEMPTS; attempt += 1) {
    try {
      await makeReadOnly(path, 0o400);
      return;
    } catch (error) {
      const transientWindowsFailure = platform === "win32" &&
        ["EPERM", "EACCES", "EBUSY"].includes(errnoCode(error) ?? "");
      if (!transientWindowsFailure || attempt + 1 >= STAGING_CHMOD_ATTEMPTS) fail("ADDON_INTEGRITY");
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, STAGING_CHMOD_RETRY_MS));
    }
  }
}

async function exactDirectoryEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail("ADDON_INTEGRITY");
  }
  return entries.map((entry) => entry.name).sort();
}

async function verifyStagingLifecycle(lifecycle: StagingLifecycle, expectedBytes: Buffer): Promise<VerifiedSnapshot> {
  try {
    const rootBefore = await bigIntLstat(lifecycle.root);
    validateDirectory(rootBefore);
    validatePrivateMode(rootBefore, 0o700n);
    if (!sameDirectoryIdentity(lifecycle.rootIdentity, rootBefore)) fail("ADDON_INTEGRITY");
    const expectedEntries = [basename(lifecycle.markerPath), basename(lifecycle.stagedPath)].sort();
    if ((await exactDirectoryEntries(lifecycle.root)).join("\0") !== expectedEntries.join("\0")) fail("ADDON_INTEGRITY");

    const marker = await readVerifiedFile(lifecycle.markerPath, MARKER_MAX_BYTES, "ADDON_INTEGRITY");
    validatePrivateMode(marker.entry, 0o400n);
    if (!marker.bytes.equals(lifecycle.markerBytes)) fail("ADDON_INTEGRITY");
    let owner: StagingOwnerV1;
    try {
      owner = assertOwner(JSON.parse(marker.bytes.toString("utf8")), lifecycle.pid);
    } catch (error) {
      if (error instanceof NativeLockError) throw error;
      fail("ADDON_INTEGRITY");
    }
    if (owner.targetId !== lifecycle.targetId || owner.sha256 !== lifecycle.sha256 || owner.addonFile !== basename(lifecycle.stagedPath)) {
      fail("ADDON_INTEGRITY");
    }

    const staged = await readVerifiedFile(lifecycle.stagedPath, ADDON_MAX_BYTES, "ADDON_INTEGRITY");
    validatePrivateMode(staged.entry, 0o400n);
    if (!staged.bytes.equals(expectedBytes) || createHash("sha256").update(staged.bytes).digest("hex") !== lifecycle.sha256) {
      fail("ADDON_INTEGRITY");
    }
    const rootAfter = await bigIntLstat(lifecycle.root);
    if (!sameDirectoryIdentity(rootBefore, rootAfter)) fail("ADDON_INTEGRITY");
    if (lifecycle.markerIdentity !== undefined && !sameFileIdentity(lifecycle.markerIdentity, marker.entry)) fail("ADDON_INTEGRITY");
    if (lifecycle.stagedIdentity !== undefined && !sameFileIdentity(lifecycle.stagedIdentity, staged.entry)) fail("ADDON_INTEGRITY");
    lifecycle.markerIdentity ??= marker.entry;
    lifecycle.stagedIdentity ??= staged.entry;
    return staged;
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    fail("ADDON_INTEGRITY");
  }
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return errnoCode(error) === "ENOENT";
  }
}

async function cleanupOwnedStaging(lifecycle: StagingLifecycle, io: NativeLockStagingIo = {}): Promise<CleanupResult> {
  const unlinkFile = io.unlink ?? unlink;
  const removeDirectory = io.rmdir ?? rmdir;
  try {
    const root = await bigIntLstat(lifecycle.root);
    if (!root.isDirectory() || root.isSymbolicLink() || !sameObjectIdentity(lifecycle.rootIdentity, root)) {
      return { complete: false, phase: "validation" };
    }
    const allowed = new Set([basename(lifecycle.stagedPath), basename(lifecycle.markerPath)]);
    const entries = await readdir(lifecycle.root, { withFileTypes: true });
    if (entries.some((entry) => !allowed.has(entry.name) || entry.isSymbolicLink())) {
      return { complete: false, phase: "validation" };
    }

    const removeOwnedFile = async (path: string, identity: BigIntStats | undefined, phase: "addon" | "marker"): Promise<CleanupResult | undefined> => {
      let current: BigIntStats;
      try {
        current = await bigIntLstat(path);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return undefined;
        return { complete: false, phase, code: errnoCode(error) };
      }
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
          (identity !== undefined && !sameObjectIdentity(identity, current))) {
        return { complete: false, phase: "validation" };
      }
      try {
        await unlinkFile(path);
      } catch (error) {
        return { complete: false, phase, code: errnoCode(error) };
      }
      if (!(await pathIsAbsent(path))) return { complete: false, phase: "validation" };
      return undefined;
    };

    const addonFailure = await removeOwnedFile(lifecycle.stagedPath, lifecycle.stagedIdentity, "addon");
    if (addonFailure !== undefined) return addonFailure;
    const markerFailure = await removeOwnedFile(lifecycle.markerPath, lifecycle.markerIdentity, "marker");
    if (markerFailure !== undefined) return markerFailure;
    if ((await readdir(lifecycle.root)).length !== 0) return { complete: false, phase: "validation" };
    const rootBeforeRemoval = await bigIntLstat(lifecycle.root);
    if (!sameObjectIdentity(lifecycle.rootIdentity, rootBeforeRemoval)) return { complete: false, phase: "validation" };
    try {
      await removeDirectory(lifecycle.root);
    } catch (error) {
      return { complete: false, phase: "root", code: errnoCode(error) };
    }
    return (await pathIsAbsent(lifecycle.root)) ? { complete: true } : { complete: false, phase: "validation" };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { complete: true };
    return { complete: false, phase: "validation", code: errnoCode(error) };
  }
}

function stagingBase(runtime: NativeLockAddonRuntime): string {
  const value = runtime.tempDirectory ?? tmpdir();
  if (value.length === 0) fail("ADDON_INTEGRITY");
  return resolve(value);
}

function stagingProcessId(runtime: NativeLockAddonRuntime): number {
  const pid = runtime.processId ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("ADDON_INTEGRITY");
  return pid;
}

function stagingKey(runtime: NativeLockAddonRuntime): string {
  const base = stagingBase(runtime);
  const normalized = process.platform === "win32" ? base.toLowerCase() : base;
  return `${normalized}\0${stagingProcessId(runtime)}`;
}

function poisonStagingSlot(runtime: NativeLockAddonRuntime, root: string): boolean {
  const key = stagingKey(runtime);
  const existing = preservedStagingRoots.get(key);
  if (existing === undefined) {
    preservedStagingRoots.set(key, root);
    return true;
  }
  return existing === root;
}

async function createStagingLifecycle(
  runtime: NativeLockAddonRuntime,
  target: NativeLockTarget,
  sourcePath: string,
  sourceBytes: Buffer,
  sha256: string
): Promise<{ lifecycle: StagingLifecycle; staged: VerifiedSnapshot }> {
  const base = stagingBase(runtime);
  const pid = stagingProcessId(runtime);
  let lifecycle: StagingLifecycle | undefined;
  let createdRoot: string | undefined;
  try {
    const baseStats = await bigIntLstat(base);
    validateDirectory(baseStats);
    const root = await mkdtemp(join(base, `${STAGING_PREFIX}${pid}-`));
    createdRoot = root;
    if (dirname(root) !== base || !new RegExp(`^${STAGING_PREFIX}${pid}-[A-Za-z0-9]{6}$`, "u").test(basename(root))) {
      fail("ADDON_INTEGRITY");
    }
    await chmod(root, 0o700);
    const rootIdentity = await bigIntLstat(root);
    validateDirectory(rootIdentity);
    validatePrivateMode(rootIdentity, 0o700n);
    const addonFile = `${target.id}-${sha256}.node`;
    const owner: StagingOwnerV1 = { schemaVersion: 1, pid, targetId: target.id, sha256, addonFile };
    const markerBytes = canonicalOwner(owner);
    lifecycle = {
      root,
      sourcePath,
      stagedPath: resolve(root, addonFile),
      markerPath: resolve(root, "owner.json"),
      targetId: target.id,
      sha256,
      pid,
      rootIdentity,
      markerBytes
    };
    const makeReadOnly = runtime.stagingIo?.makeReadOnly ?? chmod;
    await writeExclusiveSynced(lifecycle.markerPath, markerBytes, target.platform, makeReadOnly);
    await writeExclusiveSynced(lifecycle.stagedPath, sourceBytes, target.platform, makeReadOnly);
    const staged = await verifyStagingLifecycle(lifecycle, sourceBytes);
    return { lifecycle, staged };
  } catch (error) {
    if (lifecycle !== undefined) {
      const cleanup = await cleanupOwnedStaging(lifecycle, runtime.stagingIo);
      if (!cleanup.complete) {
        poisonStagingSlot(runtime, lifecycle.root);
        fail("ADDON_INTEGRITY");
      }
    } else if (createdRoot !== undefined) {
      let removed = false;
      try {
        if (dirname(createdRoot) === base && basename(createdRoot).startsWith(`${STAGING_PREFIX}${pid}-`)) {
          const stats = await bigIntLstat(createdRoot);
          if (stats.isDirectory() && !stats.isSymbolicLink() && (await readdir(createdRoot)).length === 0) {
            await (runtime.stagingIo?.rmdir ?? rmdir)(createdRoot);
            removed = await pathIsAbsent(createdRoot);
          }
        }
      } catch {
        removed = false;
      }
      if (!removed) {
        poisonStagingSlot(runtime, createdRoot);
        fail("ADDON_INTEGRITY");
      }
    }
    if (error instanceof NativeLockError) throw error;
    fail("ADDON_INTEGRITY");
  }
}

function parseStagingPid(name: string): number | undefined {
  const match = /^tokengraph-native-addon-v1-(\d+)-[A-Za-z0-9]{6}$/u.exec(name);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && String(pid) === match[1] ? pid : undefined;
}

function parseStagedAddonName(name: string): { targetId: string; sha256: string } | undefined {
  for (const target of TARGETS) {
    const prefix = `${target.id}-`;
    if (!name.startsWith(prefix) || !name.endsWith(".node")) continue;
    const sha256 = name.slice(prefix.length, -".node".length);
    if (/^[0-9a-f]{64}$/u.test(sha256)) return { targetId: target.id, sha256 };
  }
  return undefined;
}

function isOrdinaryUnlinkedFile(stats: BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n;
}

function sameStableFileBytes(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.isFile() === right.isFile() && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function snapshotStaleSafeSubset(root: string, pid: number): Promise<StaleSafeSubset | undefined> {
  try {
    const rootIdentity = await bigIntLstat(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) return;
    validatePrivateMode(rootIdentity, 0o700n);
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 2 || entries.some((entry) => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))) return;
    const names = entries.map((entry) => entry.name).sort();
    const markerEntry = entries.find((entry) => entry.name === "owner.json");
    const addonEntries = entries.filter((entry) => entry.name !== "owner.json");
    if (addonEntries.length > 1) return;
    const parsedAddon = addonEntries.length === 1 ? parseStagedAddonName(addonEntries[0]!.name) : undefined;
    if (addonEntries.length === 1 && parsedAddon === undefined) return;

    let marker: StaleEntrySnapshot | undefined;
    let owner: StagingOwnerV1 | undefined;
    if (markerEntry !== undefined) {
      const markerPath = resolve(root, markerEntry.name);
      const markerSnapshot = await readVerifiedFile(markerPath, MARKER_MAX_BYTES, "ADDON_INTEGRITY");
      try {
        owner = assertOwner(JSON.parse(markerSnapshot.bytes.toString("utf8")), pid);
      } catch {
        return;
      }
      if (!markerSnapshot.bytes.equals(canonicalOwner(owner))) return;
      marker = { path: markerPath, identity: markerSnapshot.entry };
    }

    let staged: StaleEntrySnapshot | undefined;
    if (addonEntries.length === 1) {
      const stagedPath = resolve(root, addonEntries[0]!.name);
      const identity = await bigIntLstat(stagedPath);
      if (!isOrdinaryUnlinkedFile(identity)) return;
      staged = { path: stagedPath, identity };
    }
    if (owner !== undefined && staged !== undefined &&
        (owner.addonFile !== basename(staged.path) || owner.targetId !== parsedAddon?.targetId || owner.sha256 !== parsedAddon.sha256)) {
      return;
    }
    if (names.join("\0") !== [marker?.path === undefined ? undefined : "owner.json", staged === undefined ? undefined : basename(staged.path)]
      .filter((name): name is string => name !== undefined).sort().join("\0")) return;
    return { root, rootIdentity, pid, marker, staged };
  } catch {
    return undefined;
  }
}

async function revalidateStaleSafeSubset(subset: StaleSafeSubset): Promise<boolean> {
  try {
    const root = await bigIntLstat(subset.root);
    if (!sameDirectoryIdentity(subset.rootIdentity, root)) return false;
    const expected = [subset.marker?.path, subset.staged?.path]
      .filter((path): path is string => path !== undefined)
      .map((path) => basename(path)).sort();
    if ((await exactDirectoryEntries(subset.root)).join("\0") !== expected.join("\0")) return false;
    for (const entry of [subset.staged, subset.marker]) {
      if (entry === undefined) continue;
      const current = await bigIntLstat(entry.path);
      if (!isOrdinaryUnlinkedFile(current) || !sameFileIdentity(entry.identity, current)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function prepareStaleEntryForRemoval(
  entry: StaleEntrySnapshot,
  runtime: NativeLockAddonRuntime
): Promise<BigIntStats | undefined> {
  try {
    let current = await bigIntLstat(entry.path);
    if (!isOrdinaryUnlinkedFile(current) || !sameFileIdentity(entry.identity, current)) return undefined;
    if (process.platform === "win32" && (current.mode & 0o200n) === 0n) {
      await (runtime.stagingIo?.chmod ?? chmod)(entry.path, 0o600);
      const normalized = await bigIntLstat(entry.path);
      if (!isOrdinaryUnlinkedFile(normalized) || !sameStableFileBytes(current, normalized)) return undefined;
      current = normalized;
    }
    return current;
  } catch {
    return undefined;
  }
}

async function cleanupStaleSafeSubset(subset: StaleSafeSubset, runtime: NativeLockAddonRuntime): Promise<void> {
  try {
    if (!(await revalidateStaleSafeSubset(subset))) return;
    const unlinkFile = runtime.stagingIo?.unlink ?? unlink;
    if (subset.staged !== undefined) {
      const stagedIdentity = await prepareStaleEntryForRemoval(subset.staged, runtime);
      if (stagedIdentity === undefined || !sameDirectoryIdentity(subset.rootIdentity, await bigIntLstat(subset.root))) return;
      const expectedBeforeStaged = [subset.marker?.path, subset.staged.path]
        .filter((path): path is string => path !== undefined).map((path) => basename(path)).sort();
      if ((await exactDirectoryEntries(subset.root)).join("\0") !== expectedBeforeStaged.join("\0")) return;
      const stagedBeforeRemoval = await bigIntLstat(subset.staged.path);
      if (!isOrdinaryUnlinkedFile(stagedBeforeRemoval) || !sameFileIdentity(stagedIdentity, stagedBeforeRemoval)) return;
      if (subset.marker !== undefined) {
        const markerBeforeStagedRemoval = await bigIntLstat(subset.marker.path);
        if (!isOrdinaryUnlinkedFile(markerBeforeStagedRemoval) || !sameFileIdentity(subset.marker.identity, markerBeforeStagedRemoval)) return;
      }
      await unlinkFile(subset.staged.path);
      if (!(await pathIsAbsent(subset.staged.path))) return;
    }
    if (subset.marker !== undefined) {
      const markerIdentity = await prepareStaleEntryForRemoval(subset.marker, runtime);
      if (markerIdentity === undefined || !sameDirectoryIdentity(subset.rootIdentity, await bigIntLstat(subset.root)) ||
          (await exactDirectoryEntries(subset.root)).join("\0") !== "owner.json") return;
      const markerBeforeRemoval = await bigIntLstat(subset.marker.path);
      if (!isOrdinaryUnlinkedFile(markerBeforeRemoval) || !sameFileIdentity(markerIdentity, markerBeforeRemoval)) return;
      await unlinkFile(subset.marker.path);
      if (!(await pathIsAbsent(subset.marker.path))) return;
    }
    if ((await readdir(subset.root)).length !== 0 || !sameDirectoryIdentity(subset.rootIdentity, await bigIntLstat(subset.root))) return;
    await (runtime.stagingIo?.rmdir ?? rmdir)(subset.root);
  } catch {
    // Stale state is preserved whenever validation, normalization, or cleanup is uncertain.
  }
}

async function inspectStaleRoot(root: string, pid: number, runtime: NativeLockAddonRuntime): Promise<void> {
  const subset = await snapshotStaleSafeSubset(root, pid);
  if (subset === undefined) return;
  const probe = runtime.probeProcess ?? ((candidatePid: number) => process.kill(candidatePid, 0));
  try {
    probe(pid);
    return;
  } catch (error) {
    if (errnoCode(error) !== "ESRCH") return;
  }
  if (runtime.beforeStaleCleanup) {
    try {
      await runtime.beforeStaleCleanup({
        root,
        stagedPath: subset.staged?.path,
        markerPath: subset.marker?.path,
        pid
      });
    } catch {
      return;
    }
  }
  if (!(await revalidateStaleSafeSubset(subset))) return;
  await cleanupStaleSafeSubset(subset, runtime);
}

async function performStaleStagingSweep(runtime: NativeLockAddonRuntime, base: string): Promise<void> {
  try {
    const baseStats = await bigIntLstat(base);
    validateDirectory(baseStats);
    const candidates: Array<{ root: string; pid: number; mtimeNs: bigint }> = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const pid = parseStagingPid(entry.name);
      if (pid === undefined) continue;
      const root = resolve(base, entry.name);
      try {
        const stats = await bigIntLstat(root);
        candidates.push({ root, pid, mtimeNs: stats.mtimeNs });
      } catch {
        // A disappearing candidate is preserved by doing nothing.
      }
    }
    candidates.sort((left, right) => left.mtimeNs < right.mtimeNs ? -1 : left.mtimeNs > right.mtimeNs ? 1 : 0);
    for (const candidate of candidates.slice(0, STALE_SWEEP_LIMIT)) {
      await inspectStaleRoot(candidate.root, candidate.pid, runtime);
    }
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    fail("ADDON_INTEGRITY");
  }
}

async function sweepStaleStaging(runtime: NativeLockAddonRuntime): Promise<void> {
  const base = stagingBase(runtime);
  const key = process.platform === "win32" ? base.toLowerCase() : base;
  const existing = stagingSweeps.get(key);
  if (existing !== undefined) return existing;
  const shared = Promise.resolve().then(() => performStaleStagingSweep(runtime, base));
  stagingSweeps.set(key, shared);
  try {
    await shared;
  } catch (error) {
    if (stagingSweeps.get(key) === shared) stagingSweeps.delete(key);
    throw error;
  }
}

async function withStagingSlot<T>(runtime: NativeLockAddonRuntime, operation: () => Promise<T>): Promise<T> {
  const key = stagingKey(runtime);
  const previous = stagingChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const chain = previous.then(() => gate);
  stagingChains.set(key, chain);
  await previous;
  try {
    if (preservedStagingRoots.has(key)) fail("ADDON_INTEGRITY");
    return await operation();
  } finally {
    release();
    if (stagingChains.get(key) === chain) stagingChains.delete(key);
  }
}

function loadWithProcessDlopen(modulePath: string): ProductionLoadedNativeModule {
  const holder = { exports: {} };
  process.dlopen(holder as unknown as NodeModule, modulePath);
  return { provenance: "production", holder, rawAddon: holder.exports };
}

function loadStagedModule(runtime: NativeLockAddonRuntime, modulePath: string): LoadedNativeModule {
  if (runtime.loadModule !== undefined) {
    return { provenance: "injected", rawAddon: runtime.loadModule(modulePath) };
  }
  return loadWithProcessDlopen(modulePath);
}

function cleanupOwnedStagingSync(lifecycle: StagingLifecycle): void {
  try {
    const root = lstatSync(lifecycle.root, { bigint: true }) as BigIntStats;
    if (!root.isDirectory() || root.isSymbolicLink() || !sameDirectoryIdentity(lifecycle.rootIdentity, root)) return;
    const expected = [basename(lifecycle.stagedPath), basename(lifecycle.markerPath)].sort();
    const entries = readdirSync(lifecycle.root, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
        entries.map((entry) => entry.name).sort().join("\0") !== expected.join("\0")) return;
    const marker = lstatSync(lifecycle.markerPath, { bigint: true }) as BigIntStats;
    const staged = lstatSync(lifecycle.stagedPath, { bigint: true }) as BigIntStats;
    if (lifecycle.markerIdentity === undefined || lifecycle.stagedIdentity === undefined ||
        !isOrdinaryUnlinkedFile(marker) || !isOrdinaryUnlinkedFile(staged) ||
        !sameFileIdentity(lifecycle.markerIdentity, marker) || !sameFileIdentity(lifecycle.stagedIdentity, staged)) return;
    const markerBytes = readFileSync(lifecycle.markerPath);
    const markerAfterRead = lstatSync(lifecycle.markerPath, { bigint: true }) as BigIntStats;
    const stagedBeforeRemoval = lstatSync(lifecycle.stagedPath, { bigint: true }) as BigIntStats;
    const rootBeforeRemoval = lstatSync(lifecycle.root, { bigint: true }) as BigIntStats;
    if (!markerBytes.equals(lifecycle.markerBytes) || !sameFileIdentity(marker, markerAfterRead) ||
        !sameFileIdentity(staged, stagedBeforeRemoval) || !sameDirectoryIdentity(root, rootBeforeRemoval) ||
        readdirSync(lifecycle.root).sort().join("\0") !== expected.join("\0")) return;
    unlinkSync(lifecycle.stagedPath);
    const markerBeforeRemoval = lstatSync(lifecycle.markerPath, { bigint: true }) as BigIntStats;
    if (!sameFileIdentity(markerAfterRead, markerBeforeRemoval)) return;
    unlinkSync(lifecycle.markerPath);
    if (readdirSync(lifecycle.root).length === 0) rmdirSync(lifecycle.root);
  } catch {
    // Exit cleanup is best effort; ambiguous or sharing-blocked state is preserved.
  }
}

function rawNativeCodes(error: unknown): string[] {
  const codes: string[] = [];
  if (typeof error === "object" && error !== null) {
    for (const key of ["code", "reason", "message"] as const) {
      const value = dataDescriptorValue(error, key);
      if (typeof value !== "string") continue;
      if (key === "code") codes.push(value);
      const match = /^([A-Z][A-Z0-9_]*):/u.exec(value);
      if (match !== null) codes.push(match[1]!);
    }
  }
  return codes;
}

function normalizeNativeError(error: unknown): NativeLockError {
  const codes = rawNativeCodes(error);
  if (codes.includes("UNSAFE_ANCHOR")) return new NativeLockError("UNSAFE_ANCHOR");
  const knownSafeBusyCodes = ["LOCK_BUSY", "EAGAIN", "EWOULDBLOCK", "ERROR_LOCK_VIOLATION", "ERROR_SHARING_VIOLATION"];
  if (codes.some((code) => knownSafeBusyCodes.includes(code))) return new NativeLockError("LOCK_BUSY");
  return new NativeLockError("NATIVE_LOCK_ERROR");
}

function invokeNative<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    throw normalizeNativeError(error);
  }
}

function dataMethod(value: object, property: PropertyKey, ownOnly = false): (...args: unknown[]) => unknown {
  const candidate = dataDescriptorValue(value, property, ownOnly);
  if (typeof candidate !== "function") fail(ownOnly ? "ADDON_ABI" : "NATIVE_LOCK_ERROR");
  return candidate as (...args: unknown[]) => unknown;
}

function wrapHandle(value: unknown): NativeLockHandle {
  if (!isObject(value)) fail("NATIVE_LOCK_ERROR");
  const protect = dataMethod(value, "protectCompatibilityDirectory");
  const releaseCompatibility = dataMethod(value, "releaseCompatibilityDirectory");
  const release = dataMethod(value, "release");
  return Object.freeze({
    protectCompatibilityDirectory(lockPath: string): void {
      invokeNative(() => Reflect.apply(protect, value, [lockPath]));
    },
    releaseCompatibilityDirectory(): void {
      invokeNative(() => Reflect.apply(releaseCompatibility, value, []));
    },
    release(): void {
      invokeNative(() => Reflect.apply(release, value, []));
    }
  });
}

function verifiedAddonExports(value: unknown, target: NativeLockTarget): {
  raw: Record<string, unknown>;
  implementation: "lockfileex" | "flock";
  acquire: (...args: unknown[]) => unknown;
  implementationMethod: (...args: unknown[]) => unknown;
} {
  if (!isObject(value)) fail("ADDON_ABI");
  if (dataDescriptorValue(value, "abiVersion", true) !== 1) fail("ADDON_ABI");
  const implementationMethod = dataMethod(value, "implementation", true);
  const acquire = dataMethod(value, "tryAcquireAnchor", true);
  let implementation: unknown;
  try {
    implementation = Reflect.apply(implementationMethod, value, []);
  } catch {
    fail("ADDON_ABI");
  }
  const expectedImplementation = target.platform === "win32" ? "lockfileex" : "flock";
  if (implementation !== expectedImplementation) fail("ADDON_ABI");
  return { raw: value, implementation: expectedImplementation, acquire, implementationMethod };
}

function wrapAddon(value: unknown, target: NativeLockTarget): NativeLockAddon {
  const verified = verifiedAddonExports(value, target);
  return Object.freeze({
    targetId: target.id,
    implementation: verified.implementation,
    tryAcquireAnchor(anchorPath: string): NativeLockHandle {
      return invokeNative(() => wrapHandle(Reflect.apply(verified.acquire, verified.raw, [anchorPath])));
    }
  });
}

function loaderStateFor(runtime: NativeLockAddonRuntime): LoaderState {
  if (runtime.loadModule === undefined) return productionLoaderState;
  const existing = injectedLoaderStates.get(runtime.loadModule);
  if (existing !== undefined) return existing;
  const created = createLoaderState();
  injectedLoaderStates.set(runtime.loadModule, created);
  return created;
}

function isExpectedWindowsSharingFailure(result: CleanupResult): boolean {
  return result.phase === "addon" && ["EPERM", "EACCES", "EBUSY"].includes(result.code ?? "");
}

function inspectProductionRetention(runtime: NativeLockAddonRuntime, loadedModule: ProductionLoadedNativeModule): void {
  if (runtime.inspectProductionRetention === undefined) return;
  try {
    runtime.inspectProductionRetention((candidate) =>
      retainedFailedModules.some((record) => record.loadedModule.holder === candidate) ||
      retainedLoads.some((record) => record.loadedModule.provenance === "production" && record.loadedModule.holder === candidate));
  } catch {
    fail("ADDON_INTEGRITY");
  }
}

function preserveWindowsMappedStaging(
  runtime: NativeLockAddonRuntime,
  target: NativeLockTarget,
  lifecycle: StagingLifecycle,
  loadedModule: LoadedNativeModule | undefined,
  retainFailure: boolean
): boolean {
  if (loadedModule?.provenance !== "production" || process.platform !== "win32" || target.platform !== "win32") return false;
  if (!poisonStagingSlot(runtime, lifecycle.root)) return false;
  if (retainFailure) {
    retainedFailedModules.push({ loadedModule, lifecycle });
    inspectProductionRetention(runtime, loadedModule);
  }
  process.once("exit", () => {
    void loadedModule.holder;
    cleanupOwnedStagingSync(lifecycle);
  });
  return true;
}

async function performStagedLoad(
  runtime: NativeLockAddonRuntime,
  target: NativeLockTarget,
  sourcePath: string,
  source: VerifiedSnapshot,
  sha256: string
): Promise<NativeLockAddon> {
  await sweepStaleStaging(runtime);
  return withStagingSlot(runtime, async () => {
    const { lifecycle } = await createStagingLifecycle(runtime, target, sourcePath, source.bytes, sha256);
    let loadedModule: LoadedNativeModule | undefined;
    let staged: VerifiedSnapshot | undefined;
    let nativeLoadSucceeded = false;
    try {
      if (runtime.beforeStagedLoad) {
        await runtime.beforeStagedLoad({
          root: lifecycle.root,
          sourcePath,
          stagedPath: lifecycle.stagedPath,
          markerPath: lifecycle.markerPath,
          targetId: target.id,
          sha256
        });
      }
      staged = await verifyStagingLifecycle(lifecycle, source.bytes);
      try {
        loadedModule = loadStagedModule(runtime, lifecycle.stagedPath);
        nativeLoadSucceeded = true;
      } catch {
        throw new NativeLockError("ADDON_ABI");
      }
      const addon = wrapAddon(loadedModule.rawAddon, target);
      const cleanup = await cleanupOwnedStaging(lifecycle, runtime.stagingIo);
      const production = loadedModule.provenance === "production";
      if (!cleanup.complete) {
        if (!(production && isExpectedWindowsSharingFailure(cleanup) && preserveWindowsMappedStaging(runtime, target, lifecycle, loadedModule, false))) {
          fail("ADDON_INTEGRITY");
        }
      } else if (production && process.platform !== "win32") {
        const verified = verifiedAddonExports(loadedModule.rawAddon, target);
        let implementation: unknown;
        try {
          implementation = Reflect.apply(verified.implementationMethod, verified.raw, []);
        } catch {
          fail("ADDON_INTEGRITY");
        }
        if (implementation !== verified.implementation) fail("ADDON_INTEGRITY");
      }
      retainedLoads.push({
        loadedModule,
        addon,
        source,
        staged,
        lifecycle
      });
      if (loadedModule.provenance === "production") inspectProductionRetention(runtime, loadedModule);
      return addon;
    } catch (error) {
      const cleanup = await cleanupOwnedStaging(lifecycle, runtime.stagingIo);
      if (!cleanup.complete) {
        const preserved = nativeLoadSucceeded && isExpectedWindowsSharingFailure(cleanup) &&
          preserveWindowsMappedStaging(runtime, target, lifecycle, loadedModule, true);
        if (!preserved) {
          poisonStagingSlot(runtime, lifecycle.root);
          fail("ADDON_INTEGRITY");
        }
      }
      if (error instanceof NativeLockError) throw error;
      fail(nativeLoadSucceeded ? "ADDON_ABI" : "ADDON_INTEGRITY");
    }
  });
}

export async function loadNativeLockAddon(runtime: NativeLockAddonRuntime = {}): Promise<NativeLockAddon> {
  const target = selectTarget(runtime);
  const assetsRoot = resolveAssetsRoot(runtime);
  const manifest = await readManifest(assetsRoot);
  const artifact = manifest.artifacts.find((entry) => entry.id === target.id);
  if (artifact === undefined) fail("ADDON_INTEGRITY");
  const artifactPath = resolve(assetsRoot, artifact.path);
  const pathKey = target.platform === "win32" ? artifactPath.toLowerCase() : artifactPath;
  const snapshot = await readVerifiedFile(artifactPath, ADDON_MAX_BYTES, "ADDON_MISSING", runtime.afterArtifactRead);
  if (artifact.bytes !== snapshot.bytes.length || artifact.sha256 !== createHash("sha256").update(snapshot.bytes).digest("hex")) {
    fail("ADDON_INTEGRITY");
  }

  const sourceIdentity = [
    snapshotIdentity(pathKey, snapshot.entry),
    target.id,
    artifact.bytes,
    artifact.sha256
  ].join("\0");
  const state = loaderStateFor(runtime);
  const inFlight = state.inFlight.get(pathKey);
  if (inFlight !== undefined) {
    if (inFlight.identity !== sourceIdentity) fail("ADDON_INTEGRITY");
    return inFlight.promise;
  }
  const boundIdentity = state.boundIdentities.get(pathKey);
  if (boundIdentity !== undefined && boundIdentity !== sourceIdentity) fail("ADDON_INTEGRITY");
  const cached = state.cache.get(sourceIdentity);
  if (cached !== undefined) return cached;

  let sharedPromise!: Promise<NativeLockAddon>;
  sharedPromise = Promise.resolve()
    .then(() => performStagedLoad(runtime, target, artifactPath, snapshot, artifact.sha256))
    .then((addon) => {
      state.boundIdentities.set(pathKey, sourceIdentity);
      state.cache.set(sourceIdentity, addon);
      return addon;
    })
    .finally(() => {
      if (state.inFlight.get(pathKey)?.promise === sharedPromise) state.inFlight.delete(pathKey);
    });
  state.inFlight.set(pathKey, { identity: sourceIdentity, promise: sharedPromise });
  return sharedPromise;
}
