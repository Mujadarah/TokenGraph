#!/usr/bin/env node

// src/hooks.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { constants as fsConstants3 } from "node:fs";
import { link as link2, lstat as lstat3, mkdir as mkdir2, open as open3, readdir as readdir2, realpath as realpath2, rename as rename3, unlink as unlink2 } from "node:fs/promises";
import { isAbsolute as isAbsolute3, join as join3, relative } from "node:path";

// src/core/taskEstimator.ts
var TASK_ESTIMATOR_VERSION = "task-estimator-v2";
function formatTaskReportFooter(report) {
  if (report.eventCount === 0) {
    return "TokenGraph: savings not measured (no qualifying task events).";
  }
  const formatRange = (range) => {
    const { low, high } = range;
    const formatValue = (value) => Number.isInteger(value) ? `${value}` : `${Number(value.toFixed(1))}`;
    return low === high ? formatValue(low) : low < 0 && high >= 0 ? `${formatValue(low)} to ${formatValue(high)}` : `${formatValue(low)}-${formatValue(high)}`;
  };
  const savings = formatRange(report.estimate.range);
  const quality = report.quality.status === "not_evaluated" ? "not evaluated" : report.quality.status;
  const aggregateFooter = `TokenGraph: ~${savings} tokens saved (estimated, ${report.estimate.confidence} confidence); quality ${quality}.`;
  const categoryText = report.categories.map((entry) => `${entry.category}=~${formatRange(entry.range)} (${entry.basis.join(",")})`).join("; ");
  return `${aggregateFooter.slice(0, -1)}; categories ${categoryText}.`;
}

// src/core/hostWorkspace.ts
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
var HOST_WORKSPACE_SCHEMA_ID = "tokengraph-host-workspace";
var HOST_WORKSPACE_SCHEMA_VERSION = 1;
var HOST_WORKSPACE_MAX_BYTES = 64 * 1024;
var NANOSECONDS_PER_MILLISECOND = 1000000n;
var HOST_WORKSPACE_MAX_AGE_NS = 24n * 60n * 60n * 1000000000n;
var HOST_WORKSPACE_FUTURE_TOLERANCE_NS = 5n * 60n * 1000000000n;
var HASH_PATTERN = /^[0-9a-f]{64}$/;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function identity(stats) {
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
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}
function sameRenamedFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
function sameCreatedFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}
function compareHostWorkspaceStatSnapshots(left, right, comparison) {
  const leftIdentity = identity(left);
  const rightIdentity = identity(right);
  return comparison === "file" ? sameIdentity(leftIdentity, rightIdentity) : comparison === "directory" ? sameObject(leftIdentity, rightIdentity) : comparison === "created" ? sameCreatedFile(leftIdentity, rightIdentity) : sameRenamedFile(leftIdentity, rightIdentity);
}
async function ordinaryDirectory(path) {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unstable-host-parent");
  return identity(stats);
}
async function createDirectDirectory(parent, child) {
  const parentBefore = await ordinaryDirectory(parent);
  try {
    await mkdir(child, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const [parentAfter] = await Promise.all([ordinaryDirectory(parent), ordinaryDirectory(child)]);
  if (!sameObject(parentBefore, parentAfter)) throw new Error("unstable-host-parent");
}
async function bindParents(locationValue) {
  const [tempRoot, base, pluginDirectory] = await Promise.all([
    ordinaryDirectory(locationValue.tempRoot),
    ordinaryDirectory(locationValue.base),
    ordinaryDirectory(locationValue.pluginDirectory)
  ]);
  return { tempRoot, base, pluginDirectory };
}
async function validateParents(locationValue, expected) {
  const current = await bindParents(locationValue);
  if (!sameObject(expected.tempRoot, current.tempRoot) || !sameObject(expected.base, current.base) || !sameObject(expected.pluginDirectory, current.pluginDirectory)) throw new Error("unstable-host-parent");
}
async function location(pluginRoot, sessionId, createParents) {
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
function reconstruct(value, expectedPluginHash, expectedSessionHash) {
  if (!isRecord(value)) return { status: "invalid" };
  if (value.schemaId === HOST_WORKSPACE_SCHEMA_ID && typeof value.schemaVersion === "number" && value.schemaVersion !== HOST_WORKSPACE_SCHEMA_VERSION) {
    return { status: "unsupported" };
  }
  const expected = ["pluginRootHash", "root", "schemaId", "schemaVersion", "sessionHash", "updatedAt"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return { status: "invalid" };
  if (value.schemaId !== HOST_WORKSPACE_SCHEMA_ID || value.schemaVersion !== HOST_WORKSPACE_SCHEMA_VERSION || typeof value.pluginRootHash !== "string" || typeof value.sessionHash !== "string" || !HASH_PATTERN.test(value.pluginRootHash) || !HASH_PATTERN.test(value.sessionHash)) return { status: "invalid" };
  if (value.pluginRootHash !== expectedPluginHash || value.sessionHash !== expectedSessionHash) return { status: "mismatched" };
  if (typeof value.root !== "string" || !isAbsolute(value.root) || typeof value.updatedAt !== "string") return { status: "invalid" };
  const timestamp = Date.parse(value.updatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.updatedAt) return { status: "invalid" };
  return { status: "valid", value: {
    schemaId: HOST_WORKSPACE_SCHEMA_ID,
    schemaVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    pluginRootHash: expectedPluginHash,
    sessionHash: expectedSessionHash,
    root: value.root,
    updatedAt: value.updatedAt
  } };
}
async function readBounded(path, parentBefore) {
  const entryStats = await lstat(path, { bigint: true });
  if (!entryStats.isFile() || entryStats.isSymbolicLink() || entryStats.nlink !== 1n) throw new Error("unstable-host-entry");
  const entryBefore = identity(entryStats);
  if (entryBefore.size < 0n || entryBefore.size > BigInt(HOST_WORKSPACE_MAX_BYTES)) throw new Error("invalid-host-size");
  try {
    return await readOpenedBounded(path, parentBefore, entryBefore);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("unstable-host-entry");
    throw error;
  }
}
async function readOpenedBounded(path, parentBefore, entryBefore) {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const handleBeforeStats = await handle.stat({ bigint: true });
    const handleBefore = identity(handleBeforeStats);
    if (!handleBeforeStats.isFile() || handleBeforeStats.nlink !== 1n || !sameIdentity(entryBefore, handleBefore)) throw new Error("unstable-host-entry");
    const chunks = [];
    let bytesRead = 0;
    for (; ; ) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, HOST_WORKSPACE_MAX_BYTES + 1 - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > HOST_WORKSPACE_MAX_BYTES) throw new Error("invalid-host-size");
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const [handleAfterStats, entryAfterStats, parentAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      ordinaryDirectory(resolve(path, ".."))
    ]);
    const handleAfter = identity(handleAfterStats);
    const entryAfter = identity(entryAfterStats);
    if (!entryAfterStats.isFile() || entryAfterStats.isSymbolicLink() || entryAfterStats.nlink !== 1n || !sameIdentity(handleBefore, handleAfter) || !sameIdentity(entryBefore, entryAfter) || !sameObject(parentBefore, parentAfter) || BigInt(bytesRead) !== handleAfter.size) throw new Error("unstable-host-entry");
    return { text: Buffer.concat(chunks, bytesRead).toString("utf8"), entry: entryAfter };
  } finally {
    await handle.close();
  }
}
async function loadAt(locationValue, now) {
  let started = false;
  try {
    const [tempBefore, baseBefore, pluginBefore] = await Promise.all([
      ordinaryDirectory(locationValue.tempRoot),
      ordinaryDirectory(locationValue.base),
      ordinaryDirectory(locationValue.pluginDirectory)
    ]);
    const read = await readBounded(locationValue.path, pluginBefore);
    started = true;
    const [tempAfter, baseAfter, pluginAfter] = await Promise.all([
      ordinaryDirectory(locationValue.tempRoot),
      ordinaryDirectory(locationValue.base),
      ordinaryDirectory(locationValue.pluginDirectory)
    ]);
    if (!sameObject(tempBefore, tempAfter) || !sameObject(baseBefore, baseAfter) || !sameObject(pluginBefore, pluginAfter)) return { status: "unstable" };
    let parsed;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return { status: "invalid" };
    }
    const decoded = reconstruct(parsed, locationValue.pluginRootHash, locationValue.sessionHash);
    if (decoded.status !== "valid") return { status: decoded.status };
    const updatedAtNs = BigInt(Date.parse(decoded.value.updatedAt)) * NANOSECONDS_PER_MILLISECOND;
    const nowNs = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND;
    if (updatedAtNs < nowNs - HOST_WORKSPACE_MAX_AGE_NS || updatedAtNs > nowNs + HOST_WORKSPACE_FUTURE_TOLERANCE_NS) return { status: "expired", entry: read.entry };
    let canonicalRoot;
    try {
      canonicalRoot = await realpath(decoded.value.root);
    } catch (error) {
      const code = error.code;
      return code === "ENOENT" || code === "ENOTDIR" ? { status: "detached", entry: read.entry } : { status: "unstable" };
    }
    if (canonicalRoot !== decoded.value.root) return { status: "mismatched" };
    return { status: "valid", root: canonicalRoot, entry: read.entry };
  } catch (error) {
    if (!started && error.code === "ENOENT") return { status: "missing" };
    if (error instanceof Error && error.message === "invalid-host-size") return { status: "invalid" };
    return { status: "unstable" };
  }
}
async function writeExclusiveAtomic(locationValue, value) {
  const parents = await bindParents(locationValue);
  const existing = await loadAt(locationValue, /* @__PURE__ */ new Date());
  if (!["missing", "valid", "expired", "detached"].includes(existing.status)) throw new Error("unsafe-host-attestation");
  await validateParents(locationValue, parents);
  const temporary = join(locationValue.pluginDirectory, `.tg-host-${locationValue.sessionHash}-${process.pid}-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}
`, "utf8");
  if (bytes.length > HOST_WORKSPACE_MAX_BYTES) throw new Error("invalid-host-size");
  let createdIdentity;
  let temporaryIdentity;
  let published = false;
  try {
    const handle = await open(temporary, "wx", 384);
    try {
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
    if (!tempEntry.isFile() || tempEntry.isSymbolicLink() || tempEntry.nlink !== 1n || !sameIdentity(temporaryIdentity, identity(tempEntry))) throw new Error("unstable-host-temporary");
    await validateParents(locationValue, parents);
    const current = await loadAt(locationValue, /* @__PURE__ */ new Date());
    if (existing.status === "missing") {
      if (current.status !== "missing") throw new Error("unstable-host-replacement");
    } else if (!["valid", "expired", "detached"].includes(current.status) || !existing.entry || !current.entry || !sameIdentity(existing.entry, current.entry)) {
      throw new Error("unstable-host-replacement");
    }
    await validateParents(locationValue, parents);
    if (current.status === "missing") {
      await link(temporary, locationValue.path);
      const [linkedTemporary, linkedTarget] = await Promise.all([
        lstat(temporary, { bigint: true }),
        lstat(locationValue.path, { bigint: true })
      ]);
      const linkedIdentity = { ...temporaryIdentity, nlink: 2n };
      if (!linkedTemporary.isFile() || linkedTemporary.isSymbolicLink() || linkedTemporary.nlink !== 2n || !linkedTarget.isFile() || linkedTarget.isSymbolicLink() || linkedTarget.nlink !== 2n || !sameRenamedFile(linkedIdentity, identity(linkedTemporary)) || !sameIdentity(identity(linkedTemporary), identity(linkedTarget))) {
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
    try {
      await directory.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(String(error.code))) throw error;
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!published && createdIdentity) {
      try {
        await validateParents(locationValue, parents);
        const current = await lstat(temporary, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && sameCreatedFile(createdIdentity, identity(current))) {
          await unlink(temporary);
        }
      } catch {
      }
    }
    throw error;
  }
}
async function attestHostWorkspace(pluginRoot, sessionId, workspaceRoot, now = /* @__PURE__ */ new Date()) {
  if (!isAbsolute(workspaceRoot)) throw new Error("invalid-host-workspace");
  const [locationValue, canonicalRoot] = await Promise.all([location(pluginRoot, sessionId, true), realpath(workspaceRoot)]);
  await ordinaryDirectory(canonicalRoot);
  await writeExclusiveAtomic(locationValue, {
    schemaId: HOST_WORKSPACE_SCHEMA_ID,
    schemaVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    pluginRootHash: locationValue.pluginRootHash,
    sessionHash: locationValue.sessionHash,
    root: canonicalRoot,
    updatedAt: now.toISOString()
  });
}
async function loadHostWorkspaceAttestation(pluginRoot, sessionId, now = /* @__PURE__ */ new Date()) {
  let locationValue;
  try {
    locationValue = await location(pluginRoot, sessionId, false);
  } catch {
    return { status: "unstable" };
  }
  const loaded = await loadAt(locationValue, now);
  return loaded.status === "valid" ? { status: "valid", root: loaded.root } : { status: loaded.status };
}
async function removeHostWorkspaceAttestation(pluginRoot, sessionId) {
  const locationValue = await location(pluginRoot, sessionId, false);
  const parents = await bindParents(locationValue);
  const loaded = await loadAt(locationValue, /* @__PURE__ */ new Date());
  if (loaded.status === "missing") return false;
  if (!["valid", "expired", "detached"].includes(loaded.status) || !loaded.entry) throw new Error("unsafe-host-attestation");
  const current = await lstat(locationValue.path, { bigint: true });
  if (!sameIdentity(loaded.entry, identity(current)) || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n) throw new Error("unstable-host-removal");
  await validateParents(locationValue, parents);
  await unlink(locationValue.path);
  await validateParents(locationValue, parents);
  return true;
}

// src/core/taskLedger.ts
import { constants as fsConstants2 } from "node:fs";
import { lstat as lstat2, open as open2, readFile, readdir, rename as rename2, rm } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join2, parse, resolve as resolve2 } from "node:path";
var TASK_LEDGER_SCHEMA_ID = "tokengraph-task-ledger";
var TASK_LEDGER_SCHEMA_VERSION = 3;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var MAX_READ_ONLY_LEDGER_BYTES = 8 * 1024 * 1024;
var CURRENT_LEDGER_KEYS = /* @__PURE__ */ new Set([
  "schemaId",
  "schemaVersion",
  "taskId",
  "host",
  "sessionId",
  "turnId",
  "status",
  "createdAt",
  "updatedAt",
  "pausedAt",
  "completedAt",
  "estimatorVersion",
  "repositoryIdentity",
  "routingObservation",
  "readPolicy",
  "deliveredArtifacts",
  "outcomes",
  "events",
  "lastDisposition",
  "completedReport"
]);
var REQUIRED_CURRENT_LEDGER_KEYS = [
  "schemaId",
  "schemaVersion",
  "taskId",
  "host",
  "status",
  "createdAt",
  "updatedAt",
  "estimatorVersion",
  "deliveredArtifacts",
  "outcomes",
  "events"
];
function stablePathIdentity(stats) {
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
function sameStableIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function sameStableDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}
async function snapshotLedgerPath(path) {
  const absolute = resolve2(path);
  const root = parse(absolute).root;
  const remainder = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  const identities = [];
  let current = root;
  for (let index = 0; index < remainder.length; index += 1) {
    current = join2(current, remainder[index]);
    const stats = await lstat2(current, { bigint: true });
    const kind = index === remainder.length - 1 ? "file" : "directory";
    if (stats.isSymbolicLink() || (kind === "file" ? !stats.isFile() || stats.nlink !== 1n : !stats.isDirectory())) {
      throw new Error("unstable-ledger-path");
    }
    identities.push({ kind, identity: stablePathIdentity(stats) });
  }
  return identities;
}
function samePathSnapshot(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return entry.kind === candidate.kind && (entry.kind === "file" ? sameStableIdentity(entry.identity, candidate.identity) : sameStableDirectory(entry.identity, candidate.identity));
  });
}
async function readStableTaskLedger(path) {
  const before = await snapshotLedgerPath(path);
  const entryBefore = before.at(-1).identity;
  if (entryBefore.size < 0n || entryBefore.size > BigInt(MAX_READ_ONLY_LEDGER_BYTES)) throw new Error("invalid-ledger-size");
  try {
    return await readOpenedTaskLedger(path, before, entryBefore);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("unstable-ledger-read");
    throw error;
  }
}
async function readOpenedTaskLedger(path, before, entryBefore) {
  const noFollow = "O_NOFOLLOW" in fsConstants2 ? fsConstants2.O_NOFOLLOW : 0;
  const handle = await open2(path, fsConstants2.O_RDONLY | noFollow);
  try {
    const handleBefore = await handle.stat({ bigint: true });
    const openedBefore = stablePathIdentity(handleBefore);
    if (!handleBefore.isFile() || handleBefore.nlink !== 1n || !sameStableIdentity(entryBefore, openedBefore)) {
      throw new Error("unstable-ledger-identity");
    }
    const chunks = [];
    let bytesRead = 0;
    for (; ; ) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_READ_ONLY_LEDGER_BYTES + 1 - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > MAX_READ_ONLY_LEDGER_BYTES) throw new Error("invalid-ledger-size");
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const handleAfter = stablePathIdentity(await handle.stat({ bigint: true }));
    const after = await snapshotLedgerPath(path);
    if (!sameStableIdentity(openedBefore, handleAfter) || !samePathSnapshot(before, after) || BigInt(bytesRead) !== handleAfter.size) {
      throw new Error("unstable-ledger-read");
    }
    return Buffer.concat(chunks, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function hasExactKeys(value, required, optional = []) {
  if (!isRecord2(value)) return false;
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}
function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isLiteral(value, allowed) {
  return typeof value === "string" && allowed.includes(value);
}
function decodeCurrentRepositoryIdentity(value) {
  const required = ["repositoryId", "repositoryFingerprint", "workspaceId", "worktreeId", "branch", "headCommit"];
  if (!hasExactKeys(value, required, ["remoteIdentity"]) || !required.every((key) => isIdentifier(value[key])) || value.remoteIdentity !== void 0 && !isIdentifier(value.remoteIdentity)) return void 0;
  return {
    repositoryId: value.repositoryId,
    repositoryFingerprint: value.repositoryFingerprint,
    workspaceId: value.workspaceId,
    worktreeId: value.worktreeId,
    branch: value.branch,
    headCommit: value.headCommit,
    ...value.remoteIdentity === void 0 ? {} : { remoteIdentity: value.remoteIdentity }
  };
}
function decodeCurrentRoutingObservation(value) {
  if (!hasExactKeys(value, ["decision", "stage", "reason", "expectedOverheadTokens", "mode", "enforced"]) || value.decision !== "activate" && value.decision !== "bypass" || !Number.isInteger(value.stage) || value.stage < 0 || typeof value.reason !== "string" || !finiteNonnegative(value.expectedOverheadTokens) || !isLiteral(value.mode, ["shadow", "enforced", "always-activate", "always-advisory"]) || typeof value.enforced !== "boolean") return void 0;
  return {
    decision: value.decision,
    stage: value.stage,
    reason: value.reason,
    expectedOverheadTokens: value.expectedOverheadTokens,
    mode: value.mode,
    enforced: value.enforced
  };
}
function decodeCurrentReadPolicy(value) {
  if (!hasExactKeys(value, ["level", "allowRawReads", "reason"], [
    "targetedReads",
    "recommendedReadsThisResponse",
    "requiresReassessment",
    "hasReassessed",
    "evidenceGap"
  ]) || !isLiteral(value.level, ["L0", "L1", "L2", "L3", "L4"]) || typeof value.allowRawReads !== "boolean" || typeof value.reason !== "string" || value.targetedReads !== void 0 && (!Number.isInteger(value.targetedReads) || value.targetedReads < 0) || value.recommendedReadsThisResponse !== void 0 && (!Number.isInteger(value.recommendedReadsThisResponse) || value.recommendedReadsThisResponse < 0) || value.requiresReassessment !== void 0 && typeof value.requiresReassessment !== "boolean" || value.hasReassessed !== void 0 && typeof value.hasReassessed !== "boolean" || value.evidenceGap !== void 0 && typeof value.evidenceGap !== "string") return void 0;
  return {
    level: value.level,
    allowRawReads: value.allowRawReads,
    reason: value.reason,
    ...value.targetedReads === void 0 ? {} : { targetedReads: value.targetedReads },
    ...value.recommendedReadsThisResponse === void 0 ? {} : { recommendedReadsThisResponse: value.recommendedReadsThisResponse },
    ...value.requiresReassessment === void 0 ? {} : { requiresReassessment: value.requiresReassessment },
    ...value.hasReassessed === void 0 ? {} : { hasReassessed: value.hasReassessed },
    ...value.evidenceGap === void 0 ? {} : { evidenceGap: value.evidenceGap }
  };
}
function decodeCurrentQualityCheck(value) {
  if (!hasExactKeys(value, ["name", "passed"]) || typeof value.name !== "string" || typeof value.passed !== "boolean") return void 0;
  return { name: value.name, passed: value.passed };
}
function decodeCurrentEvent(value) {
  if (!hasExactKeys(value, [
    "id",
    "fingerprint",
    "category",
    "toolName",
    "originalTokens",
    "compactTokens",
    "overheadTokens",
    "confidence",
    "timestamp",
    "qualityChecks"
  ]) || typeof value.id !== "string" || typeof value.fingerprint !== "string" || typeof value.category !== "string" || typeof value.toolName !== "string" || !finiteNonnegative(value.originalTokens) || !finiteNonnegative(value.compactTokens) || !finiteNonnegative(value.overheadTokens) || !isLiteral(value.confidence, ["low", "medium", "high"]) || !isTimestamp(value.timestamp) || !Array.isArray(value.qualityChecks)) return void 0;
  const qualityChecks = value.qualityChecks.map(decodeCurrentQualityCheck);
  if (qualityChecks.some((entry) => entry === void 0)) return void 0;
  return {
    id: value.id,
    fingerprint: value.fingerprint,
    category: value.category,
    toolName: value.toolName,
    originalTokens: value.originalTokens,
    compactTokens: value.compactTokens,
    overheadTokens: value.overheadTokens,
    confidence: value.confidence,
    timestamp: value.timestamp,
    qualityChecks
  };
}
function decodeCurrentOutcome(value, expectedTaskId) {
  if (!hasExactKeys(value, [
    "id",
    "taskId",
    "summary",
    "status",
    "evidence",
    "createdAt",
    "branch",
    "worktreeId",
    "headCommit"
  ], ["staleAt", "sourceFingerprint"]) || !isIdentifier(value.id) || value.taskId !== expectedTaskId || typeof value.summary !== "string" || value.summary.trim().length === 0 || !isLiteral(value.status, ["verified", "proposed", "failed"]) || !Array.isArray(value.evidence) || !value.evidence.every(isIdentifier) || !isTimestamp(value.createdAt) || value.staleAt !== void 0 && !isTimestamp(value.staleAt) || value.sourceFingerprint !== void 0 && !isIdentifier(value.sourceFingerprint) || !isIdentifier(value.branch) || !isIdentifier(value.worktreeId) || !isIdentifier(value.headCommit)) return void 0;
  return {
    id: value.id,
    taskId: value.taskId,
    summary: value.summary,
    status: value.status,
    evidence: [...value.evidence],
    createdAt: value.createdAt,
    ...value.staleAt === void 0 ? {} : { staleAt: value.staleAt },
    ...value.sourceFingerprint === void 0 ? {} : { sourceFingerprint: value.sourceFingerprint },
    branch: value.branch,
    worktreeId: value.worktreeId,
    headCommit: value.headCommit
  };
}
function decodeCurrentRange(value) {
  if (!hasExactKeys(value, ["low", "likely", "high", "unit"]) || typeof value.low !== "number" || !Number.isFinite(value.low) || typeof value.likely !== "number" || !Number.isFinite(value.likely) || typeof value.high !== "number" || !Number.isFinite(value.high) || value.low > value.likely || value.likely > value.high || value.unit !== "estimated_tokens") return void 0;
  return { low: value.low, likely: value.likely, high: value.high, unit: "estimated_tokens" };
}
function decodeCurrentTaskReport(value, expectedTaskId, expectedEventCount) {
  if (!hasExactKeys(value, ["taskId", "eventCount", "estimate", "categories", "quality"]) || value.taskId !== expectedTaskId || value.eventCount !== expectedEventCount || !Number.isInteger(value.eventCount) || !Array.isArray(value.categories) || !hasExactKeys(value.estimate, ["range", "confidence", "basis", "overhead", "estimatorVersion"]) || !hasExactKeys(value.quality, ["status", "checks"])) return void 0;
  const estimateRange = decodeCurrentRange(value.estimate.range);
  if (!estimateRange || !isLiteral(value.estimate.confidence, ["low", "medium", "high"]) || !stringArray(value.estimate.basis) || !finiteNonnegative(value.estimate.overhead) || value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION || !isLiteral(value.quality.status, ["passed", "warning", "not_evaluated"]) || !stringArray(value.quality.checks)) return void 0;
  const categories = value.categories.map((category) => {
    if (!hasExactKeys(category, ["category", "eventCount", "range", "confidence", "basis", "overhead"]) || !isIdentifier(category.category) || !Number.isInteger(category.eventCount) || category.eventCount < 1 || !isLiteral(category.confidence, ["low", "medium", "high"]) || !stringArray(category.basis) || !finiteNonnegative(category.overhead)) return void 0;
    const range = decodeCurrentRange(category.range);
    if (!range) return void 0;
    return {
      category: category.category,
      eventCount: category.eventCount,
      range,
      confidence: category.confidence,
      basis: [...category.basis],
      overhead: category.overhead
    };
  });
  if (categories.some((entry) => entry === void 0)) return void 0;
  const exactCategories = categories;
  if (exactCategories.reduce((count, entry) => count + entry.eventCount, 0) !== expectedEventCount || exactCategories.some((entry, index) => index > 0 && exactCategories[index - 1].category.localeCompare(entry.category) >= 0)) return void 0;
  return {
    taskId: value.taskId,
    eventCount: value.eventCount,
    estimate: {
      range: estimateRange,
      confidence: value.estimate.confidence,
      basis: [...value.estimate.basis],
      overhead: value.estimate.overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    categories: exactCategories,
    quality: { status: value.quality.status, checks: [...value.quality.checks] }
  };
}
function decodeCurrentTaskLedger(value, expectedTaskId) {
  if (!hasExactKeys(value, REQUIRED_CURRENT_LEDGER_KEYS, [...CURRENT_LEDGER_KEYS].filter((key) => !REQUIRED_CURRENT_LEDGER_KEYS.includes(key))) || value.schemaId !== TASK_LEDGER_SCHEMA_ID || value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || value.taskId !== expectedTaskId || !isLiteral(value.host, ["codex", "claude", "unknown"]) || !isLiteral(value.status, ["open", "paused", "completed", "quarantined"]) || !isOptionalIdentifier(value.sessionId) || !isOptionalIdentifier(value.turnId) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.pausedAt !== void 0 && !isTimestamp(value.pausedAt) || value.completedAt !== void 0 && !isTimestamp(value.completedAt) || value.estimatorVersion !== TASK_ESTIMATOR_VERSION || !Array.isArray(value.deliveredArtifacts) || !value.deliveredArtifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) || !Array.isArray(value.outcomes) || !Array.isArray(value.events) || value.lastDisposition !== void 0 && value.lastDisposition !== "pause" && value.lastDisposition !== "complete" || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && (Date.parse(value.pausedAt) < Date.parse(value.createdAt) || Date.parse(value.pausedAt) > Date.parse(value.updatedAt)) || value.completedAt !== void 0 && (Date.parse(value.completedAt) < Date.parse(value.createdAt) || Date.parse(value.completedAt) > Date.parse(value.updatedAt))) return void 0;
  const repositoryIdentity = value.repositoryIdentity === void 0 ? void 0 : decodeCurrentRepositoryIdentity(value.repositoryIdentity);
  const routingObservation = value.routingObservation === void 0 ? void 0 : decodeCurrentRoutingObservation(value.routingObservation);
  const readPolicy = value.readPolicy === void 0 ? void 0 : decodeCurrentReadPolicy(value.readPolicy);
  const events = value.events.map(decodeCurrentEvent);
  const outcomes = value.outcomes.map((outcome) => decodeCurrentOutcome(outcome, expectedTaskId));
  if (value.repositoryIdentity !== void 0 && !repositoryIdentity || value.routingObservation !== void 0 && !routingObservation || value.readPolicy !== void 0 && !readPolicy || events.some((entry) => entry === void 0) || outcomes.some((entry) => entry === void 0)) return void 0;
  const completedReport = value.completedReport === void 0 ? void 0 : decodeCurrentTaskReport(value.completedReport, expectedTaskId, events.length);
  if (value.completedReport !== void 0 && !completedReport) return void 0;
  if (value.status === "open" && (value.pausedAt !== void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== void 0)) return void 0;
  if (value.status === "paused" && (value.pausedAt === void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== "pause")) return void 0;
  if (value.status === "completed" && (value.completedAt === void 0 || completedReport === void 0 || value.lastDisposition !== "complete")) return void 0;
  if (value.status === "quarantined" && (value.lastDisposition === void 0 && (value.pausedAt !== void 0 || value.completedAt !== void 0 || completedReport !== void 0) || value.lastDisposition === "pause" && (value.pausedAt === void 0 || value.completedAt !== void 0 || completedReport !== void 0) || value.lastDisposition === "complete" && (value.completedAt === void 0 || completedReport === void 0))) return void 0;
  return {
    schemaId: TASK_LEDGER_SCHEMA_ID,
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    taskId: expectedTaskId,
    host: value.host,
    ...value.sessionId === void 0 ? {} : { sessionId: value.sessionId },
    ...value.turnId === void 0 ? {} : { turnId: value.turnId },
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...value.pausedAt === void 0 ? {} : { pausedAt: value.pausedAt },
    ...value.completedAt === void 0 ? {} : { completedAt: value.completedAt },
    estimatorVersion: TASK_ESTIMATOR_VERSION,
    ...repositoryIdentity === void 0 ? {} : { repositoryIdentity },
    ...routingObservation === void 0 ? {} : { routingObservation },
    ...readPolicy === void 0 ? {} : { readPolicy },
    deliveredArtifacts: [...value.deliveredArtifacts],
    outcomes,
    events,
    ...value.lastDisposition === void 0 ? {} : { lastDisposition: value.lastDisposition },
    ...completedReport === void 0 ? {} : { completedReport }
  };
}
async function inspectTaskLedgerReadOnly(root, taskId) {
  if (!UUID_PATTERN.test(taskId) || !isAbsolute2(root)) return { status: "invalid" };
  const path = join2(root, ".tokengraph", "tasks", `${taskId}.json`);
  let text;
  try {
    text = await readStableTaskLedger(path);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    if (error instanceof Error && error.message === "invalid-ledger-size") return { status: "invalid" };
    return { status: "unstable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  if (isRecord2(parsed) && parsed.schemaId === TASK_LEDGER_SCHEMA_ID && Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) {
    return { status: "unsupported" };
  }
  const ledger = decodeCurrentTaskLedger(parsed, taskId);
  if (!ledger) return { status: "invalid" };
  return { status: "valid", ledger: deepFreeze(ledger) };
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isOptionalIdentifier(value) {
  return value === void 0 || isIdentifier(value);
}

// src/hooks.ts
var POINTER_SCHEMA_ID = "tokengraph-hook-session";
var POINTER_SCHEMA_VERSION = 2;
var POINTER_MAX_BYTES = 16 * 1024;
var NANOSECONDS_PER_MILLISECOND2 = 1000000n;
var POINTER_RETENTION_NS = 30n * 24n * 60n * 60n * 1000000000n;
var FUTURE_TOLERANCE_NS = 5n * 60n * 1000000000n;
var INPUT_MAX_BYTES = 1024 * 1024;
var DECISION_MAX_CHARACTERS = 4 * 1024;
var POINTER_REPLACE_ATTEMPTS = 16;
var HASH_PATTERN2 = /^[0-9a-f]{64}$/;
var UUID_PATTERN2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var TEMP_PATTERN = /^\.tg-pointer-[0-9a-f]{64}-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
var EVENT_PAIRS = /* @__PURE__ */ new Map([
  ["session-start", "SessionStart"],
  ["user-prompt-submit", "UserPromptSubmit"],
  ["session-end", "SessionEnd"],
  ["post-tool-use", "PostToolUse"],
  ["stop", "Stop"]
]);
var TASK_AWARE_TOOLS = /* @__PURE__ */ new Set([
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
]);
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isIdentifier2(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}
function hash2(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function fileIdentity(stats) {
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
function sameObject2(left, right) {
  return compareHostWorkspaceStatSnapshots(left, right, "directory");
}
function sameCreated(left, right) {
  return compareHostWorkspaceStatSnapshots(left, right, "created");
}
function sameFile(left, right) {
  return compareHostWorkspaceStatSnapshots(left, right, "file");
}
function sameRenamedFile2(left, right) {
  return compareHostWorkspaceStatSnapshots(left, right, "rename");
}
async function ordinaryDirectory2(path) {
  const stats = await lstat3(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe-directory");
  return fileIdentity(stats);
}
function warning(message) {
  return { systemMessage: message.slice(0, 512) };
}
function containsConfirmationLikeField(input) {
  const pending = [input];
  for (let index = 0; index < pending.length; index += 1) {
    const value = pending[index];
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord3(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (/confirm.*legacy|legacy.*confirm/i.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}
async function resolvePair(rootKey, dataKey) {
  const rootValue = process.env[rootKey];
  const dataValue = process.env[dataKey];
  if (rootValue === void 0 && dataValue === void 0) return void 0;
  if (!isIdentifier2(rootValue) || !isIdentifier2(dataValue) || !isAbsolute3(rootValue) || !isAbsolute3(dataValue)) throw new Error("invalid-host-storage");
  await Promise.all([ordinaryDirectory2(rootValue), ordinaryDirectory2(dataValue)]);
  const [pluginRoot, dataRoot] = await Promise.all([realpath2(rootValue), realpath2(dataValue)]);
  const [pluginStats, dataStats] = await Promise.all([ordinaryDirectory2(pluginRoot), ordinaryDirectory2(dataRoot)]);
  return { pluginRoot, pluginIdentity: pluginStats, dataRoot, dataIdentity: dataStats };
}
async function resolveHookStorage() {
  const [codex, claude] = await Promise.all([resolvePair("PLUGIN_ROOT", "PLUGIN_DATA"), resolvePair("CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA")]);
  if (!codex && !claude) throw new Error("missing-host-storage");
  if (codex && claude && (codex.pluginRoot !== claude.pluginRoot || !sameObject2(codex.pluginIdentity, claude.pluginIdentity) || codex.dataRoot !== claude.dataRoot || !sameObject2(codex.dataIdentity, claude.dataIdentity))) {
    throw new Error("conflicting-host-storage");
  }
  return codex ?? claude;
}
async function validateHookStorage(storage) {
  const [pluginRoot, dataRoot] = await Promise.all([
    ordinaryDirectory2(storage.pluginRoot),
    ordinaryDirectory2(storage.dataRoot)
  ]);
  if (!sameObject2(storage.pluginIdentity, pluginRoot) || !sameObject2(storage.dataIdentity, dataRoot)) {
    throw new Error("substituted-host-storage");
  }
}
function overlaps(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const a = normalize(left);
  const b = normalize(right);
  const aToB = relative(a, b);
  const bToA = relative(b, a);
  return a === b || !aToB.startsWith("..") && !isAbsolute3(aToB) || !bToA.startsWith("..") && !isAbsolute3(bToA);
}
async function validateNonOverlap(storage, workspaceRoot) {
  if (overlaps(storage.dataRoot, workspaceRoot)) throw new Error("overlapping-host-storage");
}
async function bindSessions(storage, create) {
  const dataBefore = await ordinaryDirectory2(storage.dataRoot);
  if (!sameObject2(storage.dataIdentity, dataBefore)) throw new Error("substituted-data-root");
  const sessions = join3(storage.dataRoot, "sessions");
  try {
    const sessionsIdentity = await ordinaryDirectory2(sessions);
    const dataAfter = await ordinaryDirectory2(storage.dataRoot);
    if (!sameObject2(dataBefore, dataAfter)) throw new Error("substituted-data-root");
    return { ...storage, sessions, sessionsIdentity };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create) return void 0;
    try {
      await mkdir2(sessions, { mode: 448 });
    } catch (createError) {
      if (createError.code !== "EEXIST") throw createError;
    }
    const [sessionsIdentity, dataAfter] = await Promise.all([ordinaryDirectory2(sessions), ordinaryDirectory2(storage.dataRoot)]);
    if (!sameObject2(dataBefore, dataAfter)) throw new Error("substituted-data-root");
    return { ...storage, sessions, sessionsIdentity };
  }
}
async function validateParents2(storage) {
  const [data, sessions] = await Promise.all([ordinaryDirectory2(storage.dataRoot), ordinaryDirectory2(storage.sessions)]);
  if (!sameObject2(storage.dataIdentity, data) || !sameObject2(storage.sessionsIdentity, sessions)) throw new Error("substituted-pointer-parent");
}
function pointerPath(storage, sessionHash) {
  if (!HASH_PATTERN2.test(sessionHash)) throw new Error("invalid-session-hash");
  return join3(storage.sessions, `${sessionHash}.json`);
}
function decodePointer(value, expectedHash, now) {
  if (!isRecord3(value)) return { status: "invalid" };
  if (value.schemaId === POINTER_SCHEMA_ID && typeof value.schemaVersion === "number" && value.schemaVersion !== POINTER_SCHEMA_VERSION) return { status: "unsupported" };
  const expected = ["schemaId", "schemaVersion", "sessionHash", "taskId", "turnId", "updatedAt"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return { status: "invalid" };
  if (value.schemaId !== POINTER_SCHEMA_ID || value.schemaVersion !== POINTER_SCHEMA_VERSION || typeof value.sessionHash !== "string" || !HASH_PATTERN2.test(value.sessionHash) || typeof value.taskId !== "string" || !UUID_PATTERN2.test(value.taskId) || !isIdentifier2(value.turnId) || typeof value.updatedAt !== "string") return { status: "invalid" };
  if (value.sessionHash !== expectedHash) return { status: "mismatched" };
  const updatedAt = Date.parse(value.updatedAt);
  if (!Number.isFinite(updatedAt) || new Date(updatedAt).toISOString() !== value.updatedAt) return { status: "invalid" };
  const updatedAtNs = BigInt(updatedAt) * NANOSECONDS_PER_MILLISECOND2;
  const nowNs = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND2;
  if (updatedAtNs < nowNs - POINTER_RETENTION_NS || updatedAtNs > nowNs + FUTURE_TOLERANCE_NS) return { status: "expired" };
  return { status: "valid", pointer: Object.freeze({
    schemaId: POINTER_SCHEMA_ID,
    schemaVersion: POINTER_SCHEMA_VERSION,
    sessionHash: expectedHash,
    taskId: value.taskId,
    turnId: value.turnId,
    updatedAt: value.updatedAt
  }) };
}
async function readPointer(storage, expectedHash, now = /* @__PURE__ */ new Date()) {
  let started = false;
  try {
    await validateParents2(storage);
    const path = pointerPath(storage, expectedHash);
    const entryStats = await lstat3(path, { bigint: true });
    started = true;
    if (!entryStats.isFile() || entryStats.isSymbolicLink() || entryStats.nlink !== 1n) return { status: "unstable" };
    const entryBefore = fileIdentity(entryStats);
    if (entryBefore.size < 0n || entryBefore.size > BigInt(POINTER_MAX_BYTES)) return { status: "invalid", entry: entryBefore };
    const noFollow = "O_NOFOLLOW" in fsConstants3 ? fsConstants3.O_NOFOLLOW : 0;
    const handle = await open3(path, fsConstants3.O_RDONLY | noFollow);
    let text;
    try {
      const openedStats = await handle.stat({ bigint: true });
      const opened = fileIdentity(openedStats);
      if (!openedStats.isFile() || openedStats.nlink !== 1n || !sameFile(entryBefore, opened)) return { status: "unstable" };
      const chunks = [];
      let bytesRead = 0;
      for (; ; ) {
        const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, POINTER_MAX_BYTES + 1 - bytesRead));
        const result = await handle.read(chunk, 0, chunk.length, null);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
        if (bytesRead > POINTER_MAX_BYTES) return { status: "invalid", entry: entryBefore };
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      const [handleAfter, entryAfter] = await Promise.all([handle.stat({ bigint: true }), lstat3(path, { bigint: true })]);
      if (!entryAfter.isFile() || entryAfter.isSymbolicLink() || entryAfter.nlink !== 1n || !sameFile(opened, fileIdentity(handleAfter)) || !sameFile(entryBefore, fileIdentity(entryAfter)) || BigInt(bytesRead) !== handleAfter.size) return { status: "unstable" };
      text = Buffer.concat(chunks, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    await validateParents2(storage);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "invalid", entry: entryBefore };
    }
    return { ...decodePointer(parsed, expectedHash, now), entry: entryBefore };
  } catch (error) {
    if (!started && error.code === "ENOENT") return { status: "missing" };
    return { status: "unstable" };
  }
}
async function syncDirectory(path) {
  const noFollow = "O_NOFOLLOW" in fsConstants3 ? fsConstants3.O_NOFOLLOW : 0;
  const handle = await open3(path, fsConstants3.O_RDONLY | noFollow);
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(String(error.code))) throw error;
  } finally {
    await handle.close();
  }
}
async function unlinkExactEntry(storage, path, expected) {
  await validateParents2(storage);
  const current = await lstat3(path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameFile(expected, fileIdentity(current))) {
    throw new Error("unstable-pointer-removal");
  }
  await validateParents2(storage);
  await unlink2(path);
  await validateParents2(storage);
}
async function unlinkCreatedTemporary(storage, path, created) {
  await validateParents2(storage);
  const current = await lstat3(path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameCreated(created, fileIdentity(current))) {
    throw new Error("unstable-pointer-removal");
  }
  await validateParents2(storage);
  await unlink2(path);
  await validateParents2(storage);
}
async function isCompletedCooperativeReplacement(storage, sessionHash) {
  for (let attempt = 0; attempt < POINTER_REPLACE_ATTEMPTS; attempt += 1) {
    const current = await readPointer(storage, sessionHash);
    if (current.status === "valid") return true;
    if (current.status !== "unstable" || attempt + 1 >= POINTER_REPLACE_ATTEMPTS) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
  }
  return false;
}
async function replacePointer(storage, pointer) {
  for (let attempt = 0; attempt < POINTER_REPLACE_ATTEMPTS; attempt += 1) {
    await validateParents2(storage);
    const existing = await readPointer(storage, pointer.sessionHash);
    if (existing.status === "unstable" && await isCompletedCooperativeReplacement(storage, pointer.sessionHash)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
      continue;
    }
    if (!["missing", "valid", "expired"].includes(existing.status)) throw new Error("unsafe-pointer-target");
    const temp = join3(storage.sessions, `.tg-pointer-${pointer.sessionHash}-${process.pid}-${randomUUID2()}.tmp`);
    const bytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}
`, "utf8");
    if (bytes.length > POINTER_MAX_BYTES) throw new Error("invalid-pointer-size");
    let createdIdentity;
    let temporaryIdentity;
    let published = false;
    try {
      const handle = await open3(temp, "wx", 384);
      try {
        createdIdentity = fileIdentity(await handle.stat({ bigint: true }));
        await handle.writeFile(bytes);
        await handle.sync();
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile() || stats.nlink !== 1n) throw new Error("unstable-pointer-temporary");
        temporaryIdentity = fileIdentity(stats);
      } finally {
        await handle.close();
      }
      const tempStats = await lstat3(temp, { bigint: true });
      if (!sameFile(temporaryIdentity, fileIdentity(tempStats)) || tempStats.nlink !== 1n) throw new Error("unstable-pointer-temporary");
      await validateParents2(storage);
      const current = await readPointer(storage, pointer.sessionHash);
      if (current.status === "unstable" && await isCompletedCooperativeReplacement(storage, pointer.sessionHash)) {
        await unlinkExactEntry(storage, temp, temporaryIdentity);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
        continue;
      }
      if (existing.status === "missing") {
        if (current.status === "valid" || current.status === "expired") {
          await unlinkExactEntry(storage, temp, temporaryIdentity);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
          continue;
        }
        if (current.status !== "missing") throw new Error("unsafe-pointer-race");
      } else {
        if (current.status === "valid" || current.status === "expired") {
          if (existing.entry && current.entry && !sameFile(existing.entry, current.entry)) {
            await unlinkExactEntry(storage, temp, temporaryIdentity);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
            continue;
          }
        } else {
          throw new Error("unsafe-pointer-race");
        }
      }
      const targetPath = pointerPath(storage, pointer.sessionHash);
      if (current.status === "missing") {
        await link2(temp, targetPath);
        const [linkedTemporary, linkedTarget] = await Promise.all([
          lstat3(temp, { bigint: true }),
          lstat3(targetPath, { bigint: true })
        ]);
        const linkedIdentity = { ...temporaryIdentity, nlink: 2n };
        if (!linkedTemporary.isFile() || linkedTemporary.isSymbolicLink() || linkedTemporary.nlink !== 2n || !linkedTarget.isFile() || linkedTarget.isSymbolicLink() || linkedTarget.nlink !== 2n || !sameRenamedFile2(linkedIdentity, fileIdentity(linkedTemporary)) || !sameFile(fileIdentity(linkedTemporary), fileIdentity(linkedTarget))) {
          throw new Error("unstable-pointer-replacement");
        }
        await validateParents2(storage);
        await unlink2(temp);
      } else {
        await rename3(temp, targetPath);
      }
      published = true;
      const target = await lstat3(targetPath, { bigint: true });
      const targetIdentity = fileIdentity(target);
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n || (temporaryIdentity.dev === targetIdentity.dev && temporaryIdentity.ino === targetIdentity.ino ? !sameRenamedFile2(temporaryIdentity, targetIdentity) : !await isCompletedCooperativeReplacement(storage, pointer.sessionHash))) {
        throw new Error("unstable-pointer-replacement");
      }
      await syncDirectory(storage.sessions);
      await validateParents2(storage);
      return;
    } catch (error) {
      if (!published && createdIdentity) {
        try {
          await unlinkCreatedTemporary(storage, temp, createdIdentity);
        } catch {
        }
      }
      if (["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(String(error.code)) && attempt + 1 < POINTER_REPLACE_ATTEMPTS) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
        continue;
      }
      throw error;
    }
  }
  throw new Error("pointer-contention");
}
async function removePointer(storage, sessionHash) {
  const loaded = await readPointer(storage, sessionHash);
  if (loaded.status === "missing") return false;
  if (loaded.status !== "valid" && loaded.status !== "expired" || !loaded.entry) throw new Error("unsafe-pointer-removal");
  await unlinkExactEntry(storage, pointerPath(storage, sessionHash), loaded.entry);
  return true;
}
async function prunePointers(storage, now = /* @__PURE__ */ new Date()) {
  await validateParents2(storage);
  const names = (await readdir2(storage.sessions)).sort().filter(
    (name) => name.endsWith(".json") && HASH_PATTERN2.test(name.slice(0, -5)) || TEMP_PATTERN.test(name)
  ).slice(0, 64);
  await validateParents2(storage);
  for (const name of names) {
    if (name.endsWith(".json")) {
      try {
        const sessionHash = name.slice(0, -5);
        const loaded = await readPointer(storage, sessionHash, now);
        if (loaded.status === "expired" && loaded.entry) await removePointer(storage, sessionHash);
      } catch {
      }
      continue;
    }
    const path = join3(storage.sessions, name);
    try {
      await validateParents2(storage);
      const stats = await lstat3(path, { bigint: true });
      const nowNs = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND2;
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) continue;
      if (stats.mtimeNs > nowNs - POINTER_RETENTION_NS) continue;
      await unlinkExactEntry(storage, path, fileIdentity(stats));
    } catch {
    }
  }
}
function normalizeToolName(value) {
  if (typeof value !== "string") return void 0;
  const candidate = value.split("__").at(-1);
  return candidate && /^tokengraph_[a-z0-9_]+$/.test(candidate) && TASK_AWARE_TOOLS.has(candidate) ? candidate : void 0;
}
function sameStructuredValue(left, right) {
  const pending = [[left, right]];
  for (let index = 0; index < pending.length; index += 1) {
    const [a, b] = pending[index];
    if (Object.is(a, b)) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let item = 0; item < a.length; item += 1) pending.push([a[item], b[item]]);
      continue;
    }
    if (!isRecord3(a) || !isRecord3(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, keyIndex) => key !== bKeys[keyIndex])) return false;
    for (const key of aKeys) pending.push([a[key], b[key]]);
  }
  return true;
}
function errorShaped(response, payload) {
  if (Object.hasOwn(response, "error") || Object.hasOwn(response, "errors") || response.success === false || response.ok === false || ["error", "failed", "failure"].includes(String(response.status).toLowerCase())) return true;
  if (payload && (Object.hasOwn(payload, "error") || Object.hasOwn(payload, "errors") || payload.success === false || payload.ok === false || ["error", "failed", "failure"].includes(String(payload.status).toLowerCase()))) return true;
  return Array.isArray(response.content) && response.content.some((item) => isRecord3(item) && item.type === "error");
}
function successfulResponse(response) {
  if (!isRecord3(response)) return { successful: false };
  for (const alias of ["isError", "is_error"]) {
    if (Object.hasOwn(response, alias) && (typeof response[alias] !== "boolean" || response[alias] !== false)) return { successful: false };
  }
  const hasCamel = Object.hasOwn(response, "structuredContent");
  const hasSnake = Object.hasOwn(response, "structured_content");
  if (hasCamel && !isRecord3(response.structuredContent) || hasSnake && !isRecord3(response.structured_content)) return { successful: false };
  const camel = hasCamel ? response.structuredContent : void 0;
  const snake = hasSnake ? response.structured_content : void 0;
  if (camel && snake && !sameStructuredValue(camel, snake)) return { successful: false };
  const payload = camel ?? snake;
  if (errorShaped(response, payload)) return { successful: false };
  return payload ? { successful: true, payload } : { successful: true };
}
async function explicitRootsMatch(input, payload, root) {
  const toolInput = isRecord3(input.tool_input) ? input.tool_input : void 0;
  const toolResponse = isRecord3(input.tool_response) ? input.tool_response : void 0;
  for (const candidate of [input.cwd, toolInput?.root, toolResponse?.root, payload?.root]) {
    if (candidate === void 0) continue;
    if (typeof candidate !== "string" || !isAbsolute3(candidate)) return false;
    try {
      if (await realpath2(candidate) !== root) return false;
    } catch {
      return false;
    }
  }
  return true;
}
function selectedTurn(input) {
  for (const key of ["turn_id", "prompt_id", "tool_use_id"]) {
    if (input[key] !== void 0) return isIdentifier2(input[key]) ? input[key] : void 0;
  }
  return void 0;
}
async function attestSession(input, storage) {
  if (typeof input.cwd !== "string" || !isAbsolute3(input.cwd)) return warning("TokenGraph received invalid host workspace attestation input; setup was skipped.");
  try {
    await validateHookStorage(storage);
    const root = await realpath2(input.cwd);
    await validateNonOverlap(storage, root);
    await attestHostWorkspace(storage.pluginRoot, input.session_id, root);
    return {};
  } catch {
    return warning("TokenGraph could not establish a safe host workspace attestation; setup was skipped.");
  }
}
async function postToolUse(input, storage) {
  if (!normalizeToolName(input.tool_name)) return {};
  const turnId = selectedTurn(input);
  if (!turnId) return warning("TokenGraph received invalid lifecycle turn metadata; tracking was skipped.");
  try {
    await validateHookStorage(storage);
  } catch {
    return warning("TokenGraph host storage is unstable; tracking was skipped.");
  }
  const attestation = await loadHostWorkspaceAttestation(storage.pluginRoot, input.session_id);
  if (attestation.status !== "valid") return warning(`TokenGraph host workspace attestation is ${attestation.status}; tracking was skipped.`);
  try {
    await validateNonOverlap(storage, attestation.root);
  } catch {
    return warning("TokenGraph host storage overlaps the workspace; tracking was skipped.");
  }
  const currentHash = hash2(input.session_id);
  const response = successfulResponse(input.tool_response);
  if (!response.successful) return {};
  const payload = response.payload;
  if (!await explicitRootsMatch(input, payload, attestation.root)) return warning("TokenGraph lifecycle root did not match the host attestation; tracking was skipped.");
  let taskId;
  let sessions;
  const toolInput = isRecord3(input.tool_input) ? input.tool_input : void 0;
  const hasInputTaskId = toolInput !== void 0 && Object.hasOwn(toolInput, "taskId");
  if (hasInputTaskId && (typeof toolInput.taskId !== "string" || !UUID_PATTERN2.test(toolInput.taskId))) return {};
  const inputTaskId = hasInputTaskId ? toolInput.taskId : void 0;
  if (payload && Object.hasOwn(payload, "taskId")) {
    if (typeof payload.taskId !== "string" || !UUID_PATTERN2.test(payload.taskId) || inputTaskId && inputTaskId !== payload.taskId) return {};
    taskId = payload.taskId;
  } else if (inputTaskId) {
    try {
      sessions = await bindSessions(storage, false);
    } catch {
      return warning("TokenGraph session storage is unstable; tracking was skipped.");
    }
    if (!sessions) return {};
    const previous = await readPointer(sessions, currentHash);
    if (previous.status === "valid" && previous.pointer.taskId === inputTaskId) taskId = inputTaskId;
  }
  if (!taskId) return {};
  const ledger = await inspectTaskLedgerReadOnly(attestation.root, taskId);
  if (ledger.status !== "valid") return warning(`TokenGraph task ledger is ${ledger.status}; tracking was skipped.`);
  try {
    sessions ??= await bindSessions(storage, true);
    if (!sessions) return warning("TokenGraph session storage is unavailable; tracking was skipped.");
    await replacePointer(sessions, { schemaId: POINTER_SCHEMA_ID, schemaVersion: POINTER_SCHEMA_VERSION, sessionHash: currentHash, taskId, turnId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    await prunePointers(sessions);
    return {};
  } catch {
    return warning("TokenGraph lifecycle pointer could not be safely updated; tracking was skipped.");
  }
}
async function stop(input, storage) {
  try {
    await validateHookStorage(storage);
  } catch {
    return warning("TokenGraph host storage is unstable; lifecycle enforcement was skipped.");
  }
  const attestation = await loadHostWorkspaceAttestation(storage.pluginRoot, input.session_id);
  if (attestation.status !== "valid") return warning(`TokenGraph host workspace attestation is ${attestation.status}; lifecycle enforcement was skipped.`);
  try {
    await validateNonOverlap(storage, attestation.root);
  } catch {
    return warning("TokenGraph host storage overlaps the workspace; lifecycle enforcement was skipped.");
  }
  if (!await explicitRootsMatch(input, void 0, attestation.root)) return warning("TokenGraph lifecycle root did not match the host attestation; lifecycle enforcement was skipped.");
  let sessions;
  try {
    sessions = await bindSessions(storage, false);
  } catch {
    return warning("TokenGraph session storage is unstable; lifecycle enforcement was skipped.");
  }
  if (!sessions) return warning("TokenGraph session pointer is missing; lifecycle enforcement was skipped.");
  const loaded = await readPointer(sessions, hash2(input.session_id));
  if (loaded.status !== "valid") return warning(`TokenGraph session pointer is ${loaded.status}; lifecycle enforcement was skipped.`);
  const inspected = await inspectTaskLedgerReadOnly(attestation.root, loaded.pointer.taskId);
  if (inspected.status !== "valid") return warning(`TokenGraph task ledger is ${inspected.status}; lifecycle enforcement was skipped.`);
  const ledger = inspected.ledger;
  if (ledger.status === "paused") return {};
  if (ledger.status === "open" && ledger.lastDisposition === void 0) {
    if (input.stop_hook_active === true) return warning("TokenGraph task is still open without a pause-or-complete report; allowing stop to prevent a hook retry loop.");
    const pauseCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: attestation.root, disposition: "pause" })})`;
    const completeCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: attestation.root, disposition: "complete" })})`;
    const reason = `Call exactly one of these exact calls, choosing pause if work is unfinished or complete if it is finished: ${pauseCall} OR ${completeCall}. Then report the returned status. Do not claim completion for an interrupt or API failure.`;
    if (reason.length > DECISION_MAX_CHARACTERS) {
      return warning("TokenGraph pause-or-complete instruction exceeds the hook output bound and cannot be enforced exactly.");
    }
    return { decision: "block", reason };
  }
  if (ledger.status === "completed" && ledger.completedReport) {
    const footer = formatTaskReportFooter(ledger.completedReport);
    const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    if (message.includes(footer)) return {};
    const reason = `Append this exact canonical TokenGraph footer to the final response: ${footer}`;
    if (reason.length > DECISION_MAX_CHARACTERS) {
      return warning("TokenGraph completion footer exceeds the hook output bound and cannot be enforced exactly.");
    }
    if (input.stop_hook_active === true) return warning(`TokenGraph completion footer is still missing. Append exactly: ${footer}`);
    return { decision: "block", reason };
  }
  return {};
}
async function endSession(input, storage) {
  try {
    await validateHookStorage(storage);
  } catch {
    return warning("TokenGraph host storage is unstable; lifecycle cleanup was skipped.");
  }
  const attestation = await loadHostWorkspaceAttestation(storage.pluginRoot, input.session_id);
  if (attestation.status === "expired") return removeSessionState(input, storage);
  if (attestation.status !== "valid") return warning(`TokenGraph host workspace attestation is ${attestation.status}; lifecycle cleanup was skipped.`);
  try {
    await validateNonOverlap(storage, attestation.root);
  } catch {
    return warning("TokenGraph host storage overlaps the workspace; lifecycle cleanup was skipped.");
  }
  return removeSessionState(input, storage);
}
async function removeSessionState(input, storage) {
  let warningNeeded = false;
  try {
    const sessions = await bindSessions(storage, false);
    if (sessions) await removePointer(sessions, hash2(input.session_id));
  } catch {
    warningNeeded = true;
  }
  try {
    await removeHostWorkspaceAttestation(storage.pluginRoot, input.session_id);
  } catch {
    warningNeeded = true;
  }
  return warningNeeded ? warning("TokenGraph could not safely remove all expired lifecycle state.") : {};
}
async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > INPUT_MAX_BYTES) throw new Error("input-too-large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}
async function main() {
  let output;
  try {
    if (process.argv.length !== 3) throw new Error("invalid-arguments");
    const event = process.argv[2];
    const expectedEvent = EVENT_PAIRS.get(event);
    const input = await readStdin();
    if (!expectedEvent || !isRecord3(input) || input.hook_event_name !== expectedEvent || !isIdentifier2(input.session_id) || containsConfirmationLikeField(input)) throw new Error("invalid-input");
    const storage = await resolveHookStorage();
    output = event === "session-start" || event === "user-prompt-submit" ? await attestSession(input, storage) : event === "session-end" ? await endSession(input, storage) : event === "post-tool-use" ? await postToolUse(input, storage) : await stop(input, storage);
  } catch {
    output = warning("TokenGraph hook state could not be safely processed; lifecycle enforcement was skipped.");
  }
  const bounded = Object.fromEntries(Object.entries(output).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, DECISION_MAX_CHARACTERS) : value]));
  process.stdout.write(`${JSON.stringify(bounded)}
`);
}
await main();
