import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOST_WORKSPACE_SCHEMA_ID = "tokengraph-host-workspace" as const;
const HOST_WORKSPACE_SCHEMA_VERSION = 1 as const;
const HOST_WORKSPACE_MAX_BYTES = 64 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const HOST_WORKSPACE_MAX_AGE_NS = 24n * 60n * 60n * 1_000_000_000n;
const HOST_WORKSPACE_FUTURE_TOLERANCE_NS = 5n * 60n * 1_000_000_000n;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface HostWorkspaceAttestation {
  schemaId: typeof HOST_WORKSPACE_SCHEMA_ID;
  schemaVersion: typeof HOST_WORKSPACE_SCHEMA_VERSION;
  pluginRootHash: string;
  sessionHash: string;
  root: string;
  updatedAt: string;
}

export type HostWorkspaceAttestationLoad =
  | { status: "valid"; root: string }
  | { status: "missing" | "invalid" | "unsupported" | "expired" | "mismatched" | "detached" | "unstable" };

export interface HostWorkspaceStatSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly birthtimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type Identity = HostWorkspaceStatSnapshot;

interface AttestationLocation {
  tempRoot: string;
  base: string;
  pluginDirectory: string;
  path: string;
  pluginRootHash: string;
  sessionHash: string;
}

interface ParentBindings {
  tempRoot: Identity;
  base: Identity;
  pluginDirectory: Identity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(stats: BigIntStats | HostWorkspaceStatSnapshot): Identity {
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

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameObject(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}

function sameRenamedFile(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

export function compareHostWorkspaceStatSnapshots(
  left: HostWorkspaceStatSnapshot,
  right: HostWorkspaceStatSnapshot,
  comparison: "file" | "directory" | "rename"
): boolean {
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  return comparison === "file" ? sameIdentity(leftIdentity, rightIdentity)
    : comparison === "directory" ? sameObject(leftIdentity, rightIdentity)
    : sameRenamedFile(leftIdentity, rightIdentity);
}

export const __compareHostWorkspaceStatsForTests = compareHostWorkspaceStatSnapshots;

async function ordinaryDirectory(path: string): Promise<Identity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unstable-host-parent");
  return identity(stats);
}

async function createDirectDirectory(parent: string, child: string): Promise<void> {
  const parentBefore = await ordinaryDirectory(parent);
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const [parentAfter] = await Promise.all([ordinaryDirectory(parent), ordinaryDirectory(child)]);
  if (!sameObject(parentBefore, parentAfter)) throw new Error("unstable-host-parent");
}

async function bindParents(locationValue: AttestationLocation): Promise<ParentBindings> {
  const [tempRoot, base, pluginDirectory] = await Promise.all([
    ordinaryDirectory(locationValue.tempRoot),
    ordinaryDirectory(locationValue.base),
    ordinaryDirectory(locationValue.pluginDirectory)
  ]);
  return { tempRoot, base, pluginDirectory };
}

async function validateParents(locationValue: AttestationLocation, expected: ParentBindings): Promise<void> {
  const current = await bindParents(locationValue);
  if (!sameObject(expected.tempRoot, current.tempRoot) || !sameObject(expected.base, current.base) ||
      !sameObject(expected.pluginDirectory, current.pluginDirectory)) throw new Error("unstable-host-parent");
}

async function location(pluginRoot: string, sessionId: string, createParents: boolean): Promise<AttestationLocation> {
  if (!validIdentifier(sessionId) || !isAbsolute(pluginRoot)) throw new Error("invalid-host-binding");
  const canonicalPluginRoot = await realpath(pluginRoot);
  const rawTemporaryRoot = resolve(tmpdir());
  const tempRoot = await realpath(rawTemporaryRoot);
  await ordinaryDirectory(tempRoot);
  const pluginRootHash = hash(canonicalPluginRoot);
  const sessionHash = hash(sessionId);
  const base = join(tempRoot, "tokengraph-host-workspaces");
  const pluginDirectory = join(base, pluginRootHash);
  if (createParents) {
    await createDirectDirectory(tempRoot, base);
    await createDirectDirectory(base, pluginDirectory);
  }
  return { tempRoot, base, pluginDirectory, path: join(pluginDirectory, `${sessionHash}.json`), pluginRootHash, sessionHash };
}

function reconstruct(value: unknown, expectedPluginHash: string, expectedSessionHash: string):
  | { status: "valid"; value: HostWorkspaceAttestation }
  | { status: "invalid" | "unsupported" | "mismatched" } {
  if (!isRecord(value)) return { status: "invalid" };
  if (value.schemaId === HOST_WORKSPACE_SCHEMA_ID && typeof value.schemaVersion === "number" && value.schemaVersion !== HOST_WORKSPACE_SCHEMA_VERSION) {
    return { status: "unsupported" };
  }
  const expected = ["pluginRootHash", "root", "schemaId", "schemaVersion", "sessionHash", "updatedAt"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return { status: "invalid" };
  if (value.schemaId !== HOST_WORKSPACE_SCHEMA_ID || value.schemaVersion !== HOST_WORKSPACE_SCHEMA_VERSION ||
      typeof value.pluginRootHash !== "string" || typeof value.sessionHash !== "string" ||
      !HASH_PATTERN.test(value.pluginRootHash) || !HASH_PATTERN.test(value.sessionHash)) return { status: "invalid" };
  if (value.pluginRootHash !== expectedPluginHash || value.sessionHash !== expectedSessionHash) return { status: "mismatched" };
  if (typeof value.root !== "string" || !isAbsolute(value.root) || typeof value.updatedAt !== "string") return { status: "invalid" };
  const timestamp = Date.parse(value.updatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.updatedAt) return { status: "invalid" };
  return { status: "valid", value: {
    schemaId: HOST_WORKSPACE_SCHEMA_ID, schemaVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    pluginRootHash: expectedPluginHash, sessionHash: expectedSessionHash,
    root: value.root, updatedAt: value.updatedAt
  } };
}

async function readBounded(path: string, parentBefore: Identity): Promise<{ text: string; entry: Identity }> {
  const entryStats = await lstat(path, { bigint: true });
  if (!entryStats.isFile() || entryStats.isSymbolicLink() || entryStats.nlink !== 1n) throw new Error("unstable-host-entry");
  const entryBefore = identity(entryStats);
  if (entryBefore.size < 0n || entryBefore.size > BigInt(HOST_WORKSPACE_MAX_BYTES)) throw new Error("invalid-host-size");
  try {
    return await readOpenedBounded(path, parentBefore, entryBefore);
  } catch (error) {
    // Only a genuine initial absence is missing; a disappearance seen after the read began is unstable.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("unstable-host-entry");
    throw error;
  }
}

async function readOpenedBounded(path: string, parentBefore: Identity, entryBefore: Identity): Promise<{ text: string; entry: Identity }> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const handleBeforeStats = await handle.stat({ bigint: true });
    const handleBefore = identity(handleBeforeStats);
    if (!handleBeforeStats.isFile() || handleBeforeStats.nlink !== 1n || !sameIdentity(entryBefore, handleBefore)) throw new Error("unstable-host-entry");
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, HOST_WORKSPACE_MAX_BYTES + 1 - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > HOST_WORKSPACE_MAX_BYTES) throw new Error("invalid-host-size");
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const [handleAfterStats, entryAfterStats, parentAfter] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }), ordinaryDirectory(resolve(path, ".."))
    ]);
    const handleAfter = identity(handleAfterStats);
    const entryAfter = identity(entryAfterStats);
    if (!entryAfterStats.isFile() || entryAfterStats.isSymbolicLink() || entryAfterStats.nlink !== 1n ||
        !sameIdentity(handleBefore, handleAfter) || !sameIdentity(entryBefore, entryAfter) ||
        !sameObject(parentBefore, parentAfter) || BigInt(bytesRead) !== handleAfter.size) throw new Error("unstable-host-entry");
    return { text: Buffer.concat(chunks, bytesRead).toString("utf8"), entry: entryAfter };
  } finally {
    await handle.close();
  }
}

async function loadAt(locationValue: AttestationLocation, now: Date): Promise<HostWorkspaceAttestationLoad & { entry?: Identity }> {
  let started = false;
  try {
    const [tempBefore, baseBefore, pluginBefore] = await Promise.all([
      ordinaryDirectory(locationValue.tempRoot), ordinaryDirectory(locationValue.base), ordinaryDirectory(locationValue.pluginDirectory)
    ]);
    const read = await readBounded(locationValue.path, pluginBefore);
    started = true;
    const [tempAfter, baseAfter, pluginAfter] = await Promise.all([
      ordinaryDirectory(locationValue.tempRoot), ordinaryDirectory(locationValue.base), ordinaryDirectory(locationValue.pluginDirectory)
    ]);
    if (!sameObject(tempBefore, tempAfter) || !sameObject(baseBefore, baseAfter) || !sameObject(pluginBefore, pluginAfter)) return { status: "unstable" };
    let parsed: unknown;
    try { parsed = JSON.parse(read.text) as unknown; } catch { return { status: "invalid" }; }
    const decoded = reconstruct(parsed, locationValue.pluginRootHash, locationValue.sessionHash);
    if (decoded.status !== "valid") return { status: decoded.status };
    const updatedAtNs = BigInt(Date.parse(decoded.value.updatedAt)) * NANOSECONDS_PER_MILLISECOND;
    const nowNs = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND;
    if (updatedAtNs < nowNs - HOST_WORKSPACE_MAX_AGE_NS || updatedAtNs > nowNs + HOST_WORKSPACE_FUTURE_TOLERANCE_NS) return { status: "expired", entry: read.entry };
    let canonicalRoot: string;
    // A same-binding attestation whose stored root is genuinely absent is
    // detached, not a binding mismatch. Any other resolution failure is
    // ambiguity, which stays unstable and never authorizes replacement or
    // removal.
    try {
      canonicalRoot = await realpath(decoded.value.root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { status: "detached", entry: read.entry }
        : { status: "unstable" };
    }
    if (canonicalRoot !== decoded.value.root) return { status: "mismatched" };
    return { status: "valid", root: canonicalRoot, entry: read.entry };
  } catch (error) {
    if (!started && (error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    if (error instanceof Error && error.message === "invalid-host-size") return { status: "invalid" };
    return { status: "unstable" };
  }
}

async function writeExclusiveAtomic(locationValue: AttestationLocation, value: HostWorkspaceAttestation): Promise<void> {
  const parents = await bindParents(locationValue);
  const existing = await loadAt(locationValue, new Date());
  if (!["missing", "valid", "expired", "detached"].includes(existing.status)) throw new Error("unsafe-host-attestation");
  await validateParents(locationValue, parents);
  const temporary = join(locationValue.pluginDirectory, `.tg-host-${locationValue.sessionHash}-${process.pid}-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > HOST_WORKSPACE_MAX_BYTES) throw new Error("invalid-host-size");
  let createdIdentity: Identity | undefined;
  let temporaryIdentity: Identity | undefined;
  let published = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      // The exclusively created entry is owned from this point, so a later failure can still clean it up.
      createdIdentity = identity(await handle.stat({ bigint: true }));
      await handle.writeFile(bytes);
      await handle.sync();
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || stats.nlink !== 1n) throw new Error("unstable-host-temporary");
      temporaryIdentity = identity(stats);
    } finally {
      await handle.close();
    }
    const tempEntry = await lstat(temporary, { bigint: true });
    if (!tempEntry.isFile() || tempEntry.isSymbolicLink() || tempEntry.nlink !== 1n ||
        !sameIdentity(temporaryIdentity, identity(tempEntry))) throw new Error("unstable-host-temporary");
    await validateParents(locationValue, parents);
    const current = await loadAt(locationValue, new Date());
    if (existing.status === "missing") {
      if (current.status !== "missing") throw new Error("unstable-host-replacement");
    } else if (!["valid", "expired", "detached"].includes(current.status) || !existing.entry || !current.entry ||
        !sameIdentity(existing.entry, current.entry)) {
      throw new Error("unstable-host-replacement");
    }
    await validateParents(locationValue, parents);
    if (current.status === "missing") {
      await link(temporary, locationValue.path);
      const [linkedTemporary, linkedTarget] = await Promise.all([
        lstat(temporary, { bigint: true }), lstat(locationValue.path, { bigint: true })
      ]);
      const linkedIdentity = { ...temporaryIdentity, nlink: 2n };
      if (!linkedTemporary.isFile() || linkedTemporary.isSymbolicLink() || linkedTemporary.nlink !== 2n ||
          !linkedTarget.isFile() || linkedTarget.isSymbolicLink() || linkedTarget.nlink !== 2n ||
          !sameRenamedFile(linkedIdentity, identity(linkedTemporary)) || !sameIdentity(identity(linkedTemporary), identity(linkedTarget))) {
        throw new Error("unstable-host-replacement");
      }
      await validateParents(locationValue, parents);
      await unlink(temporary);
    } else {
      await rename(temporary, locationValue.path);
    }
    published = true;
    const target = await lstat(locationValue.path, { bigint: true });
    const targetIdentity = identity(target);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n || !sameRenamedFile(temporaryIdentity, targetIdentity)) {
      throw new Error("unstable-host-replacement");
    }
    await validateParents(locationValue, parents);
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const directory = await open(locationValue.pluginDirectory, fsConstants.O_RDONLY | noFollow);
    try { await directory.sync(); } catch (error) {
      if (!(["EINVAL", "ENOTSUP", "EBADF", "EPERM"] as string[]).includes(String((error as NodeJS.ErrnoException).code))) throw error;
    } finally { await directory.close(); }
  } catch (error) {
    if (!published && createdIdentity) {
      try {
        await validateParents(locationValue, parents);
        const current = await lstat(temporary, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && sameObject(createdIdentity, identity(current))) {
          await unlink(temporary);
        }
      } catch { /* Preserve ambiguous temporary evidence. */ }
    }
    throw error;
  }
}

export async function attestHostWorkspace(pluginRoot: string, sessionId: string, workspaceRoot: string, now = new Date()): Promise<void> {
  if (!isAbsolute(workspaceRoot)) throw new Error("invalid-host-workspace");
  const [locationValue, canonicalRoot] = await Promise.all([location(pluginRoot, sessionId, true), realpath(workspaceRoot)]);
  await ordinaryDirectory(canonicalRoot);
  await writeExclusiveAtomic(locationValue, {
    schemaId: HOST_WORKSPACE_SCHEMA_ID, schemaVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    pluginRootHash: locationValue.pluginRootHash, sessionHash: locationValue.sessionHash,
    root: canonicalRoot, updatedAt: now.toISOString()
  });
}

export async function loadHostWorkspaceAttestation(pluginRoot: string, sessionId: string, now = new Date()): Promise<HostWorkspaceAttestationLoad> {
  let locationValue: AttestationLocation;
  try { locationValue = await location(pluginRoot, sessionId, false); } catch { return { status: "unstable" }; }
  const loaded = await loadAt(locationValue, now);
  return loaded.status === "valid" ? { status: "valid", root: loaded.root } : { status: loaded.status };
}

export async function removeHostWorkspaceAttestation(pluginRoot: string, sessionId: string): Promise<boolean> {
  const locationValue = await location(pluginRoot, sessionId, false);
  const parents = await bindParents(locationValue);
  const loaded = await loadAt(locationValue, new Date());
  if (loaded.status === "missing") return false;
  if (!["valid", "expired", "detached"].includes(loaded.status) || !loaded.entry) throw new Error("unsafe-host-attestation");
  const current = await lstat(locationValue.path, { bigint: true });
  if (!sameIdentity(loaded.entry, identity(current)) || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n) throw new Error("unstable-host-removal");
  await validateParents(locationValue, parents);
  await unlink(locationValue.path);
  await validateParents(locationValue, parents);
  return true;
}
