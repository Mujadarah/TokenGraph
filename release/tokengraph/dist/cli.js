#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/core/lockDomain.ts
var lockDomain_exports = {};
__export(lockDomain_exports, {
  LOCK_DOMAINS: () => LOCK_DOMAINS,
  LockDomainError: () => LockDomainError,
  NATIVE_LOCK_ANCHOR_NAME: () => NATIVE_LOCK_ANCHOR_NAME,
  NATIVE_LOCK_JOURNAL_NAME: () => NATIVE_LOCK_JOURNAL_NAME,
  NATIVE_LOCK_JOURNAL_TEMP_NAME: () => NATIVE_LOCK_JOURNAL_TEMP_NAME,
  canonicalPersistenceLock: () => canonicalPersistenceLock,
  isCanonicalPersistenceLock: () => isCanonicalPersistenceLock,
  relativeLegacyName: () => relativeLegacyName,
  resolveLockDomainRootReadOnly: () => resolveLockDomainRootReadOnly
});
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
function fail() {
  throw new LockDomainError();
}
function isSafeSingleSegment(value) {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (/[<>:"|?*\u0000-\u001f]/u.test(value) || /[. ]$/u.test(value)) return false;
  if (WINDOWS_DEVICE_NAME.test(value)) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_SEGMENT_BYTES) return false;
  const compatibilityName = `${value}.lock`;
  const portableName = compatibilityName.toLowerCase();
  return portableName !== NATIVE_LOCK_ANCHOR_NAME && portableName !== NATIVE_LOCK_JOURNAL_NAME;
}
function confinedDirectChild(root, candidate) {
  const difference = relative(root, candidate);
  return difference.length > 0 && !difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference) && dirname(candidate) === root && !difference.includes(sep);
}
async function canonicalExistingDirectory(path) {
  const canonical = await realpath(path).catch(fail);
  const stats = await lstat(canonical).catch(fail);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail();
  return canonical;
}
function fileIdentity(stats) {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}
async function stableMarker(path) {
  const before = await lstat(path, { bigint: true }).catch(fail);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) fail();
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(fail);
  try {
    const opened = await handle.stat({ bigint: true }).catch(fail);
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > 4096n || fileIdentity(opened) !== fileIdentity(before)) fail();
    const bytes = await handle.readFile().catch(fail);
    const after = await handle.stat({ bigint: true }).catch(fail);
    const entryAfter = await lstat(path, { bigint: true }).catch(fail);
    if (bytes.length > 4096 || fileIdentity(after) !== fileIdentity(opened) || fileIdentity(entryAfter) !== fileIdentity(opened) || !entryAfter.isFile() || entryAfter.isSymbolicLink() || entryAfter.nlink !== 1n) fail();
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
function oneLinePath(marker) {
  const match = /^([^\r\n]+)\r?\n?$/u.exec(marker);
  if (match === null || match[1].length === 0 || match[1].includes("\0")) fail();
  return match[1];
}
async function resolveGitCommonDirectory(workspaceRoot) {
  const dotGit = join(workspaceRoot, ".git");
  const dotGitStats = await lstat(dotGit).catch(fail);
  let gitDirectory;
  if (dotGitStats.isDirectory() && !dotGitStats.isSymbolicLink()) {
    gitDirectory = await canonicalExistingDirectory(dotGit);
    const unexpectedCommonMarker = await lstat(join(gitDirectory, "commondir")).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
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
async function domainRoot(workspaceRoot, domain) {
  const stateRoot = join(workspaceRoot, ".tokengraph");
  switch (domain) {
    case "workspace-state":
      return stateRoot;
    case "repository-state":
      return join(stateRoot, "repository");
    case "runs":
      return join(stateRoot, "runs");
    case "tasks":
      return join(stateRoot, "tasks");
    case "vault":
      return join(stateRoot, "vault");
    case "wiki":
      return join(stateRoot, "wiki");
    case "artifacts":
      return join(stateRoot, "repository", "artifacts");
    case "git-info":
      return join(await resolveGitCommonDirectory(workspaceRoot), "info");
  }
}
async function canonicalPersistenceLock(workspaceRoot, domain, relativeDataName) {
  if (typeof workspaceRoot !== "string" || !domainSet.has(domain) || typeof relativeDataName !== "string" || !isSafeSingleSegment(relativeDataName)) fail();
  const canonicalWorkspace = await canonicalExistingDirectory(resolve(workspaceRoot));
  const root = resolve(await domainRoot(canonicalWorkspace, domain));
  const compatibilityPath = join(root, `${relativeDataName}.lock`);
  if (!confinedDirectChild(root, compatibilityPath)) fail();
  const lock = Object.freeze({
    domain,
    domainRoot: root,
    compatibilityPath,
    anchorPath: join(root, NATIVE_LOCK_ANCHOR_NAME),
    journalPath: join(root, NATIVE_LOCK_JOURNAL_NAME)
  });
  lockBrand.add(lock);
  return lock;
}
async function resolveLockDomainRootReadOnly(workspaceRoot, domain) {
  if (typeof workspaceRoot !== "string" || !domainSet.has(domain)) fail();
  const requestedWorkspace = resolve(workspaceRoot);
  const canonicalWorkspace = await canonicalExistingDirectory(requestedWorkspace);
  if (canonicalWorkspace !== requestedWorkspace) fail();
  return resolve(await domainRoot(canonicalWorkspace, domain));
}
function isCanonicalPersistenceLock(value) {
  return typeof value === "object" && value !== null && lockBrand.has(value);
}
function relativeLegacyName(lock) {
  if (!isCanonicalPersistenceLock(lock)) fail();
  const value = relative(lock.domainRoot, lock.compatibilityPath);
  if (!confinedDirectChild(lock.domainRoot, lock.compatibilityPath)) fail();
  return value;
}
var LOCK_DOMAINS, LockDomainError, lockBrand, domainSet, NATIVE_LOCK_ANCHOR_NAME, NATIVE_LOCK_JOURNAL_NAME, NATIVE_LOCK_JOURNAL_TEMP_NAME, MAX_SEGMENT_BYTES, WINDOWS_DEVICE_NAME;
var init_lockDomain = __esm({
  "src/core/lockDomain.ts"() {
    "use strict";
    LOCK_DOMAINS = Object.freeze([
      "workspace-state",
      "repository-state",
      "runs",
      "tasks",
      "vault",
      "wiki",
      "artifacts",
      "git-info"
    ]);
    LockDomainError = class extends Error {
      code = "INVALID_LOCK_DOMAIN";
      constructor() {
        super("Persistence lock domain or key is not authorized.");
        this.name = "LockDomainError";
      }
    };
    lockBrand = /* @__PURE__ */ new WeakSet();
    domainSet = new Set(LOCK_DOMAINS);
    NATIVE_LOCK_ANCHOR_NAME = ".tokengraph-native-anchor-v2.lock";
    NATIVE_LOCK_JOURNAL_NAME = ".tokengraph-native-journal-v2.lock";
    NATIVE_LOCK_JOURNAL_TEMP_NAME = ".tokengraph-native-journal-v2.lock.tokengraph-write-v2.tmp";
    MAX_SEGMENT_BYTES = 240;
    WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  }
});

// src/core/legacyRuntimeActivation.ts
function activateLegacyRuntimeShutdown(input) {
  if (input === null || typeof input !== "object" || input.confirmedNoLegacyTokenGraphProcesses !== true) {
    throw new LegacyRuntimeActivationError();
  }
  if (processCapability !== void 0) return processCapability;
  const capability = Object.freeze({});
  capabilityBrand.add(capability);
  processCapability = capability;
  return capability;
}
function getLegacyRuntimeActivationStatus() {
  return Object.freeze({ activated: processCapability !== void 0 });
}
function isLegacyRuntimeShutdownCapability(value) {
  return typeof value === "object" && value !== null && capabilityBrand.has(value);
}
function requireLegacyRuntimeShutdownCapability() {
  if (processCapability === void 0) throw new LegacyRuntimeActivationError();
  return processCapability;
}
var capabilityBrand, processCapability, LegacyRuntimeActivationError;
var init_legacyRuntimeActivation = __esm({
  "src/core/legacyRuntimeActivation.ts"() {
    "use strict";
    capabilityBrand = /* @__PURE__ */ new WeakSet();
    LegacyRuntimeActivationError = class extends Error {
      code = "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED";
      constructor() {
        super("Legacy TokenGraph runtime shutdown has not been confirmed for this process.");
        this.name = "LegacyRuntimeActivationError";
      }
    };
  }
});

// src/core/nativeLockAddon.ts
import { createHash } from "node:crypto";
import { constants as constants2, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { chmod, lstat as lstat2, mkdtemp, open as open2, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
function fail2(code) {
  throw new NativeLockError(code);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function dataDescriptorValue(value, property, ownOnly = false) {
  let current = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== void 0) {
      return Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : void 0;
    }
    if (ownOnly) return void 0;
    current = Object.getPrototypeOf(current);
  }
  return void 0;
}
function descriptorString(value, property) {
  if (typeof value !== "object" || value === null) return void 0;
  const candidate = dataDescriptorValue(value, property);
  return typeof candidate === "string" ? candidate : void 0;
}
function errnoCode(error) {
  return descriptorString(error, "code");
}
function createLoaderState() {
  return {
    cache: /* @__PURE__ */ new Map(),
    boundIdentities: /* @__PURE__ */ new Map(),
    inFlight: /* @__PURE__ */ new Map()
  };
}
function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function sameObjectIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory();
}
function sameFileIdentity(left, right) {
  return sameDirectoryIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function snapshotIdentity(pathKey, stats) {
  return [pathKey, stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}
async function bigIntLstat(path) {
  return await lstat2(path, { bigint: true });
}
function validateDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail2("ADDON_INTEGRITY");
}
function validateFile(stats, maxBytes) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size <= 0n || stats.size > BigInt(maxBytes)) {
    fail2("ADDON_INTEGRITY");
  }
}
async function readVerifiedFile(path, maxBytes, missingCode, afterRead) {
  let handle;
  try {
    const parent = await bigIntLstat(dirname2(path));
    validateDirectory(parent);
    const entry = await bigIntLstat(path);
    validateFile(entry, maxBytes);
    const noFollow = typeof constants2.O_NOFOLLOW === "number" ? constants2.O_NOFOLLOW : 0;
    handle = await open2(path, constants2.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    validateFile(opened, maxBytes);
    if (!sameFileIdentity(entry, opened)) fail2("ADDON_INTEGRITY");
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== opened.size) fail2("ADDON_INTEGRITY");
    if (afterRead) await afterRead();
    const openedAfter = await handle.stat({ bigint: true });
    const entryAfter = await bigIntLstat(path);
    const parentAfter = await bigIntLstat(dirname2(path));
    validateFile(openedAfter, maxBytes);
    validateFile(entryAfter, maxBytes);
    validateDirectory(parentAfter);
    if (!sameFileIdentity(opened, openedAfter) || !sameFileIdentity(opened, entryAfter) || !sameDirectoryIdentity(parent, parentAfter)) {
      fail2("ADDON_INTEGRITY");
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
    if (handle !== void 0) {
      try {
        await handle.close();
      } catch {
        throw new NativeLockError("ADDON_INTEGRITY");
      }
    }
  }
}
function assertManifest(value) {
  if (!isObject(value) || !hasExactKeys(value, MANIFEST_KEYS) || value.schemaVersion !== 1 || value.addonAbiVersion !== 1 || value.nodeApiVersion !== 9 || value.rustToolchain !== "1.97.1" || !Array.isArray(value.artifacts) || value.artifacts.length !== TARGETS.length) {
    fail2("ADDON_INTEGRITY");
  }
  for (let index = 0; index < TARGETS.length; index += 1) {
    const expected = TARGETS[index];
    const artifact = value.artifacts[index];
    if (!isObject(artifact) || !hasExactKeys(artifact, ARTIFACT_KEYS)) fail2("ADDON_INTEGRITY");
    for (const key of ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor"]) {
      if (artifact[key] !== expected[key]) fail2("ADDON_INTEGRITY");
    }
    if (artifact.path !== `${expected.id}/${expected.file}` || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > ADDON_MAX_BYTES || typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      fail2("ADDON_INTEGRITY");
    }
  }
  return value;
}
async function readManifest(assetsRoot) {
  const snapshot = await readVerifiedFile(resolve2(assetsRoot, "manifest.json"), MANIFEST_MAX_BYTES, "ADDON_MISSING");
  try {
    return assertManifest(JSON.parse(snapshot.bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    fail2("ADDON_INTEGRITY");
  }
}
function atLeastGlibc228(version) {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || major === 2 && minor >= 28;
}
function reportedGlibcVersion() {
  const report = process.report?.getReport?.();
  const value = report?.header?.glibcVersionRuntime;
  return typeof value === "string" ? value : void 0;
}
function selectTarget(runtime) {
  const platform = runtime.platform ?? process.platform;
  const arch = runtime.arch ?? process.arch;
  if (platform === "linux") {
    const glibc = Object.prototype.hasOwnProperty.call(runtime, "glibcVersionRuntime") ? runtime.glibcVersionRuntime : reportedGlibcVersion();
    if (!atLeastGlibc228(glibc)) fail2("ADDON_UNSUPPORTED");
  }
  const target = TARGETS.find((entry) => entry.platform === platform && entry.arch === arch);
  if (target === void 0) fail2("ADDON_UNSUPPORTED");
  return target;
}
function resolveAssetsRoot(runtime) {
  if (runtime.assetsRoot !== void 0) {
    if (runtime.assetsRoot.length === 0) fail2("ADDON_INTEGRITY");
    return resolve2(runtime.assetsRoot);
  }
  let modulePath;
  try {
    modulePath = fileURLToPath(runtime.moduleUrl ?? import.meta.url);
  } catch {
    fail2("ADDON_INTEGRITY");
  }
  const moduleDirectory = dirname2(modulePath);
  if (basename(moduleDirectory) === "core" && basename(dirname2(moduleDirectory)) === "src") {
    return resolve2(moduleDirectory, "..", "..", "assets", "native-lock");
  }
  if (basename(moduleDirectory) === "dist") {
    return resolve2(moduleDirectory, "..", "assets", "native-lock");
  }
  if (basename(moduleDirectory) === "core" && basename(dirname2(moduleDirectory)) === "dist") {
    return resolve2(moduleDirectory, "..", "..", "assets", "native-lock");
  }
  fail2("ADDON_INTEGRITY");
}
function canonicalOwner(owner) {
  return Buffer.from(`${JSON.stringify(owner)}
`);
}
function assertOwner(value, expectedPid) {
  if (!isObject(value) || !hasExactKeys(value, OWNER_KEYS) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.targetId !== "string" || !TARGETS.some((target) => target.id === value.targetId) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256) || typeof value.addonFile !== "string" || value.addonFile !== `${value.targetId}-${value.sha256}.node` || expectedPid !== void 0 && value.pid !== expectedPid) {
    fail2("ADDON_INTEGRITY");
  }
  return value;
}
function validatePrivateMode(stats, expected) {
  if (process.platform !== "win32" && (stats.mode & 0o777n) !== expected) fail2("ADDON_INTEGRITY");
}
async function writeExclusiveSynced(path, bytes, platform, makeReadOnly) {
  let handle;
  try {
    handle = await open2(path, "wx", 384);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    fail2("ADDON_INTEGRITY");
  } finally {
    if (handle !== void 0) {
      try {
        await handle.close();
      } catch {
        fail2("ADDON_INTEGRITY");
      }
    }
  }
  for (let attempt = 0; attempt < STAGING_CHMOD_ATTEMPTS; attempt += 1) {
    try {
      await makeReadOnly(path, 256);
      return;
    } catch (error) {
      const transientWindowsFailure = platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(errnoCode(error) ?? "");
      if (!transientWindowsFailure || attempt + 1 >= STAGING_CHMOD_ATTEMPTS) fail2("ADDON_INTEGRITY");
      await new Promise((resolveRetry) => setTimeout(resolveRetry, STAGING_CHMOD_RETRY_MS));
    }
  }
}
async function exactDirectoryEntries(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail2("ADDON_INTEGRITY");
  }
  return entries.map((entry) => entry.name).sort();
}
async function verifyStagingLifecycle(lifecycle, expectedBytes) {
  try {
    const rootBefore = await bigIntLstat(lifecycle.root);
    validateDirectory(rootBefore);
    validatePrivateMode(rootBefore, 0o700n);
    if (!sameDirectoryIdentity(lifecycle.rootIdentity, rootBefore)) fail2("ADDON_INTEGRITY");
    const expectedEntries = [basename(lifecycle.markerPath), basename(lifecycle.stagedPath)].sort();
    if ((await exactDirectoryEntries(lifecycle.root)).join("\0") !== expectedEntries.join("\0")) fail2("ADDON_INTEGRITY");
    const marker = await readVerifiedFile(lifecycle.markerPath, MARKER_MAX_BYTES, "ADDON_INTEGRITY");
    validatePrivateMode(marker.entry, 0o400n);
    if (!marker.bytes.equals(lifecycle.markerBytes)) fail2("ADDON_INTEGRITY");
    let owner;
    try {
      owner = assertOwner(JSON.parse(marker.bytes.toString("utf8")), lifecycle.pid);
    } catch (error) {
      if (error instanceof NativeLockError) throw error;
      fail2("ADDON_INTEGRITY");
    }
    if (owner.targetId !== lifecycle.targetId || owner.sha256 !== lifecycle.sha256 || owner.addonFile !== basename(lifecycle.stagedPath)) {
      fail2("ADDON_INTEGRITY");
    }
    const staged = await readVerifiedFile(lifecycle.stagedPath, ADDON_MAX_BYTES, "ADDON_INTEGRITY");
    validatePrivateMode(staged.entry, 0o400n);
    if (!staged.bytes.equals(expectedBytes) || createHash("sha256").update(staged.bytes).digest("hex") !== lifecycle.sha256) {
      fail2("ADDON_INTEGRITY");
    }
    const rootAfter = await bigIntLstat(lifecycle.root);
    if (!sameDirectoryIdentity(rootBefore, rootAfter)) fail2("ADDON_INTEGRITY");
    if (lifecycle.markerIdentity !== void 0 && !sameFileIdentity(lifecycle.markerIdentity, marker.entry)) fail2("ADDON_INTEGRITY");
    if (lifecycle.stagedIdentity !== void 0 && !sameFileIdentity(lifecycle.stagedIdentity, staged.entry)) fail2("ADDON_INTEGRITY");
    lifecycle.markerIdentity ??= marker.entry;
    lifecycle.stagedIdentity ??= staged.entry;
    return staged;
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    fail2("ADDON_INTEGRITY");
  }
}
async function pathIsAbsent(path) {
  try {
    await lstat2(path);
    return false;
  } catch (error) {
    return errnoCode(error) === "ENOENT";
  }
}
async function cleanupOwnedStaging(lifecycle, io = {}) {
  const unlinkFile = io.unlink ?? unlink;
  const removeDirectory = io.rmdir ?? rmdir;
  try {
    const root = await bigIntLstat(lifecycle.root);
    if (!root.isDirectory() || root.isSymbolicLink() || !sameObjectIdentity(lifecycle.rootIdentity, root)) {
      return { complete: false, phase: "validation" };
    }
    const allowed = /* @__PURE__ */ new Set([basename(lifecycle.stagedPath), basename(lifecycle.markerPath)]);
    const entries = await readdir(lifecycle.root, { withFileTypes: true });
    if (entries.some((entry) => !allowed.has(entry.name) || entry.isSymbolicLink())) {
      return { complete: false, phase: "validation" };
    }
    const removeOwnedFile = async (path, identity2, phase) => {
      let current;
      try {
        current = await bigIntLstat(path);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return void 0;
        return { complete: false, phase, code: errnoCode(error) };
      }
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || identity2 !== void 0 && !sameObjectIdentity(identity2, current)) {
        return { complete: false, phase: "validation" };
      }
      try {
        await unlinkFile(path);
      } catch (error) {
        return { complete: false, phase, code: errnoCode(error) };
      }
      if (!await pathIsAbsent(path)) return { complete: false, phase: "validation" };
      return void 0;
    };
    const addonFailure = await removeOwnedFile(lifecycle.stagedPath, lifecycle.stagedIdentity, "addon");
    if (addonFailure !== void 0) return addonFailure;
    const markerFailure = await removeOwnedFile(lifecycle.markerPath, lifecycle.markerIdentity, "marker");
    if (markerFailure !== void 0) return markerFailure;
    if ((await readdir(lifecycle.root)).length !== 0) return { complete: false, phase: "validation" };
    const rootBeforeRemoval = await bigIntLstat(lifecycle.root);
    if (!sameObjectIdentity(lifecycle.rootIdentity, rootBeforeRemoval)) return { complete: false, phase: "validation" };
    try {
      await removeDirectory(lifecycle.root);
    } catch (error) {
      return { complete: false, phase: "root", code: errnoCode(error) };
    }
    return await pathIsAbsent(lifecycle.root) ? { complete: true } : { complete: false, phase: "validation" };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { complete: true };
    return { complete: false, phase: "validation", code: errnoCode(error) };
  }
}
function stagingBase(runtime) {
  const value = runtime.tempDirectory ?? tmpdir();
  if (value.length === 0) fail2("ADDON_INTEGRITY");
  return resolve2(value);
}
function stagingProcessId(runtime) {
  const pid = runtime.processId ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) fail2("ADDON_INTEGRITY");
  return pid;
}
function stagingKey(runtime) {
  const base = stagingBase(runtime);
  const normalized = process.platform === "win32" ? base.toLowerCase() : base;
  return `${normalized}\0${stagingProcessId(runtime)}`;
}
function poisonStagingSlot(runtime, root) {
  const key = stagingKey(runtime);
  const existing = preservedStagingRoots.get(key);
  if (existing === void 0) {
    preservedStagingRoots.set(key, root);
    return true;
  }
  return existing === root;
}
async function createStagingLifecycle(runtime, target, sourcePath, sourceBytes, sha2563) {
  const base = stagingBase(runtime);
  const pid = stagingProcessId(runtime);
  let lifecycle;
  let createdRoot;
  try {
    const baseStats = await bigIntLstat(base);
    validateDirectory(baseStats);
    const root = await mkdtemp(join2(base, `${STAGING_PREFIX}${pid}-`));
    createdRoot = root;
    if (dirname2(root) !== base || !new RegExp(`^${STAGING_PREFIX}${pid}-[A-Za-z0-9]{6}$`, "u").test(basename(root))) {
      fail2("ADDON_INTEGRITY");
    }
    await chmod(root, 448);
    const rootIdentity = await bigIntLstat(root);
    validateDirectory(rootIdentity);
    validatePrivateMode(rootIdentity, 0o700n);
    const addonFile = `${target.id}-${sha2563}.node`;
    const owner = { schemaVersion: 1, pid, targetId: target.id, sha256: sha2563, addonFile };
    const markerBytes = canonicalOwner(owner);
    lifecycle = {
      root,
      sourcePath,
      stagedPath: resolve2(root, addonFile),
      markerPath: resolve2(root, "owner.json"),
      targetId: target.id,
      sha256: sha2563,
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
    if (lifecycle !== void 0) {
      const cleanup = await cleanupOwnedStaging(lifecycle, runtime.stagingIo);
      if (!cleanup.complete) {
        poisonStagingSlot(runtime, lifecycle.root);
        fail2("ADDON_INTEGRITY");
      }
    } else if (createdRoot !== void 0) {
      let removed = false;
      try {
        if (dirname2(createdRoot) === base && basename(createdRoot).startsWith(`${STAGING_PREFIX}${pid}-`)) {
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
        fail2("ADDON_INTEGRITY");
      }
    }
    if (error instanceof NativeLockError) throw error;
    fail2("ADDON_INTEGRITY");
  }
}
function parseStagingPid(name) {
  const match = /^tokengraph-native-addon-v1-(\d+)-[A-Za-z0-9]{6}$/u.exec(name);
  if (match === null) return void 0;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && String(pid) === match[1] ? pid : void 0;
}
function parseStagedAddonName(name) {
  for (const target of TARGETS) {
    const prefix = `${target.id}-`;
    if (!name.startsWith(prefix) || !name.endsWith(".node")) continue;
    const sha2563 = name.slice(prefix.length, -".node".length);
    if (/^[0-9a-f]{64}$/u.test(sha2563)) return { targetId: target.id, sha256: sha2563 };
  }
  return void 0;
}
function isOrdinaryUnlinkedFile(stats) {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n;
}
function sameStableFileBytes(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile() && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
async function snapshotStaleSafeSubset(root, pid) {
  try {
    const rootIdentity = await bigIntLstat(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) return;
    validatePrivateMode(rootIdentity, 0o700n);
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 2 || entries.some((entry) => entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory())) return;
    const names = entries.map((entry) => entry.name).sort();
    const markerEntry = entries.find((entry) => entry.name === "owner.json");
    const addonEntries = entries.filter((entry) => entry.name !== "owner.json");
    if (addonEntries.length > 1) return;
    const parsedAddon = addonEntries.length === 1 ? parseStagedAddonName(addonEntries[0].name) : void 0;
    if (addonEntries.length === 1 && parsedAddon === void 0) return;
    let marker;
    let owner;
    if (markerEntry !== void 0) {
      const markerPath = resolve2(root, markerEntry.name);
      const markerSnapshot = await readVerifiedFile(markerPath, MARKER_MAX_BYTES, "ADDON_INTEGRITY");
      try {
        owner = assertOwner(JSON.parse(markerSnapshot.bytes.toString("utf8")), pid);
      } catch {
        return;
      }
      if (!markerSnapshot.bytes.equals(canonicalOwner(owner))) return;
      marker = { path: markerPath, identity: markerSnapshot.entry };
    }
    let staged;
    if (addonEntries.length === 1) {
      const stagedPath = resolve2(root, addonEntries[0].name);
      const identity2 = await bigIntLstat(stagedPath);
      if (!isOrdinaryUnlinkedFile(identity2)) return;
      staged = { path: stagedPath, identity: identity2 };
    }
    if (owner !== void 0 && staged !== void 0 && (owner.addonFile !== basename(staged.path) || owner.targetId !== parsedAddon?.targetId || owner.sha256 !== parsedAddon.sha256)) {
      return;
    }
    if (names.join("\0") !== [marker?.path === void 0 ? void 0 : "owner.json", staged === void 0 ? void 0 : basename(staged.path)].filter((name) => name !== void 0).sort().join("\0")) return;
    return { root, rootIdentity, pid, marker, staged };
  } catch {
    return void 0;
  }
}
async function revalidateStaleSafeSubset(subset) {
  try {
    const root = await bigIntLstat(subset.root);
    if (!sameDirectoryIdentity(subset.rootIdentity, root)) return false;
    const expected = [subset.marker?.path, subset.staged?.path].filter((path) => path !== void 0).map((path) => basename(path)).sort();
    if ((await exactDirectoryEntries(subset.root)).join("\0") !== expected.join("\0")) return false;
    for (const entry of [subset.staged, subset.marker]) {
      if (entry === void 0) continue;
      const current = await bigIntLstat(entry.path);
      if (!isOrdinaryUnlinkedFile(current) || !sameFileIdentity(entry.identity, current)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function prepareStaleEntryForRemoval(entry, runtime) {
  try {
    let current = await bigIntLstat(entry.path);
    if (!isOrdinaryUnlinkedFile(current) || !sameFileIdentity(entry.identity, current)) return void 0;
    if (process.platform === "win32" && (current.mode & 0o200n) === 0n) {
      await (runtime.stagingIo?.chmod ?? chmod)(entry.path, 384);
      const normalized = await bigIntLstat(entry.path);
      if (!isOrdinaryUnlinkedFile(normalized) || !sameStableFileBytes(current, normalized)) return void 0;
      current = normalized;
    }
    return current;
  } catch {
    return void 0;
  }
}
async function cleanupStaleSafeSubset(subset, runtime) {
  try {
    if (!await revalidateStaleSafeSubset(subset)) return;
    const unlinkFile = runtime.stagingIo?.unlink ?? unlink;
    if (subset.staged !== void 0) {
      const stagedIdentity = await prepareStaleEntryForRemoval(subset.staged, runtime);
      if (stagedIdentity === void 0 || !sameDirectoryIdentity(subset.rootIdentity, await bigIntLstat(subset.root))) return;
      const expectedBeforeStaged = [subset.marker?.path, subset.staged.path].filter((path) => path !== void 0).map((path) => basename(path)).sort();
      if ((await exactDirectoryEntries(subset.root)).join("\0") !== expectedBeforeStaged.join("\0")) return;
      const stagedBeforeRemoval = await bigIntLstat(subset.staged.path);
      if (!isOrdinaryUnlinkedFile(stagedBeforeRemoval) || !sameFileIdentity(stagedIdentity, stagedBeforeRemoval)) return;
      if (subset.marker !== void 0) {
        const markerBeforeStagedRemoval = await bigIntLstat(subset.marker.path);
        if (!isOrdinaryUnlinkedFile(markerBeforeStagedRemoval) || !sameFileIdentity(subset.marker.identity, markerBeforeStagedRemoval)) return;
      }
      await unlinkFile(subset.staged.path);
      if (!await pathIsAbsent(subset.staged.path)) return;
    }
    if (subset.marker !== void 0) {
      const markerIdentity = await prepareStaleEntryForRemoval(subset.marker, runtime);
      if (markerIdentity === void 0 || !sameDirectoryIdentity(subset.rootIdentity, await bigIntLstat(subset.root)) || (await exactDirectoryEntries(subset.root)).join("\0") !== "owner.json") return;
      const markerBeforeRemoval = await bigIntLstat(subset.marker.path);
      if (!isOrdinaryUnlinkedFile(markerBeforeRemoval) || !sameFileIdentity(markerIdentity, markerBeforeRemoval)) return;
      await unlinkFile(subset.marker.path);
      if (!await pathIsAbsent(subset.marker.path)) return;
    }
    if ((await readdir(subset.root)).length !== 0 || !sameDirectoryIdentity(subset.rootIdentity, await bigIntLstat(subset.root))) return;
    await (runtime.stagingIo?.rmdir ?? rmdir)(subset.root);
  } catch {
  }
}
async function inspectStaleRoot(root, pid, runtime) {
  const subset = await snapshotStaleSafeSubset(root, pid);
  if (subset === void 0) return;
  const probe = runtime.probeProcess ?? ((candidatePid) => process.kill(candidatePid, 0));
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
  if (!await revalidateStaleSafeSubset(subset)) return;
  await cleanupStaleSafeSubset(subset, runtime);
}
async function performStaleStagingSweep(runtime, base) {
  try {
    const baseStats = await bigIntLstat(base);
    validateDirectory(baseStats);
    const candidates = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const pid = parseStagingPid(entry.name);
      if (pid === void 0) continue;
      const root = resolve2(base, entry.name);
      try {
        const stats = await bigIntLstat(root);
        candidates.push({ root, pid, mtimeNs: stats.mtimeNs });
      } catch {
      }
    }
    candidates.sort((left, right) => left.mtimeNs < right.mtimeNs ? -1 : left.mtimeNs > right.mtimeNs ? 1 : 0);
    for (const candidate of candidates.slice(0, STALE_SWEEP_LIMIT)) {
      await inspectStaleRoot(candidate.root, candidate.pid, runtime);
    }
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    fail2("ADDON_INTEGRITY");
  }
}
async function sweepStaleStaging(runtime) {
  const base = stagingBase(runtime);
  const key = process.platform === "win32" ? base.toLowerCase() : base;
  const existing = stagingSweeps.get(key);
  if (existing !== void 0) return existing;
  const shared = Promise.resolve().then(() => performStaleStagingSweep(runtime, base));
  stagingSweeps.set(key, shared);
  try {
    await shared;
  } catch (error) {
    if (stagingSweeps.get(key) === shared) stagingSweeps.delete(key);
    throw error;
  }
}
async function withStagingSlot(runtime, operation) {
  const key = stagingKey(runtime);
  const previous = stagingChains.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  const chain = previous.then(() => gate);
  stagingChains.set(key, chain);
  await previous;
  try {
    if (preservedStagingRoots.has(key)) fail2("ADDON_INTEGRITY");
    return await operation();
  } finally {
    release();
    if (stagingChains.get(key) === chain) stagingChains.delete(key);
  }
}
function loadWithProcessDlopen(modulePath) {
  const holder = { exports: {} };
  process.dlopen(holder, modulePath);
  return { provenance: "production", holder, rawAddon: holder.exports };
}
function loadStagedModule(runtime, modulePath) {
  if (runtime.loadModule !== void 0) {
    return { provenance: "injected", rawAddon: runtime.loadModule(modulePath) };
  }
  return loadWithProcessDlopen(modulePath);
}
function cleanupOwnedStagingSync(lifecycle) {
  try {
    const root = lstatSync(lifecycle.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || !sameDirectoryIdentity(lifecycle.rootIdentity, root)) return;
    const expected = [basename(lifecycle.stagedPath), basename(lifecycle.markerPath)].sort();
    const entries = readdirSync(lifecycle.root, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || entries.map((entry) => entry.name).sort().join("\0") !== expected.join("\0")) return;
    const marker = lstatSync(lifecycle.markerPath, { bigint: true });
    const staged = lstatSync(lifecycle.stagedPath, { bigint: true });
    if (lifecycle.markerIdentity === void 0 || lifecycle.stagedIdentity === void 0 || !isOrdinaryUnlinkedFile(marker) || !isOrdinaryUnlinkedFile(staged) || !sameFileIdentity(lifecycle.markerIdentity, marker) || !sameFileIdentity(lifecycle.stagedIdentity, staged)) return;
    const markerBytes = readFileSync(lifecycle.markerPath);
    const markerAfterRead = lstatSync(lifecycle.markerPath, { bigint: true });
    const stagedBeforeRemoval = lstatSync(lifecycle.stagedPath, { bigint: true });
    const rootBeforeRemoval = lstatSync(lifecycle.root, { bigint: true });
    if (!markerBytes.equals(lifecycle.markerBytes) || !sameFileIdentity(marker, markerAfterRead) || !sameFileIdentity(staged, stagedBeforeRemoval) || !sameDirectoryIdentity(root, rootBeforeRemoval) || readdirSync(lifecycle.root).sort().join("\0") !== expected.join("\0")) return;
    unlinkSync(lifecycle.stagedPath);
    const markerBeforeRemoval = lstatSync(lifecycle.markerPath, { bigint: true });
    if (!sameFileIdentity(markerAfterRead, markerBeforeRemoval)) return;
    unlinkSync(lifecycle.markerPath);
    if (readdirSync(lifecycle.root).length === 0) rmdirSync(lifecycle.root);
  } catch {
  }
}
function rawNativeCodes(error) {
  const codes = [];
  if (typeof error === "object" && error !== null) {
    for (const key of ["code", "reason", "message"]) {
      const value = dataDescriptorValue(error, key);
      if (typeof value !== "string") continue;
      if (key === "code") codes.push(value);
      const match = /^([A-Z][A-Z0-9_]*):/u.exec(value);
      if (match !== null) codes.push(match[1]);
    }
  }
  return codes;
}
function normalizeNativeError(error) {
  const codes = rawNativeCodes(error);
  if (codes.includes("UNSAFE_ANCHOR")) return new NativeLockError("UNSAFE_ANCHOR");
  const knownSafeBusyCodes = ["LOCK_BUSY", "EAGAIN", "EWOULDBLOCK", "ERROR_LOCK_VIOLATION", "ERROR_SHARING_VIOLATION"];
  if (codes.some((code) => knownSafeBusyCodes.includes(code))) return new NativeLockError("LOCK_BUSY");
  return new NativeLockError("NATIVE_LOCK_ERROR");
}
function invokeNative(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeLockError) throw error;
    throw normalizeNativeError(error);
  }
}
function dataMethod(value, property, ownOnly = false) {
  const candidate = dataDescriptorValue(value, property, ownOnly);
  if (typeof candidate !== "function") fail2(ownOnly ? "ADDON_ABI" : "NATIVE_LOCK_ERROR");
  return candidate;
}
function wrapHandle(value) {
  if (!isObject(value)) fail2("NATIVE_LOCK_ERROR");
  const protect = dataMethod(value, "protectCompatibilityDirectory");
  const releaseCompatibility = dataMethod(value, "releaseCompatibilityDirectory");
  const release = dataMethod(value, "release");
  return Object.freeze({
    protectCompatibilityDirectory(lockPath) {
      invokeNative(() => Reflect.apply(protect, value, [lockPath]));
    },
    releaseCompatibilityDirectory() {
      invokeNative(() => Reflect.apply(releaseCompatibility, value, []));
    },
    release() {
      invokeNative(() => Reflect.apply(release, value, []));
    }
  });
}
function verifiedAddonExports(value, target) {
  if (!isObject(value)) fail2("ADDON_ABI");
  if (dataDescriptorValue(value, "abiVersion", true) !== 1) fail2("ADDON_ABI");
  const implementationMethod = dataMethod(value, "implementation", true);
  const acquire = dataMethod(value, "tryAcquireAnchor", true);
  let implementation;
  try {
    implementation = Reflect.apply(implementationMethod, value, []);
  } catch {
    fail2("ADDON_ABI");
  }
  const expectedImplementation = target.platform === "win32" ? "lockfileex" : "flock";
  if (implementation !== expectedImplementation) fail2("ADDON_ABI");
  return { raw: value, implementation: expectedImplementation, acquire, implementationMethod };
}
function wrapAddon(value, target) {
  const verified = verifiedAddonExports(value, target);
  return Object.freeze({
    targetId: target.id,
    implementation: verified.implementation,
    tryAcquireAnchor(anchorPath) {
      return invokeNative(() => wrapHandle(Reflect.apply(verified.acquire, verified.raw, [anchorPath])));
    }
  });
}
function loaderStateFor(runtime) {
  if (runtime.loadModule === void 0) return productionLoaderState;
  const existing = injectedLoaderStates.get(runtime.loadModule);
  if (existing !== void 0) return existing;
  const created = createLoaderState();
  injectedLoaderStates.set(runtime.loadModule, created);
  return created;
}
function isExpectedWindowsSharingFailure(result) {
  return result.phase === "addon" && ["EPERM", "EACCES", "EBUSY"].includes(result.code ?? "");
}
function inspectProductionRetention(runtime, loadedModule) {
  if (runtime.inspectProductionRetention === void 0) return;
  try {
    runtime.inspectProductionRetention((candidate) => retainedFailedModules.some((record2) => record2.loadedModule.holder === candidate) || retainedLoads.some((record2) => record2.loadedModule.provenance === "production" && record2.loadedModule.holder === candidate));
  } catch {
    fail2("ADDON_INTEGRITY");
  }
}
function preserveWindowsMappedStaging(runtime, target, lifecycle, loadedModule, retainFailure) {
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
async function performStagedLoad(runtime, target, sourcePath, source, sha2563) {
  await sweepStaleStaging(runtime);
  return withStagingSlot(runtime, async () => {
    const { lifecycle } = await createStagingLifecycle(runtime, target, sourcePath, source.bytes, sha2563);
    let loadedModule;
    let staged;
    let nativeLoadSucceeded = false;
    try {
      if (runtime.beforeStagedLoad) {
        await runtime.beforeStagedLoad({
          root: lifecycle.root,
          sourcePath,
          stagedPath: lifecycle.stagedPath,
          markerPath: lifecycle.markerPath,
          targetId: target.id,
          sha256: sha2563
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
          fail2("ADDON_INTEGRITY");
        }
      } else if (production && process.platform !== "win32") {
        const verified = verifiedAddonExports(loadedModule.rawAddon, target);
        let implementation;
        try {
          implementation = Reflect.apply(verified.implementationMethod, verified.raw, []);
        } catch {
          fail2("ADDON_INTEGRITY");
        }
        if (implementation !== verified.implementation) fail2("ADDON_INTEGRITY");
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
        const preserved = nativeLoadSucceeded && isExpectedWindowsSharingFailure(cleanup) && preserveWindowsMappedStaging(runtime, target, lifecycle, loadedModule, true);
        if (!preserved) {
          poisonStagingSlot(runtime, lifecycle.root);
          fail2("ADDON_INTEGRITY");
        }
      }
      if (error instanceof NativeLockError) throw error;
      fail2(nativeLoadSucceeded ? "ADDON_ABI" : "ADDON_INTEGRITY");
    }
  });
}
async function loadNativeLockAddon(runtime = {}) {
  const target = selectTarget(runtime);
  const assetsRoot = resolveAssetsRoot(runtime);
  const manifest = await readManifest(assetsRoot);
  const artifact = manifest.artifacts.find((entry) => entry.id === target.id);
  if (artifact === void 0) fail2("ADDON_INTEGRITY");
  const artifactPath = resolve2(assetsRoot, artifact.path);
  const pathKey = target.platform === "win32" ? artifactPath.toLowerCase() : artifactPath;
  const snapshot = await readVerifiedFile(artifactPath, ADDON_MAX_BYTES, "ADDON_MISSING", runtime.afterArtifactRead);
  if (artifact.bytes !== snapshot.bytes.length || artifact.sha256 !== createHash("sha256").update(snapshot.bytes).digest("hex")) {
    fail2("ADDON_INTEGRITY");
  }
  const sourceIdentity = [
    snapshotIdentity(pathKey, snapshot.entry),
    target.id,
    artifact.bytes,
    artifact.sha256
  ].join("\0");
  const state = loaderStateFor(runtime);
  const inFlight = state.inFlight.get(pathKey);
  if (inFlight !== void 0) {
    if (inFlight.identity !== sourceIdentity) fail2("ADDON_INTEGRITY");
    return inFlight.promise;
  }
  const boundIdentity = state.boundIdentities.get(pathKey);
  if (boundIdentity !== void 0 && boundIdentity !== sourceIdentity) fail2("ADDON_INTEGRITY");
  const cached = state.cache.get(sourceIdentity);
  if (cached !== void 0) return cached;
  let sharedPromise;
  sharedPromise = Promise.resolve().then(() => performStagedLoad(runtime, target, artifactPath, snapshot, artifact.sha256)).then((addon) => {
    state.boundIdentities.set(pathKey, sourceIdentity);
    state.cache.set(sourceIdentity, addon);
    return addon;
  }).finally(() => {
    if (state.inFlight.get(pathKey)?.promise === sharedPromise) state.inFlight.delete(pathKey);
  });
  state.inFlight.set(pathKey, { identity: sourceIdentity, promise: sharedPromise });
  return sharedPromise;
}
var ERROR_MESSAGES, RETRIABLE_ERROR_CODES, NativeLockError, TARGET_DEFINITIONS, TARGETS, MANIFEST_MAX_BYTES, ADDON_MAX_BYTES, MARKER_MAX_BYTES, STAGING_PREFIX, STALE_SWEEP_LIMIT, STAGING_CHMOD_ATTEMPTS, STAGING_CHMOD_RETRY_MS, MANIFEST_KEYS, ARTIFACT_KEYS, OWNER_KEYS, productionLoaderState, injectedLoaderStates, stagingSweeps, stagingChains, preservedStagingRoots, retainedLoads, retainedFailedModules;
var init_nativeLockAddon = __esm({
  "src/core/nativeLockAddon.ts"() {
    "use strict";
    ERROR_MESSAGES = Object.freeze({
      LOCK_BUSY: "The native lock is busy.",
      UNSAFE_ANCHOR: "The native lock anchor is unsafe.",
      NATIVE_LOCK_ERROR: "The native lock operation failed.",
      ADDON_MISSING: "The native lock addon is unavailable.",
      ADDON_INTEGRITY: "The native lock addon failed integrity verification.",
      ADDON_UNSUPPORTED: "The native lock addon is unsupported on this runtime.",
      ADDON_ABI: "The native lock addon interface is incompatible."
    });
    RETRIABLE_ERROR_CODES = /* @__PURE__ */ new Set(["LOCK_BUSY"]);
    NativeLockError = class extends Error {
      code;
      retriable;
      constructor(code) {
        super(ERROR_MESSAGES[code]);
        this.name = "NativeLockError";
        this.code = code;
        this.retriable = RETRIABLE_ERROR_CODES.has(code);
      }
    };
    TARGET_DEFINITIONS = [
      { id: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", rustTarget: "aarch64-apple-darwin", file: "tokengraph-lock.darwin-arm64.node", osFloor: "macos-11.0" },
      { id: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", rustTarget: "x86_64-apple-darwin", file: "tokengraph-lock.darwin-x64.node", osFloor: "macos-11.0" },
      { id: "linux-arm64-gnu", platform: "linux", arch: "arm64", libc: "glibc", rustTarget: "aarch64-unknown-linux-gnu", file: "tokengraph-lock.linux-arm64.node", osFloor: "kernel-4.18-glibc-2.28" },
      { id: "linux-x64-gnu", platform: "linux", arch: "x64", libc: "glibc", rustTarget: "x86_64-unknown-linux-gnu", file: "tokengraph-lock.linux-x64.node", osFloor: "kernel-4.18-glibc-2.28" },
      { id: "win32-arm64", platform: "win32", arch: "arm64", libc: "none", rustTarget: "aarch64-pc-windows-msvc", file: "tokengraph-lock.win32-arm64.node", osFloor: "windows-10" },
      { id: "win32-x64", platform: "win32", arch: "x64", libc: "none", rustTarget: "x86_64-pc-windows-msvc", file: "tokengraph-lock.win32-x64.node", osFloor: "windows-10-server-2016" }
    ];
    TARGETS = Object.freeze(TARGET_DEFINITIONS.map((target) => Object.freeze(target)));
    MANIFEST_MAX_BYTES = 256 * 1024;
    ADDON_MAX_BYTES = 64 * 1024 * 1024;
    MARKER_MAX_BYTES = 4 * 1024;
    STAGING_PREFIX = "tokengraph-native-addon-v1-";
    STALE_SWEEP_LIMIT = 32;
    STAGING_CHMOD_ATTEMPTS = 3;
    STAGING_CHMOD_RETRY_MS = 25;
    MANIFEST_KEYS = ["schemaVersion", "addonAbiVersion", "nodeApiVersion", "rustToolchain", "artifacts"];
    ARTIFACT_KEYS = ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor", "path", "bytes", "sha256"];
    OWNER_KEYS = ["schemaVersion", "pid", "targetId", "sha256", "addonFile"];
    productionLoaderState = createLoaderState();
    injectedLoaderStates = /* @__PURE__ */ new WeakMap();
    stagingSweeps = /* @__PURE__ */ new Map();
    stagingChains = /* @__PURE__ */ new Map();
    preservedStagingRoots = /* @__PURE__ */ new Map();
    retainedLoads = [];
    retainedFailedModules = [];
  }
});

// src/core/nativeLockProvider.ts
function getNativeLockAddon() {
  return loadNativeLockAddon();
}
var init_nativeLockProvider = __esm({
  "src/core/nativeLockProvider.ts"() {
    "use strict";
    init_nativeLockAddon();
  }
});

// src/core/fileLockLease.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { constants as constants3 } from "node:fs";
import {
  chmod as chmod2,
  lstat as lstat3,
  mkdir,
  open as open3,
  readdir as readdir2,
  rename,
  rmdir as rmdir2,
  unlink as unlink2
} from "node:fs/promises";
import { dirname as dirname3, join as join3, parse, relative as relative2, resolve as resolve3 } from "node:path";
function ownerRecoveryReceipt(runtime, lock) {
  return ownerRecoveryReceipts.get(runtime)?.get(lock.anchorPath);
}
function retainOwnerRecoveryReceipt(runtime, lock, record2) {
  let receipts = ownerRecoveryReceipts.get(runtime);
  if (receipts === void 0) {
    receipts = /* @__PURE__ */ new Map();
    ownerRecoveryReceipts.set(runtime, receipts);
  }
  receipts.set(lock.anchorPath, {
    pid: record2.pid,
    nonce: record2.nonce,
    relativeLegacyName: record2.relativeLegacyName,
    keyHash: record2.keyHash
  });
}
function clearOwnerRecoveryReceipt(runtime, lock) {
  const receipts = ownerRecoveryReceipts.get(runtime);
  receipts?.delete(lock.anchorPath);
  if (receipts?.size === 0) ownerRecoveryReceipts.delete(runtime);
}
function matchesOwnerRecoveryReceipt(receipt, record2) {
  return receipt.pid === record2.pid && receipt.nonce === record2.nonce && receipt.relativeLegacyName === record2.relativeLegacyName && receipt.keyHash === record2.keyHash;
}
function fail3(code) {
  throw new FileLockError(code);
}
function errno(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string" ? String(error.code) : "";
}
function isTransientWindowsDiagnostic(error, runtime) {
  return runtime.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(errno(error));
}
function validatePolicy(policy) {
  if (!Number.isSafeInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 1e4 || !Number.isSafeInteger(policy.waitMs) || policy.waitMs < 0 || policy.waitMs > 6e4 || !Number.isSafeInteger(policy.staleMs) || policy.staleMs < 3 || policy.staleMs > 864e5 || !Number.isSafeInteger(policy.heartbeatMs) || policy.heartbeatMs < 1 || policy.heartbeatMs * 3 >= policy.staleMs) {
    throw new TypeError("Invalid file lock policy.");
  }
}
function abortIfRequested(signal) {
  if (signal?.aborted) fail3("LOCK_ABORTED");
}
function iso(milliseconds) {
  const value = new Date(milliseconds).toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new RangeError("Invalid lock clock.");
  return value;
}
function validIso(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(record2, required, optional = []) {
  const actual = Object.keys(record2).sort();
  const allowed = [...required, ...optional];
  if (!required.every((key) => actual.includes(key)) || actual.some((key) => !allowed.includes(key))) return false;
  return true;
}
function parseFileLockLease(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (`${JSON.stringify(parsed)}
` !== text) return void 0;
  if (!isPlainRecord(parsed) || !exactKeys(
    parsed,
    ["schemaVersion", "pid", "nonce", "startedAt", "heartbeatAt"]
  )) return void 0;
  if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || typeof parsed.nonce !== "string" || !UUID_PATTERN.test(parsed.nonce) || !validIso(parsed.startedAt) || !validIso(parsed.heartbeatAt) || Date.parse(parsed.heartbeatAt) < Date.parse(parsed.startedAt)) return void 0;
  return parsed;
}
function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function parsePredecessor(value) {
  if (!isPlainRecord(value) || !exactKeys(value, ["generation", "identity"]) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || !validIdentity(value.identity)) {
    return void 0;
  }
  return value;
}
function parsePendingLeaseWrite(value) {
  if (!isPlainRecord(value) || !exactKeys(
    value,
    ["operation", "payloadSha256"],
    ["fromIdentity", "temporaryIdentity"]
  ) || !["create", "replace"].includes(String(value.operation)) || typeof value.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.payloadSha256) || value.temporaryIdentity !== void 0 && !validIdentity(value.temporaryIdentity)) return void 0;
  if (value.operation === "create" && value.fromIdentity !== void 0) return void 0;
  if (value.operation === "replace" && !validIdentity(value.fromIdentity)) return void 0;
  return value;
}
function parseLockRecoveryJournal(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (`${JSON.stringify(parsed)}
` !== text || !isPlainRecord(parsed) || parsed.schemaVersion !== 2 || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 0) return void 0;
  if (parsed.phase === "idle") {
    if (!exactKeys(parsed, ["schemaVersion", "generation", "phase"], ["predecessor"])) return void 0;
    if (parsed.generation === 0) {
      if (parsed.predecessor !== void 0) return void 0;
    } else {
      const predecessor2 = parsePredecessor(parsed.predecessor);
      if (predecessor2 === void 0 || predecessor2.generation !== Number(parsed.generation) - 1) return void 0;
    }
    return parsed;
  }
  if (!["intent", "barrier-created", "lease-created", "cleanup"].includes(String(parsed.phase)) || !exactKeys(
    parsed,
    [
      "schemaVersion",
      "generation",
      "predecessor",
      "relativeLegacyName",
      "keyHash",
      "pid",
      "nonce",
      "phase",
      "startedAt",
      "heartbeatAt"
    ],
    ["barrierIdentity", "leaseIdentity", "pendingBarrier", "pendingLeaseWrite"]
  )) return void 0;
  const predecessor = parsePredecessor(parsed.predecessor);
  if (Number(parsed.generation) === 0 || predecessor === void 0 || predecessor.generation !== Number(parsed.generation) - 1 || typeof parsed.relativeLegacyName !== "string" || typeof parsed.keyHash !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.keyHash) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || typeof parsed.nonce !== "string" || !UUID_PATTERN.test(parsed.nonce) || !validIso(parsed.startedAt) || !validIso(parsed.heartbeatAt) || Date.parse(parsed.heartbeatAt) < Date.parse(parsed.startedAt) || parsed.barrierIdentity !== void 0 && !validIdentity(parsed.barrierIdentity) || parsed.leaseIdentity !== void 0 && !validIdentity(parsed.leaseIdentity)) return void 0;
  const pendingBarrier = parsed.pendingBarrier;
  if (pendingBarrier !== void 0 && (!isPlainRecord(pendingBarrier) || !exactKeys(pendingBarrier, ["operation"]) || pendingBarrier.operation !== "create")) return void 0;
  const pendingLeaseWrite = parsed.pendingLeaseWrite === void 0 ? void 0 : parsePendingLeaseWrite(parsed.pendingLeaseWrite);
  if (parsed.pendingLeaseWrite !== void 0 && pendingLeaseWrite === void 0) return void 0;
  if (pendingBarrier !== void 0 && pendingLeaseWrite !== void 0) return void 0;
  if (parsed.phase === "intent") {
    if (parsed.barrierIdentity !== void 0 || parsed.leaseIdentity !== void 0 || pendingBarrier === void 0 || pendingLeaseWrite !== void 0) return void 0;
  } else if (parsed.phase === "barrier-created") {
    if (!validIdentity(parsed.barrierIdentity) || parsed.leaseIdentity !== void 0 || pendingBarrier !== void 0 || pendingLeaseWrite !== void 0 && pendingLeaseWrite.operation !== "create") return void 0;
  } else if (parsed.phase === "lease-created") {
    if (!validIdentity(parsed.barrierIdentity) || !validIdentity(parsed.leaseIdentity) || pendingBarrier !== void 0 || pendingLeaseWrite !== void 0 && (pendingLeaseWrite.operation !== "replace" || pendingLeaseWrite.fromIdentity !== parsed.leaseIdentity)) return void 0;
  } else if (!validIdentity(parsed.barrierIdentity) || pendingBarrier !== void 0 || pendingLeaseWrite !== void 0) {
    return void 0;
  }
  return parsed;
}
function activeJournal(record2) {
  return record2.phase !== "idle";
}
function sameActiveOwner(before, after) {
  return before.relativeLegacyName === after.relativeLegacyName && before.keyHash === after.keyHash && before.pid === after.pid && before.nonce === after.nonce && before.startedAt === after.startedAt && Date.parse(after.heartbeatAt) >= Date.parse(before.heartbeatAt);
}
function withoutGeneration(record2) {
  const copy = { ...record2 };
  delete copy.generation;
  delete copy.predecessor;
  return copy;
}
function sameRecordState(before, after) {
  return JSON.stringify(withoutGeneration(before)) === JSON.stringify(withoutGeneration(after));
}
function validLockRecoveryTransition(before, after, beforeIdentity) {
  if (after.generation !== before.generation + 1 || after.predecessor?.generation !== before.generation || after.predecessor.identity !== beforeIdentity) return false;
  if (before.phase === "idle") {
    return after.phase === "intent" && after.startedAt === after.heartbeatAt;
  }
  if (activeJournal(after) && !sameActiveOwner(before, after)) return false;
  if (before.barrierIdentity !== void 0 && activeJournal(after) && after.barrierIdentity !== before.barrierIdentity) return false;
  if (before.phase === "intent") {
    return after.phase === "idle" || after.phase === "barrier-created" && after.pendingLeaseWrite === void 0;
  }
  if (before.phase === "barrier-created") {
    const pending = before.pendingLeaseWrite;
    if (pending === void 0) {
      return after.phase === "barrier-created" && after.pendingLeaseWrite?.operation === "create" && after.pendingLeaseWrite.temporaryIdentity === void 0 || after.phase === "cleanup" && after.barrierIdentity === before.barrierIdentity && after.leaseIdentity === void 0;
    }
    if (after.phase === "barrier-created" && after.pendingLeaseWrite === void 0) return true;
    if (pending.temporaryIdentity === void 0) {
      return after.phase === "barrier-created" && after.pendingLeaseWrite?.operation === "create" && after.pendingLeaseWrite.payloadSha256 === pending.payloadSha256 && after.pendingLeaseWrite.temporaryIdentity !== void 0;
    }
    return after.phase === "lease-created" && after.pendingLeaseWrite === void 0 && after.leaseIdentity === pending.temporaryIdentity;
  }
  if (before.phase === "lease-created") {
    const pending = before.pendingLeaseWrite;
    if (pending === void 0) {
      return after.phase === "lease-created" && after.pendingLeaseWrite?.operation === "replace" && after.pendingLeaseWrite.fromIdentity === before.leaseIdentity && after.pendingLeaseWrite.temporaryIdentity === void 0 || after.phase === "cleanup" && after.barrierIdentity === before.barrierIdentity && after.leaseIdentity === before.leaseIdentity;
    }
    if (after.phase === "lease-created" && after.pendingLeaseWrite === void 0) {
      const rollback = sameRecordState(before, {
        ...after,
        pendingLeaseWrite: before.pendingLeaseWrite
      });
      return rollback || pending.temporaryIdentity !== void 0 && after.leaseIdentity === pending.temporaryIdentity;
    }
    return pending.temporaryIdentity === void 0 && after.phase === "lease-created" && after.pendingLeaseWrite?.operation === "replace" && after.pendingLeaseWrite.fromIdentity === pending.fromIdentity && after.pendingLeaseWrite.payloadSha256 === pending.payloadSha256 && after.pendingLeaseWrite.temporaryIdentity !== void 0;
  }
  if (before.leaseIdentity !== void 0) {
    return after.phase === "cleanup" && after.barrierIdentity === before.barrierIdentity && after.leaseIdentity === void 0;
  }
  return after.phase === "idle";
}
function keyHash(relativeName) {
  return createHash2("sha256").update(relativeName, "utf8").digest("hex");
}
function stableSnapshot(first, second) {
  return first.identity === second.identity && first.nlink === second.nlink && first.text === second.text;
}
function stale(heartbeatAt, runtime, policy) {
  const heartbeat = Date.parse(heartbeatAt);
  return heartbeat <= runtime.now() && runtime.now() - heartbeat > policy.staleMs;
}
async function retryDiagnostic(runtime, policy, signal, operation) {
  for (let attempt = 0; ; attempt += 1) {
    abortIfRequested(signal);
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsDiagnostic(error, runtime) || attempt >= 19) throw error;
      await runtime.wait(policy.waitMs, signal);
    }
  }
}
async function readStableFile(path, maximumBytes, runtime, policy, signal, unstableCode = "LOCK_LEASE_OCCUPIED") {
  const first = await retryDiagnostic(runtime, policy, signal, () => runtime.io.readFile(path, maximumBytes));
  if (first === void 0) return void 0;
  await runtime.wait(policy.waitMs, signal);
  const second = await retryDiagnostic(runtime, policy, signal, () => runtime.io.readFile(path, maximumBytes));
  if (second === void 0 || !stableSnapshot(first, second)) fail3(unstableCode);
  return [first, second];
}
async function confirmedDead(pid, heartbeatAt, runtime, policy) {
  if (!stale(heartbeatAt, runtime, policy)) return false;
  return await runtime.processLiveness(pid) === "dead";
}
function pathForJournal(lock, journal) {
  const candidate = resolve3(lock.domainRoot, journal.relativeLegacyName);
  const dataName = journal.relativeLegacyName.endsWith(".lock") ? journal.relativeLegacyName.slice(0, -".lock".length) : "";
  if (relative2(lock.domainRoot, candidate) !== journal.relativeLegacyName || dirname3(candidate) !== lock.domainRoot || journal.relativeLegacyName.includes("/") || journal.relativeLegacyName.includes("\\") || journal.relativeLegacyName === NATIVE_ANCHOR || journal.relativeLegacyName === NATIVE_JOURNAL || dataName.length === 0 || dataName === "." || dataName === ".." || /[<>:"|?*\u0000-\u001f]/u.test(dataName) || /[. ]$/u.test(dataName) || Buffer.byteLength(dataName, "utf8") > 240 || keyHash(journal.relativeLegacyName) !== journal.keyHash) {
    fail3("LOCK_JOURNAL_UNSAFE");
  }
  return candidate;
}
function validateDirectory2(snapshot, runtime, expectedIdentity, requireRestrictiveMode = true) {
  if (expectedIdentity !== void 0 && snapshot.identity !== expectedIdentity) fail3("UNSAFE_LOCK_DIRECTORY");
  if (snapshot.identity.length === 0 || requireRestrictiveMode && runtime.platform !== "win32" && (snapshot.mode & 63) !== 0) {
    fail3("UNSAFE_LOCK_DIRECTORY");
  }
}
async function validateRecoverableLease(leasePath, expectedNonce, expectedOwner, expectedIdentity, runtime, policy, signal, allowLiveOwner = false) {
  const pair = await readStableFile(leasePath, LEASE_MAX_BYTES, runtime, policy, signal);
  if (pair === void 0 || pair[1].nlink !== 1 || expectedIdentity !== void 0 && pair[1].identity !== expectedIdentity) {
    fail3("LOCK_LEASE_OCCUPIED");
  }
  const lease = parseFileLockLease(pair[1].text);
  if (lease === void 0 || lease.nonce !== expectedNonce || lease.pid !== expectedOwner.pid || lease.startedAt !== expectedOwner.startedAt || !allowLiveOwner && !await confirmedDead(lease.pid, lease.heartbeatAt, runtime, policy)) {
    fail3("LOCK_LEASE_OCCUPIED");
  }
  return { lease, snapshot: pair[1] };
}
function journalText(record2) {
  return `${JSON.stringify(record2)}
`;
}
function journalTemporaryPath(path) {
  return `${path}${WRITE_TEMPORARY_SUFFIX}`;
}
function leasePayloadHash(text) {
  return createHash2("sha256").update(text, "utf8").digest("hex");
}
function nextJournalRecord(state, value) {
  return {
    ...value,
    generation: state.record.generation + 1,
    predecessor: { generation: state.record.generation, identity: state.snapshot.identity }
  };
}
function ownsDomainRoot(lock) {
  return lock.domain !== "git-info";
}
async function classifyDomainRoot(lock, record2, runtime, policy) {
  const requireRestrictiveMode = ownsDomainRoot(lock);
  const root = await retryDiagnostic(
    runtime,
    policy,
    void 0,
    () => runtime.io.inspectDirectory(lock.domainRoot, requireRestrictiveMode)
  );
  if (root === void 0) fail3("UNSAFE_LOCK_DIRECTORY");
  validateDirectory2(root, runtime, void 0, requireRestrictiveMode);
  const allowedBarrier = record2 !== void 0 && activeJournal(record2) ? record2.relativeLegacyName : void 0;
  for (const entry of root.entries) {
    if (entry === NATIVE_ANCHOR || entry === NATIVE_JOURNAL || entry === `${NATIVE_JOURNAL}${WRITE_TEMPORARY_SUFFIX}` || entry === allowedBarrier) continue;
    if (entry.startsWith(".tokengraph-native-") || entry.endsWith(WRITE_TEMPORARY_SUFFIX)) {
      fail3("LOCK_JOURNAL_UNSAFE");
    }
    if (entry.endsWith(".lock")) {
      fail3(entry === lock.compatibilityPath.slice(lock.domainRoot.length + 1) ? "LEGACY_LOCK_BLOCKED" : "LOCK_JOURNAL_UNSAFE");
    }
  }
}
async function stableProtocolFile(path, maximumBytes, runtime, policy, code = "LOCK_JOURNAL_UNSAFE") {
  const pair = await readStableFile(path, maximumBytes, runtime, policy, void 0, code);
  if (pair === void 0) return void 0;
  if (pair[1].nlink !== 1 || pair[1].identity.length === 0 || runtime.platform !== "win32" && (pair[1].mode & 63) !== 0) fail3(code);
  return pair[1];
}
async function replaceAuthorizedTemporary(temporaryPath, targetPath, temporary, expectedTargetIdentity, runtime, policy) {
  return retryDiagnostic(runtime, policy, void 0, () => runtime.io.replaceFileFromTemporary(
    temporaryPath,
    targetPath,
    temporary.identity,
    expectedTargetIdentity
  ));
}
async function bootstrapJournalV2(lock, runtime, policy) {
  await classifyDomainRoot(lock, void 0, runtime, policy);
  const temporaryPath = journalTemporaryPath(lock.journalPath);
  let temporary = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (temporary !== void 0) {
    const parsed = parseLockRecoveryJournal(temporary.text);
    if (parsed === void 0) {
      await retryDiagnostic(runtime, policy, void 0, () => runtime.io.removeFile(temporaryPath, temporary.identity));
      temporary = void 0;
    } else if (parsed.phase !== "idle" || parsed.generation !== 0) {
      fail3("LOCK_JOURNAL_UNSAFE");
    }
  }
  if (temporary === void 0) {
    const generationZero = { schemaVersion: 2, generation: 0, phase: "idle" };
    temporary = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.createFileDurable(temporaryPath, journalText(generationZero))
    );
  }
  const snapshot = await replaceAuthorizedTemporary(
    temporaryPath,
    lock.journalPath,
    temporary,
    void 0,
    runtime,
    policy
  );
  const record2 = parseLockRecoveryJournal(snapshot.text);
  if (record2?.phase !== "idle" || record2.generation !== 0) fail3("LOCK_JOURNAL_UNSAFE");
  return { record: record2, snapshot };
}
async function recoverJournalSuccessorV2(lock, state, runtime, policy) {
  await classifyDomainRoot(lock, state.record, runtime, policy);
  const temporaryPath = journalTemporaryPath(lock.journalPath);
  const temporary = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (temporary === void 0) return state;
  const successor = parseLockRecoveryJournal(temporary.text);
  if (successor === void 0) {
    await retryDiagnostic(runtime, policy, void 0, () => runtime.io.removeFile(temporaryPath, temporary.identity));
    return state;
  }
  if (!validLockRecoveryTransition(state.record, successor, state.snapshot.identity)) fail3("LOCK_JOURNAL_UNSAFE");
  await validateRecoveredSuccessorPreconditions(lock, state, successor, runtime, policy);
  const snapshot = await replaceAuthorizedTemporary(
    temporaryPath,
    lock.journalPath,
    temporary,
    state.snapshot.identity,
    runtime,
    policy
  );
  return { record: successor, snapshot };
}
async function readJournalStateV2(lock, runtime, policy) {
  const pair = await readStableFile(lock.journalPath, JOURNAL_MAX_BYTES, runtime, policy, void 0, "LOCK_JOURNAL_UNSAFE");
  if (pair === void 0) return bootstrapJournalV2(lock, runtime, policy);
  const snapshot = pair[1];
  if (snapshot.nlink !== 1 || runtime.platform !== "win32" && (snapshot.mode & 63) !== 0) {
    fail3("LOCK_JOURNAL_UNSAFE");
  }
  const record2 = parseLockRecoveryJournal(snapshot.text);
  if (record2 === void 0) fail3("LOCK_JOURNAL_UNSAFE");
  if (activeJournal(record2)) pathForJournal(lock, record2);
  return recoverJournalSuccessorV2(lock, { record: record2, snapshot }, runtime, policy);
}
async function commitJournalV2(lock, state, successor, runtime, policy) {
  if (!validLockRecoveryTransition(state.record, successor, state.snapshot.identity)) fail3("LOCK_JOURNAL_UNSAFE");
  if (activeJournal(successor)) pathForJournal(lock, successor);
  await classifyDomainRoot(lock, state.record, runtime, policy);
  const temporaryPath = journalTemporaryPath(lock.journalPath);
  let temporary = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (temporary !== void 0) {
    const parsed = parseLockRecoveryJournal(temporary.text);
    if (parsed === void 0) {
      await retryDiagnostic(runtime, policy, void 0, () => runtime.io.removeFile(temporaryPath, temporary.identity));
      temporary = void 0;
    } else if (JSON.stringify(parsed) !== JSON.stringify(successor) || !validLockRecoveryTransition(state.record, parsed, state.snapshot.identity)) {
      fail3("LOCK_JOURNAL_UNSAFE");
    }
  }
  if (temporary === void 0) {
    temporary = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.createFileDurable(temporaryPath, journalText(successor))
    );
  }
  const reread = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (reread?.identity !== temporary.identity || reread.text !== journalText(successor)) fail3("LOCK_JOURNAL_UNSAFE");
  let snapshot;
  try {
    snapshot = await replaceAuthorizedTemporary(
      temporaryPath,
      lock.journalPath,
      reread,
      state.snapshot.identity,
      runtime,
      policy
    );
  } catch (error) {
    const committed = await stableProtocolFile(lock.journalPath, JOURNAL_MAX_BYTES, runtime, policy);
    if (committed?.identity !== reread.identity || committed.text !== journalText(successor)) throw error;
    await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.flushParentDirectory(lock.journalPath)
    );
    snapshot = committed;
  }
  return { record: successor, snapshot };
}
function activeWithoutPending(record2) {
  const copy = { ...record2 };
  delete copy.pendingBarrier;
  delete copy.pendingLeaseWrite;
  return copy;
}
function leasePayloadForJournal(text, record2, operation) {
  const lease = parseFileLockLease(text);
  if (lease === void 0 || lease.pid !== record2.pid || lease.nonce !== record2.nonce || lease.startedAt !== record2.startedAt || Date.parse(lease.heartbeatAt) < Date.parse(record2.heartbeatAt) || operation === "create" && lease.heartbeatAt !== record2.heartbeatAt) {
    fail3("LOCK_LEASE_OCCUPIED");
  }
  return lease;
}
function currentLeaseForJournal(snapshot, record2) {
  if (snapshot === void 0 || snapshot.identity !== record2.leaseIdentity) fail3("LOCK_LEASE_OCCUPIED");
  const lease = parseFileLockLease(snapshot.text);
  if (lease === void 0 || lease.pid !== record2.pid || lease.nonce !== record2.nonce || lease.startedAt !== record2.startedAt || lease.heartbeatAt !== record2.heartbeatAt) {
    fail3("LOCK_LEASE_OCCUPIED");
  }
  return lease;
}
async function inspectBarrierClosed(lock, record2, runtime, policy) {
  const barrier = await retryDiagnostic(
    runtime,
    policy,
    void 0,
    () => runtime.io.inspectDirectory(lock.compatibilityPath)
  );
  if (barrier === void 0) return void 0;
  validateDirectory2(barrier, runtime, record2.barrierIdentity);
  const allowed = /* @__PURE__ */ new Set();
  if (record2.leaseIdentity !== void 0 || record2.pendingLeaseWrite !== void 0) allowed.add("lease.json");
  if (record2.pendingLeaseWrite !== void 0) allowed.add(`lease.json${WRITE_TEMPORARY_SUFFIX}`);
  if (barrier.entries.some((entry) => !allowed.has(entry))) fail3("LOCK_JOURNAL_UNSAFE");
  return barrier;
}
async function validateRecoveredSuccessorPreconditions(lock, state, successor, runtime, policy) {
  const before = state.record;
  if (before.phase === "idle") {
    if (!activeJournal(successor)) fail3("LOCK_JOURNAL_UNSAFE");
    const barrierPath2 = pathForJournal(lock, successor);
    const barrier2 = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.inspectDirectory(barrierPath2)
    );
    if (barrier2 !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
    return;
  }
  const barrierPath = pathForJournal(lock, before);
  const recoveryLock = barrierPath === lock.compatibilityPath ? lock : { ...lock, compatibilityPath: barrierPath };
  if (activeJournal(successor) && pathForJournal(lock, successor) !== barrierPath) fail3("LOCK_JOURNAL_UNSAFE");
  if (before.phase === "intent") {
    const barrier2 = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.inspectDirectory(barrierPath)
    );
    if (successor.phase === "idle") {
      if (barrier2 !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (barrier2 === void 0) fail3("LOCK_JOURNAL_UNSAFE");
    validateDirectory2(barrier2, runtime, successor.barrierIdentity);
    if (barrier2.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
    return;
  }
  const barrier = await inspectBarrierClosed(recoveryLock, before, runtime, policy);
  const leasePath = join3(barrierPath, "lease.json");
  const temporaryPath = journalTemporaryPath(leasePath);
  const target = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
  const temporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (before.phase === "barrier-created") {
    if (barrier === void 0) fail3("LOCK_JOURNAL_UNSAFE");
    const pending = before.pendingLeaseWrite;
    if (pending === void 0) {
      if (target !== void 0 || temporary !== void 0 || barrier.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (successor.phase === "barrier-created" && successor.pendingLeaseWrite?.temporaryIdentity !== void 0) {
      if (target !== void 0 || temporary?.identity !== successor.pendingLeaseWrite.temporaryIdentity || leasePayloadHash(temporary.text) !== pending.payloadSha256) fail3("LOCK_JOURNAL_UNSAFE");
      leasePayloadForJournal(temporary.text, before, "create");
      return;
    }
    if (successor.phase === "barrier-created") {
      if (target !== void 0 || temporary !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (successor.phase === "lease-created") {
      if (temporary !== void 0 || target === void 0 || target.identity !== pending.temporaryIdentity || leasePayloadHash(target.text) !== pending.payloadSha256) fail3("LOCK_JOURNAL_UNSAFE");
      const lease = leasePayloadForJournal(target.text, before, "create");
      if (successor.heartbeatAt !== lease.heartbeatAt) fail3("LOCK_JOURNAL_UNSAFE");
      return;
    }
    fail3("LOCK_JOURNAL_UNSAFE");
  }
  if (before.phase === "lease-created") {
    const pending = before.pendingLeaseWrite;
    if (pending === void 0) {
      currentLeaseForJournal(target, before);
      if (temporary !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (successor.phase === "lease-created" && successor.pendingLeaseWrite?.temporaryIdentity !== void 0) {
      currentLeaseForJournal(target, before);
      if (temporary?.identity !== successor.pendingLeaseWrite.temporaryIdentity || leasePayloadHash(temporary.text) !== pending.payloadSha256) fail3("LOCK_JOURNAL_UNSAFE");
      leasePayloadForJournal(temporary.text, before, "replace");
      return;
    }
    if (successor.phase === "lease-created" && successor.pendingLeaseWrite === void 0) {
      if (successor.leaseIdentity === before.leaseIdentity) {
        currentLeaseForJournal(target, before);
        if (temporary !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
        return;
      }
      if (temporary !== void 0 || target === void 0 || target.identity !== pending.temporaryIdentity || leasePayloadHash(target.text) !== pending.payloadSha256) fail3("LOCK_JOURNAL_UNSAFE");
      const lease = leasePayloadForJournal(target.text, before, "replace");
      if (successor.heartbeatAt !== lease.heartbeatAt) fail3("LOCK_JOURNAL_UNSAFE");
      return;
    }
    fail3("LOCK_JOURNAL_UNSAFE");
  }
  if (before.leaseIdentity !== void 0) {
    if (target !== void 0 || temporary !== void 0 || barrier?.entries.length !== 0) {
      fail3("LOCK_JOURNAL_UNSAFE");
    }
    return;
  }
  if (barrier !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
}
async function resolvePendingLeaseV2(lock, state, runtime, policy) {
  const pending = state.record.pendingLeaseWrite;
  if (pending === void 0) return state;
  await inspectBarrierClosed(lock, state.record, runtime, policy);
  const leasePath = join3(lock.compatibilityPath, "lease.json");
  const temporaryPath = journalTemporaryPath(leasePath);
  const target = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
  let temporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (pending.temporaryIdentity === void 0) {
    if (pending.operation === "create") {
      if (target !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
    } else {
      currentLeaseForJournal(target, state.record);
    }
    if (temporary !== void 0) {
      await retryDiagnostic(runtime, policy, void 0, () => runtime.io.removeFile(temporaryPath, temporary.identity));
      temporary = void 0;
    }
    const successor2 = nextJournalRecord(state, activeWithoutPending(state.record));
    return await commitJournalV2(lock, state, successor2, runtime, policy);
  }
  let committedLease;
  if (temporary !== void 0) {
    if (temporary.identity !== pending.temporaryIdentity || leasePayloadHash(temporary.text) !== pending.payloadSha256) {
      fail3("LOCK_JOURNAL_UNSAFE");
    }
    committedLease = leasePayloadForJournal(temporary.text, state.record, pending.operation);
    const targetAllowed = pending.operation === "create" ? target === void 0 : target?.identity === pending.fromIdentity;
    if (!targetAllowed) fail3("LOCK_JOURNAL_UNSAFE");
    await inspectBarrierClosed(lock, state.record, runtime, policy);
    await replaceAuthorizedTemporary(
      temporaryPath,
      leasePath,
      temporary,
      pending.operation === "create" ? void 0 : pending.fromIdentity,
      runtime,
      policy
    );
  } else {
    const alreadyCommitted = target?.identity === pending.temporaryIdentity && leasePayloadHash(target.text) === pending.payloadSha256;
    if (!alreadyCommitted) {
      if (pending.operation === "create") {
        if (target !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
      } else {
        currentLeaseForJournal(target, state.record);
      }
      const rollback = nextJournalRecord(state, activeWithoutPending(state.record));
      return await commitJournalV2(lock, state, rollback, runtime, policy);
    }
    committedLease = leasePayloadForJournal(target.text, state.record, pending.operation);
  }
  const successorBase = activeWithoutPending(state.record);
  const successor = nextJournalRecord(state, {
    ...successorBase,
    phase: "lease-created",
    leaseIdentity: pending.temporaryIdentity,
    heartbeatAt: committedLease.heartbeatAt
  });
  return await commitJournalV2(lock, state, successor, runtime, policy);
}
async function commitBarrierOnlyCleanupV2(lock, state, runtime, policy) {
  const { leaseIdentity: _leaseIdentity, ...barrierOnly } = activeWithoutPending(state.record);
  const successor = nextJournalRecord(state, {
    ...barrierOnly,
    phase: "cleanup"
  });
  return await commitJournalV2(lock, state, successor, runtime, policy);
}
async function finishBarrierCleanupV2(lock, state, runtime, policy, handle) {
  const barrier = await inspectBarrierClosed(lock, state.record, runtime, policy);
  if (barrier !== void 0 && barrier.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
  handle?.releaseCompatibilityDirectory();
  if (barrier !== void 0) {
    await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.removeDirectory(lock.compatibilityPath, state.record.barrierIdentity)
    );
  }
  const successor = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
  return commitJournalV2(lock, state, successor, runtime, policy);
}
async function recoverActiveJournalV2(lock, initial, runtime, policy) {
  let state = initial;
  const receipt = ownerRecoveryReceipt(runtime, lock);
  const sameOwnerRecovery = receipt !== void 0 && matchesOwnerRecoveryReceipt(receipt, state.record);
  if (receipt !== void 0 && !sameOwnerRecovery) clearOwnerRecoveryReceipt(runtime, lock);
  if (!sameOwnerRecovery && !await confirmedDead(state.record.pid, state.record.heartbeatAt, runtime, policy)) {
    fail3("LOCK_JOURNAL_UNSAFE");
  }
  const recordedBarrierPath = pathForJournal(lock, state.record);
  const recoveryLock = recordedBarrierPath === lock.compatibilityPath ? lock : {
    ...lock,
    compatibilityPath: recordedBarrierPath
  };
  if (state.record.phase === "intent") {
    const barrier = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.inspectDirectory(recoveryLock.compatibilityPath)
    );
    if (barrier === void 0) {
      const idle = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
      return commitJournalV2(lock, state, idle, runtime, policy);
    }
    validateDirectory2(barrier, runtime);
    if (barrier.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
    const adopted = nextJournalRecord(state, {
      ...activeWithoutPending(state.record),
      phase: "barrier-created",
      barrierIdentity: barrier.identity
    });
    state = await commitJournalV2(recoveryLock, state, adopted, runtime, policy);
  }
  if (state.record.pendingLeaseWrite !== void 0) {
    state = await resolvePendingLeaseV2(recoveryLock, state, runtime, policy);
  }
  if (state.record.phase === "barrier-created") {
    const barrier = await inspectBarrierClosed(recoveryLock, state.record, runtime, policy);
    if (barrier === void 0 || barrier.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(recoveryLock, state, runtime, policy);
  } else if (state.record.phase === "lease-created") {
    const leasePath = join3(recoveryLock.compatibilityPath, "lease.json");
    const recovered = await validateRecoverableLease(
      leasePath,
      state.record.nonce,
      state.record,
      state.record.leaseIdentity,
      runtime,
      policy,
      void 0,
      sameOwnerRecovery
    );
    const cleanup = nextJournalRecord(state, {
      ...activeWithoutPending(state.record),
      phase: "cleanup",
      leaseIdentity: recovered.snapshot.identity
    });
    state = await commitJournalV2(recoveryLock, state, cleanup, runtime, policy);
  }
  if (state.record.phase === "cleanup" && state.record.leaseIdentity !== void 0) {
    const barrier = await inspectBarrierClosed(recoveryLock, state.record, runtime, policy);
    if (barrier === void 0) fail3("LOCK_JOURNAL_UNSAFE");
    const leasePath = join3(recoveryLock.compatibilityPath, "lease.json");
    const lease = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
    if (lease !== void 0) {
      const parsed = parseFileLockLease(lease.text);
      if (lease.identity !== state.record.leaseIdentity || parsed?.nonce !== state.record.nonce) {
        fail3("LOCK_LEASE_OCCUPIED");
      }
      await retryDiagnostic(runtime, policy, void 0, () => runtime.io.removeFile(leasePath, lease.identity));
    }
    const empty = await inspectBarrierClosed(recoveryLock, state.record, runtime, policy);
    if (empty === void 0 || empty.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(recoveryLock, state, runtime, policy);
  }
  if (state.record.phase === "cleanup") return finishBarrierCleanupV2(recoveryLock, state, runtime, policy);
  fail3("LOCK_JOURNAL_UNSAFE");
}
async function reconcileJournalV2(lock, runtime, policy) {
  let state = await readJournalStateV2(lock, runtime, policy);
  if (state.record.phase !== "idle") state = await recoverActiveJournalV2(lock, state, runtime, policy);
  if (state.record.phase !== "idle") fail3("LOCK_JOURNAL_UNSAFE");
  clearOwnerRecoveryReceipt(runtime, lock);
  await classifyDomainRoot(lock, state.record, runtime, policy);
  return state;
}
async function acquireNative(lock, runtime, policy, signal) {
  const addon = await runtime.loadAddon();
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    abortIfRequested(signal);
    try {
      return addon.tryAcquireAnchor(lock.anchorPath);
    } catch (error) {
      const busy = error instanceof NativeLockError ? error.code === "LOCK_BUSY" : typeof error === "object" && error !== null && error.code === "LOCK_BUSY";
      if (!busy) throw error;
      if (attempt + 1 >= policy.attempts) fail3("LOCK_TIMEOUT");
      await runtime.wait(policy.waitMs, signal).catch((waitError) => {
        if (signal?.aborted || errno(waitError) === "ABORT_ERR") fail3("LOCK_ABORTED");
        throw waitError;
      });
    }
  }
  fail3("LOCK_TIMEOUT");
}
async function writeLeaseTransactionV2(lock, state, text, operation, runtime, policy) {
  const lease = leasePayloadForJournal(text, state.record, operation);
  const leasePath = join3(lock.compatibilityPath, "lease.json");
  const temporaryPath = journalTemporaryPath(leasePath);
  const fromIdentity = operation === "replace" ? state.record.leaseIdentity : void 0;
  await inspectBarrierClosed(lock, state.record, runtime, policy);
  const preflightTarget = await stableProtocolFile(
    leasePath,
    LEASE_MAX_BYTES,
    runtime,
    policy,
    "LOCK_LEASE_OCCUPIED"
  );
  if (operation === "create") {
    if (preflightTarget !== void 0) fail3("LOCK_LEASE_OCCUPIED");
  } else {
    currentLeaseForJournal(preflightTarget, state.record);
  }
  const preflightTemporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (preflightTemporary !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
  const pending = {
    operation,
    ...fromIdentity === void 0 ? {} : { fromIdentity },
    payloadSha256: leasePayloadHash(text)
  };
  const pendingRecord = nextJournalRecord(state, { ...activeWithoutPending(state.record), pendingLeaseWrite: pending });
  let current = await commitJournalV2(lock, state, pendingRecord, runtime, policy);
  await inspectBarrierClosed(lock, current.record, runtime, policy);
  const existingTarget = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
  if (operation === "create" ? existingTarget !== void 0 : existingTarget?.identity !== fromIdentity) {
    fail3("LOCK_LEASE_OCCUPIED");
  }
  const existingTemporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (existingTemporary !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
  const temporary = await retryDiagnostic(
    runtime,
    policy,
    void 0,
    () => runtime.io.createFileDurable(temporaryPath, text)
  );
  const stableTemporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (stableTemporary?.identity !== temporary.identity || stableTemporary.text !== text) fail3("LOCK_JOURNAL_UNSAFE");
  const recordedPending = { ...pending, temporaryIdentity: temporary.identity };
  const recorded = nextJournalRecord(current, {
    ...activeWithoutPending(current.record),
    pendingLeaseWrite: recordedPending
  });
  current = await commitJournalV2(lock, current, recorded, runtime, policy);
  await inspectBarrierClosed(lock, current.record, runtime, policy);
  await replaceAuthorizedTemporary(
    temporaryPath,
    leasePath,
    stableTemporary,
    operation === "create" ? void 0 : fromIdentity,
    runtime,
    policy
  );
  const finalized = nextJournalRecord(current, {
    ...activeWithoutPending(current.record),
    phase: "lease-created",
    leaseIdentity: temporary.identity,
    heartbeatAt: lease.heartbeatAt
  });
  return await commitJournalV2(lock, current, finalized, runtime, policy);
}
async function cleanupOwnedStateV2(lock, owned, handle, runtime, policy) {
  let state = owned.journal;
  if (state.record.pendingLeaseWrite !== void 0) {
    state = await resolvePendingLeaseV2(lock, state, runtime, policy);
    owned.journal = state;
  }
  if (state.record.phase === "intent") {
    const barrier2 = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.inspectDirectory(lock.compatibilityPath)
    );
    if (barrier2 === void 0) {
      const idle2 = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
      await commitJournalV2(lock, state, idle2, runtime, policy);
      return;
    }
    validateDirectory2(barrier2, runtime, owned.pendingBarrierIdentity);
    if (barrier2.entries.length !== 0 || owned.pendingBarrierIdentity === void 0) fail3("LOCK_JOURNAL_UNSAFE");
    const adopted = nextJournalRecord(state, {
      ...activeWithoutPending(state.record),
      phase: "barrier-created",
      barrierIdentity: barrier2.identity
    });
    state = await commitJournalV2(lock, state, adopted, runtime, policy);
    owned.journal = state;
  }
  if (state.record.phase === "barrier-created") {
    const barrier2 = await inspectBarrierClosed(lock, state.record, runtime, policy);
    if (barrier2 === void 0 || barrier2.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(lock, state, runtime, policy);
    owned.journal = state;
  } else if (state.record.phase === "lease-created") {
    const leasePath = join3(lock.compatibilityPath, "lease.json");
    const lease = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
    const parsed = lease === void 0 ? void 0 : parseFileLockLease(lease.text);
    if (lease === void 0 || lease.identity !== state.record.leaseIdentity || parsed?.nonce !== state.record.nonce) {
      fail3("LOCK_LEASE_OCCUPIED");
    }
    const cleanup = nextJournalRecord(state, {
      ...activeWithoutPending(state.record),
      phase: "cleanup",
      leaseIdentity: lease.identity
    });
    state = await commitJournalV2(lock, state, cleanup, runtime, policy);
    owned.journal = state;
    await retryDiagnostic(runtime, policy, void 0, () => runtime.io.removeFile(leasePath, lease.identity));
    const empty = await inspectBarrierClosed(lock, state.record, runtime, policy);
    if (empty === void 0 || empty.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(lock, state, runtime, policy);
    owned.journal = state;
  }
  if (state.record.phase !== "cleanup" || state.record.leaseIdentity !== void 0) fail3("LOCK_JOURNAL_UNSAFE");
  const barrier = await inspectBarrierClosed(lock, state.record, runtime, policy);
  if (barrier === void 0 || barrier.entries.length !== 0) fail3("LOCK_JOURNAL_UNSAFE");
  if (owned.compatibilityProtected) {
    handle.releaseCompatibilityDirectory();
    owned.compatibilityProtected = false;
  }
  await retryDiagnostic(
    runtime,
    policy,
    void 0,
    () => runtime.io.removeDirectory(lock.compatibilityPath, state.record.barrierIdentity)
  );
  const idle = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
  await commitJournalV2(lock, state, idle, runtime, policy);
}
async function runOwnedV2(lock, operation, options, runtime, policy) {
  abortIfRequested(options.signal);
  await retryDiagnostic(
    runtime,
    policy,
    options.signal,
    () => runtime.io.ensureDirectory(lock.domainRoot, ownsDomainRoot(lock))
  );
  const handle = await acquireNative(lock, runtime, policy, options.signal);
  let owned;
  let heartbeat;
  let lifecycle = Promise.resolve();
  let result;
  let operationError;
  let operationFailed = false;
  let cleanupError;
  let cleanupFailed = false;
  const serialized = (callback) => {
    const current = lifecycle.then(callback, callback);
    lifecycle = current.then(() => void 0, () => void 0);
    return current;
  };
  try {
    const idleJournal = await reconcileJournalV2(lock, runtime, policy);
    const existing = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.inspectDirectory(lock.compatibilityPath)
    );
    if (existing !== void 0) fail3("LEGACY_LOCK_BLOCKED");
    const now = runtime.now();
    const nonce = runtime.randomUUID();
    if (!UUID_PATTERN.test(nonce)) throw new TypeError("Lock runtime returned an invalid nonce.");
    const relativeName = relativeLegacyName(lock);
    const intent = nextJournalRecord(idleJournal, {
      schemaVersion: 2,
      relativeLegacyName: relativeName,
      keyHash: keyHash(relativeName),
      pid: runtime.pid,
      nonce,
      phase: "intent",
      startedAt: iso(now),
      heartbeatAt: iso(now),
      pendingBarrier: { operation: "create" }
    });
    let journal = await commitJournalV2(lock, idleJournal, intent, runtime, policy);
    const currentOwned = { journal, compatibilityProtected: false };
    owned = currentOwned;
    const barrier = await retryDiagnostic(
      runtime,
      policy,
      void 0,
      () => runtime.io.createDirectory(lock.compatibilityPath)
    );
    validateDirectory2(barrier, runtime);
    currentOwned.pendingBarrierIdentity = barrier.identity;
    const barrierRecord = nextJournalRecord(journal, {
      ...activeWithoutPending(journal.record),
      phase: "barrier-created",
      barrierIdentity: barrier.identity
    });
    journal = await commitJournalV2(lock, journal, barrierRecord, runtime, policy);
    currentOwned.journal = journal;
    currentOwned.pendingBarrierIdentity = void 0;
    handle.protectCompatibilityDirectory(lock.compatibilityPath);
    currentOwned.compatibilityProtected = true;
    const lease = {
      schemaVersion: 1,
      pid: runtime.pid,
      nonce,
      startedAt: journal.record.startedAt,
      heartbeatAt: journal.record.heartbeatAt
    };
    journal = await writeLeaseTransactionV2(
      lock,
      journal,
      `${JSON.stringify(lease)}
`,
      "create",
      runtime,
      policy
    );
    currentOwned.journal = journal;
    const leasePath = join3(lock.compatibilityPath, "lease.json");
    heartbeat = runtime.scheduleHeartbeat(policy.heartbeatMs, async () => serialized(async () => {
      if (owned === void 0 || owned.journal.record.phase !== "lease-created") return;
      const current = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
      const currentLease = current === void 0 ? void 0 : parseFileLockLease(current.text);
      if (current === void 0 || current.identity !== owned.journal.record.leaseIdentity || currentLease === void 0 || currentLease.nonce !== nonce) fail3("LOCK_LEASE_OCCUPIED");
      const heartbeatAt = iso(Math.max(
        runtime.now(),
        Date.parse(currentLease.startedAt),
        Date.parse(currentLease.heartbeatAt)
      ));
      const replacement = { ...currentLease, heartbeatAt };
      owned.journal = await writeLeaseTransactionV2(
        lock,
        owned.journal,
        `${JSON.stringify(replacement)}
`,
        "replace",
        runtime,
        policy
      );
    }));
    result = await operation();
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }
  try {
    if (heartbeat !== void 0) await heartbeat.stop();
    await lifecycle;
    if (owned !== void 0) {
      const refreshed = await readJournalStateV2(lock, runtime, policy);
      if (refreshed.record.phase === "idle") {
        owned = void 0;
      } else {
        owned.journal = refreshed;
        await cleanupOwnedStateV2(lock, owned, handle, runtime, policy);
      }
    }
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
    if (owned !== void 0) retainOwnerRecoveryReceipt(runtime, lock, owned.journal.record);
  }
  if (owned?.compatibilityProtected) {
    try {
      handle.releaseCompatibilityDirectory();
      owned.compatibilityProtected = false;
    } catch (error) {
      if (!cleanupFailed) cleanupError = error;
      cleanupFailed = true;
    }
  }
  try {
    handle.release();
  } catch (error) {
    if (!cleanupFailed) cleanupError = error;
    cleanupFailed = true;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError([operationError, cleanupError], "Persistence operation and lock cleanup both failed.");
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return result;
}
function enqueueExactPath(path, operation, options, runtime, policy) {
  let resolveCaller;
  let rejectCaller;
  const caller = new Promise((resolvePromise, rejectPromise) => {
    resolveCaller = resolvePromise;
    rejectCaller = rejectPromise;
  });
  const node = {
    operation,
    runtime,
    signal: options.signal,
    resolve: resolveCaller,
    reject: rejectCaller,
    controller: new AbortController(),
    started: false,
    canceled: false
  };
  const detach = () => {
    if (node.abortListener !== void 0) node.signal?.removeEventListener("abort", node.abortListener);
    node.controller?.abort();
    node.operation = void 0;
    node.runtime = void 0;
    node.signal = void 0;
    node.resolve = void 0;
    node.reject = void 0;
    node.controller = void 0;
    node.abortListener = void 0;
  };
  const finish = (queue) => {
    while (queue.waiting.length > 0) {
      const next = queue.waiting.shift();
      if (next.canceled) continue;
      queue.active = next;
      start(queue, next);
      return;
    }
    if (sameProcessQueues.get(path) === queue) sameProcessQueues.delete(path);
  };
  const start = (queue, current) => {
    current.started = true;
    if (current.abortListener !== void 0) current.signal?.removeEventListener("abort", current.abortListener);
    current.controller?.abort();
    current.abortListener = void 0;
    current.controller = void 0;
    current.signal = void 0;
    const currentOperation = current.operation;
    const resolveCurrent = current.resolve;
    const rejectCurrent = current.reject;
    current.operation = void 0;
    current.runtime = void 0;
    current.resolve = void 0;
    current.reject = void 0;
    void (async () => {
      try {
        resolveCurrent(await currentOperation());
      } catch (error) {
        rejectCurrent(error);
      } finally {
        finish(queue);
      }
    })();
  };
  const existing = sameProcessQueues.get(path);
  if (existing === void 0) {
    const queue = { active: node, waiting: [] };
    sameProcessQueues.set(path, queue);
    start(queue, node);
    return caller;
  }
  const cancel = (code) => {
    if (node.canceled || node.started) return;
    node.canceled = true;
    const index = existing.waiting.indexOf(node);
    if (index >= 0) existing.waiting.splice(index, 1);
    const rejectCurrent = node.reject;
    detach();
    rejectCurrent?.(new FileLockError(code));
  };
  node.abortListener = () => cancel("LOCK_ABORTED");
  node.signal?.addEventListener("abort", node.abortListener, { once: true });
  existing.waiting.push(node);
  if (node.signal?.aborted) {
    cancel("LOCK_ABORTED");
  } else {
    const controller = node.controller;
    void runtime.wait(policy.attempts * policy.waitMs, controller.signal).then(
      () => cancel("LOCK_TIMEOUT"),
      () => {
        if (node.signal?.aborted) cancel("LOCK_ABORTED");
      }
    );
  }
  return caller;
}
function validateInvocation(lock, capability, policy) {
  if (!isLegacyRuntimeShutdownCapability(capability)) fail3("LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED");
  if (!isCanonicalPersistenceLock(lock)) fail3("INVALID_PERSISTENCE_LOCK");
  validatePolicy(policy);
}
async function runWithFileLock(lock, operation, options = {}) {
  const capability = requireLegacyRuntimeShutdownCapability();
  validateInvocation(lock, capability, DEFAULT_FILE_LOCK_POLICY);
  return enqueueExactPath(
    lock.compatibilityPath,
    () => runOwnedV2(lock, operation, options, productionRuntime, DEFAULT_FILE_LOCK_POLICY),
    options,
    productionRuntime,
    DEFAULT_FILE_LOCK_POLICY
  );
}
function identity(stats) {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}
function restrictive(stats, directory, requireRestrictiveMode = true) {
  if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())) return false;
  if (!directory && stats.nlink !== 1n) return false;
  if (process.platform !== "win32") {
    const forbidden = requireRestrictiveMode ? 63 : 18;
    if ((Number(stats.mode) & forbidden) !== 0) return false;
    const uid = process.getuid?.();
    if (uid === void 0 || stats.uid !== BigInt(uid)) return false;
  }
  return true;
}
async function flushDirectory(path) {
  let handle;
  try {
    handle = await open3(path, constants3.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "EPERM", "EACCES", "EBADF", "ENOTSUP"].includes(errno(error))) throw error;
  } finally {
    await handle?.close();
  }
}
async function productionReadFile(path, maximumBytes) {
  let before;
  try {
    before = await lstat3(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return void 0;
    throw error;
  }
  if (!restrictive(before, false) || before.size > BigInt(maximumBytes)) fail3("LOCK_LEASE_OCCUPIED");
  const noFollow = "O_NOFOLLOW" in constants3 ? constants3.O_NOFOLLOW : 0;
  const handle = await open3(path, constants3.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!restrictive(opened, false) || identity(opened) !== identity(before) || opened.size > BigInt(maximumBytes)) {
      fail3("LOCK_LEASE_OCCUPIED");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (identity(after) !== identity(opened) || bytes.length > maximumBytes) fail3("LOCK_LEASE_OCCUPIED");
    return {
      identity: identity(after),
      nlink: Number(after.nlink),
      mode: Number(after.mode),
      text: bytes.toString("utf8")
    };
  } finally {
    await handle.close();
  }
}
async function productionInspectDirectory(path, requireRestrictiveMode = true) {
  let stats;
  try {
    stats = await lstat3(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return void 0;
    throw error;
  }
  if (!restrictive(stats, true, requireRestrictiveMode)) {
    if (stats.isFile() && !stats.isSymbolicLink()) fail3("LEGACY_LOCK_BLOCKED");
    fail3("UNSAFE_LOCK_DIRECTORY");
  }
  const entries = (await readdir2(path)).sort();
  const after = await lstat3(path, { bigint: true });
  if (!restrictive(after, true, requireRestrictiveMode) || identity(after) !== identity(stats)) fail3("UNSAFE_LOCK_DIRECTORY");
  return { identity: identity(after), mode: Number(after.mode), entries };
}
async function productionCreateDirectory(path) {
  await mkdir(path, { recursive: false, mode: 448 });
  if (process.platform !== "win32") await chmod2(path, 448);
  await flushDirectory(dirname3(path));
  const snapshot = await productionInspectDirectory(path);
  if (snapshot === void 0) fail3("UNSAFE_LOCK_DIRECTORY");
  return snapshot;
}
async function productionCreateFileDurable(path, text, crashPoint, durableCut) {
  const noFollow = "O_NOFOLLOW" in constants3 ? constants3.O_NOFOLLOW : 0;
  const simulateCrash = (point) => {
    if (crashPoint !== point) return;
    throw Object.assign(new Error("Simulated durable-write crash."), {
      code: "SIMULATED_DURABLE_WRITE_CRASH"
    });
  };
  const handle = await open3(path, constants3.O_CREAT | constants3.O_EXCL | constants3.O_WRONLY | noFollow, 384);
  try {
    simulateCrash("after-create");
    await durableCut?.("after-create");
    await handle.writeFile(text, "utf8");
    simulateCrash("after-write");
    await durableCut?.("after-write");
    await handle.sync();
    simulateCrash("after-sync");
    await durableCut?.("after-sync");
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod2(path, 384);
  await flushDirectory(dirname3(path));
  await durableCut?.("after-parent-flush");
  const snapshot = await productionReadFile(path, LEASE_MAX_BYTES);
  if (snapshot === void 0) fail3("LOCK_LEASE_OCCUPIED");
  return snapshot;
}
async function productionReplaceFileFromTemporary(temporaryPath, targetPath, temporaryIdentity, expectedTargetIdentity, crashPoint, durableCut) {
  const temporary = await productionReadFile(temporaryPath, JOURNAL_MAX_BYTES);
  const target = await productionReadFile(targetPath, JOURNAL_MAX_BYTES);
  if (temporary?.identity !== temporaryIdentity || temporary.nlink !== 1 || (expectedTargetIdentity === void 0 ? target !== void 0 : target?.identity !== expectedTargetIdentity)) {
    fail3("LOCK_JOURNAL_UNSAFE");
  }
  await rename(temporaryPath, targetPath);
  if (crashPoint === "after-rename") {
    throw Object.assign(new Error("Simulated durable-write crash."), { code: "SIMULATED_DURABLE_WRITE_CRASH" });
  }
  await durableCut?.("after-rename");
  if (process.platform !== "win32") await chmod2(targetPath, 384);
  await flushDirectory(dirname3(targetPath));
  if (crashPoint === "after-directory-flush") {
    throw Object.assign(new Error("Simulated durable-write crash."), { code: "SIMULATED_DURABLE_WRITE_CRASH" });
  }
  await durableCut?.("after-directory-flush");
  const replaced = await productionReadFile(targetPath, JOURNAL_MAX_BYTES);
  if (replaced?.identity !== temporaryIdentity) fail3("LOCK_JOURNAL_UNSAFE");
  return replaced;
}
function productionWait(milliseconds, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new FileLockError("LOCK_ABORTED"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(new FileLockError("LOCK_ABORTED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
var ERROR_MESSAGES2, FileLockError, DEFAULT_FILE_LOCK_POLICY, JOURNAL_MAX_BYTES, LEASE_MAX_BYTES, UUID_PATTERN, NATIVE_ANCHOR, NATIVE_JOURNAL, WRITE_TEMPORARY_SUFFIX, sameProcessQueues, ownerRecoveryReceipts, productionIo, productionRuntime;
var init_fileLockLease = __esm({
  "src/core/fileLockLease.ts"() {
    "use strict";
    init_legacyRuntimeActivation();
    init_lockDomain();
    init_nativeLockAddon();
    init_nativeLockProvider();
    ERROR_MESSAGES2 = Object.freeze({
      LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED: "Legacy TokenGraph runtime shutdown has not been confirmed.",
      INVALID_PERSISTENCE_LOCK: "The persistence lock was not created by the authorized registry.",
      LEGACY_LOCK_BLOCKED: "A legacy or unexplained persistence lock blocks this operation.",
      UNSAFE_LOCK_DIRECTORY: "The persistence lock directory is unsafe or has changed identity.",
      LOCK_JOURNAL_UNSAFE: "The native lock recovery journal is unsafe or ambiguous.",
      LOCK_LEASE_OCCUPIED: "The persistence lease is occupied or cannot be recovered safely.",
      LOCK_TIMEOUT: "Timed out waiting for the native persistence lock.",
      LOCK_ABORTED: "Waiting for the native persistence lock was aborted."
    });
    FileLockError = class extends Error {
      code;
      constructor(code) {
        super(ERROR_MESSAGES2[code]);
        this.name = "FileLockError";
        this.code = code;
      }
    };
    DEFAULT_FILE_LOCK_POLICY = Object.freeze({
      attempts: 200,
      waitMs: 10,
      staleMs: 3e4,
      heartbeatMs: 9e3
    });
    JOURNAL_MAX_BYTES = 8 * 1024;
    LEASE_MAX_BYTES = 4 * 1024;
    UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    NATIVE_ANCHOR = ".tokengraph-native-anchor-v2.lock";
    NATIVE_JOURNAL = ".tokengraph-native-journal-v2.lock";
    WRITE_TEMPORARY_SUFFIX = ".tokengraph-write-v2.tmp";
    sameProcessQueues = /* @__PURE__ */ new Map();
    ownerRecoveryReceipts = /* @__PURE__ */ new WeakMap();
    productionIo = Object.freeze({
      async ensureDirectory(path, requireRestrictiveMode = true) {
        const absolute = resolve3(path);
        const parsed = parse(absolute);
        let current = parsed.root;
        for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
          current = join3(current, segment);
          try {
            const component = await lstat3(current, { bigint: true });
            if (component.isSymbolicLink() || !component.isDirectory()) fail3("UNSAFE_LOCK_DIRECTORY");
          } catch (error) {
            if (errno(error) !== "ENOENT") throw error;
            const ownedHere = requireRestrictiveMode || current !== resolve3(path);
            let created = true;
            try {
              await mkdir(current, { recursive: false, mode: ownedHere ? 448 : 493 });
            } catch (creationError) {
              if (errno(creationError) !== "EEXIST") throw creationError;
              created = false;
              const raced = await lstat3(current, { bigint: true });
              if (raced.isSymbolicLink() || !raced.isDirectory()) fail3("UNSAFE_LOCK_DIRECTORY");
            }
            if (created && ownedHere && process.platform !== "win32") await chmod2(current, 448);
          }
        }
        let stats = await lstat3(path, { bigint: true });
        if (requireRestrictiveMode && process.platform !== "win32" && stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === BigInt(process.getuid?.() ?? -1) && (Number(stats.mode) & 63) !== 0) {
          await chmod2(path, 448);
          stats = await lstat3(path, { bigint: true });
        }
        if (!restrictive(stats, true, requireRestrictiveMode)) fail3("UNSAFE_LOCK_DIRECTORY");
        if (requireRestrictiveMode && process.platform !== "win32") await chmod2(path, 448);
      },
      readFile: productionReadFile,
      inspectDirectory: productionInspectDirectory,
      createDirectory: productionCreateDirectory,
      createFileDurable: productionCreateFileDurable,
      replaceFileFromTemporary: productionReplaceFileFromTemporary,
      async flushParentDirectory(path) {
        await flushDirectory(dirname3(path));
      },
      async removeFile(path, expectedIdentity) {
        const snapshot = await productionReadFile(path, JOURNAL_MAX_BYTES);
        if (snapshot?.identity !== expectedIdentity) fail3("LOCK_LEASE_OCCUPIED");
        await unlink2(path);
        await flushDirectory(dirname3(path));
      },
      async removeDirectory(path, expectedIdentity) {
        const snapshot = await productionInspectDirectory(path);
        if (snapshot === void 0 || snapshot.identity !== expectedIdentity || snapshot.entries.length !== 0) {
          fail3("UNSAFE_LOCK_DIRECTORY");
        }
        await rmdir2(path);
        await flushDirectory(dirname3(path));
      }
    });
    productionRuntime = Object.freeze({
      pid: process.pid,
      platform: process.platform,
      now: () => Date.now(),
      randomUUID,
      wait: productionWait,
      processLiveness(pid) {
        try {
          process.kill(pid, 0);
          return "alive";
        } catch (error) {
          if (errno(error) === "ESRCH") return "dead";
          return "unknown";
        }
      },
      loadAddon: () => getNativeLockAddon(),
      scheduleHeartbeat(milliseconds, callback) {
        let chain = Promise.resolve();
        let failure;
        let failed = false;
        const timer = setInterval(() => {
          chain = chain.then(callback).catch((error) => {
            if (!failed) failure = error;
            failed = true;
          });
        }, milliseconds);
        timer.unref?.();
        return Object.freeze({
          async stop() {
            clearInterval(timer);
            await chain;
            if (failed) throw failure;
          }
        });
      },
      io: productionIo
    });
  }
});

// src/core/canonical.ts
import { createHash as createHash3 } from "node:crypto";
function normalizeCanonicalText(value) {
  return value.replace(/\r\n?/g, "\n");
}
function canonicalValue(value) {
  if (typeof value === "string") return normalizeCanonicalText(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}
function canonicalHash(value) {
  return createHash3("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
var init_canonical = __esm({
  "src/core/canonical.ts"() {
    "use strict";
  }
});

// src/core/storage.ts
var storage_exports = {};
__export(storage_exports, {
  DestructiveMaintenanceConfirmationError: () => DestructiveMaintenanceConfirmationError,
  JsonTokenGraphStore: () => JsonTokenGraphStore,
  MAX_PERSISTED_WRITE_TELEMETRY_DAYS: () => MAX_PERSISTED_WRITE_TELEMETRY_DAYS,
  SAFE_WIKI_SLUG_PATTERN: () => SAFE_WIKI_SLUG_PATTERN,
  SqliteTokenGraphStore: () => SqliteTokenGraphStore,
  assertNoSymbolicLinkComponents: () => assertNoSymbolicLinkComponents,
  canonicalMaintenanceLocks: () => canonicalMaintenanceLocks,
  canonicalPersistenceLockKey: () => canonicalPersistenceLockKey,
  flushWriteTelemetry: () => flushWriteTelemetry,
  normalizeWriteTelemetry: () => normalizeWriteTelemetry,
  observeSuccessfulWrite: () => observeSuccessfulWrite,
  quarantineCorruptJson: () => quarantineCorruptJson,
  readStableAtomicTarget: () => readStableAtomicTarget,
  readWriteTelemetry: () => readWriteTelemetry,
  resolveConfinedPath: () => resolveConfinedPath,
  withAutomaticMaintenance: () => withAutomaticMaintenance,
  withDestructiveMaintenance: () => withDestructiveMaintenance,
  withFileLock: () => withFileLock,
  writeJsonAtomic: () => writeJsonAtomic,
  writeTelemetryPath: () => writeTelemetryPath,
  writeTextAtomic: () => writeTextAtomic,
  writeTextAtomicConfined: () => writeTextAtomicConfined
});
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants as constants4 } from "node:fs";
import { chmod as chmod3, lstat as lstat4, mkdir as mkdir2, open as open4, readFile, readdir as readdir3, realpath as realpath2, rename as rename2, rm, rmdir as rmdir3, unlink as unlink3, writeFile } from "node:fs/promises";
import { dirname as dirname4, isAbsolute as isAbsolute2, join as join4, parse as parse2, relative as relative3, resolve as resolve4 } from "node:path";
function telemetryKey(root) {
  const key = resolve4(root);
  return process.platform === "win32" ? key.toLowerCase() : key;
}
function telemetryDay(now = /* @__PURE__ */ new Date()) {
  return now.toISOString().slice(0, 10);
}
function isValidTelemetryDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function checkedTelemetrySum(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error("TokenGraph write telemetry counter overflow; refusing to lose aggregate data.");
  }
  return sum;
}
function mergeAggregate(current, incoming) {
  if (!current) return { ...incoming };
  return {
    operationCount: checkedTelemetrySum(current?.operationCount ?? 0, incoming.operationCount),
    logicalBytes: checkedTelemetrySum(current?.logicalBytes ?? 0, incoming.logicalBytes),
    ...current.physicalBytes === void 0 || incoming.physicalBytes === void 0 ? {} : { physicalBytes: checkedTelemetrySum(current?.physicalBytes ?? 0, incoming.physicalBytes ?? 0) }
  };
}
function mergeDailyTelemetry(current, incoming) {
  const classes = {};
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
function mergePendingDay(current, incoming) {
  const classes = { ...current?.classes };
  for (const storageClass of WRITE_STORAGE_CLASSES) {
    const addition = incoming.classes[storageClass];
    if (!addition) continue;
    const existing = classes[storageClass];
    classes[storageClass] = !existing ? { ...addition } : {
      operationCount: existing.operationCount + addition.operationCount,
      logicalBytes: existing.logicalBytes + addition.logicalBytes,
      ...existing.physicalBytes === void 0 || addition.physicalBytes === void 0 ? {} : {
        physicalBytes: existing.physicalBytes + addition.physicalBytes
      }
    };
  }
  return { date: incoming.date, sampledPeakRssBytes: Math.max(current?.sampledPeakRssBytes ?? 0, incoming.sampledPeakRssBytes), classes };
}
function serializePendingDay(day) {
  const safeNumber = (value) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("TokenGraph write telemetry counter overflow; exact pending counters are retained in memory.");
    return Number(value);
  };
  const classes = {};
  for (const storageClass of WRITE_STORAGE_CLASSES) {
    const value = day.classes[storageClass];
    if (value) classes[storageClass] = {
      operationCount: safeNumber(value.operationCount),
      logicalBytes: safeNumber(value.logicalBytes),
      ...value.physicalBytes === void 0 ? {} : { physicalBytes: safeNumber(value.physicalBytes) }
    };
  }
  return { date: day.date, sampledPeakRssBytes: day.sampledPeakRssBytes, classes };
}
function isValidAggregate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value;
  return Number.isSafeInteger(candidate.operationCount) && candidate.operationCount >= 0 && Number.isSafeInteger(candidate.logicalBytes) && candidate.logicalBytes >= 0 && (candidate.physicalBytes === void 0 || Number.isSafeInteger(candidate.physicalBytes) && candidate.physicalBytes >= 0);
}
function isValidDailyTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value;
  if (!isValidTelemetryDay(candidate.date) || !Number.isSafeInteger(candidate.sampledPeakRssBytes) || candidate.sampledPeakRssBytes < 0 || !candidate.classes || typeof candidate.classes !== "object" || Array.isArray(candidate.classes)) return false;
  return Object.entries(candidate.classes).every(
    ([storageClass, aggregate]) => WRITE_STORAGE_CLASSES.includes(storageClass) && isValidAggregate(aggregate)
  );
}
function normalizeWriteTelemetry(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (typeof candidate.schemaVersion === "number" && candidate.schemaVersion > 1) {
    throw new Error(`Unsupported newer TokenGraph write telemetry schema version ${candidate.schemaVersion}; refusing to overwrite it.`);
  }
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.days) || candidate.days.some((day) => !isValidDailyTelemetry(day))) {
    throw new Error("TokenGraph write telemetry is malformed; refusing to overwrite it.");
  }
  const byDate = /* @__PURE__ */ new Map();
  for (const day of candidate.days.filter(isValidDailyTelemetry)) byDate.set(day.date, mergeDailyTelemetry(byDate.get(day.date), day));
  return {
    schemaVersion: 1,
    days: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).slice(-MAX_PERSISTED_WRITE_TELEMETRY_DAYS)
  };
}
function writeTelemetryPath(root) {
  return join4(root, ".tokengraph", "telemetry", "write-aggregates.json");
}
async function readWriteTelemetry(root) {
  try {
    const content = await readStableAtomicTarget(writeTelemetryPath(root), MAX_WRITE_TELEMETRY_BYTES);
    if (content === void 0) return { schemaVersion: 1, days: [] };
    return normalizeWriteTelemetry(JSON.parse(content));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, days: [] };
    if (error instanceof SyntaxError) throw new Error("TokenGraph write telemetry is malformed; refusing to overwrite it.");
    throw error;
  }
}
function observeSuccessfulWrite(context, logicalBytes, physicalBytes) {
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0 || physicalBytes !== void 0 && (!Number.isSafeInteger(physicalBytes) || physicalBytes < 0)) {
    throw new Error("TokenGraph write telemetry accepts only non-negative safe-integer byte counts.");
  }
  const key = telemetryKey(context.root);
  const day = telemetryDay();
  const days = pendingWriteTelemetry.get(key) ?? /* @__PURE__ */ new Map();
  const current = mergePendingDay(days.get(day), {
    date: day,
    sampledPeakRssBytes: process.memoryUsage().rss,
    classes: { [context.storageClass]: {
      operationCount: 1n,
      logicalBytes: BigInt(logicalBytes),
      ...physicalBytes === void 0 ? {} : { physicalBytes: BigInt(physicalBytes) }
    } }
  });
  days.set(day, current);
  const retainedDates = [...days.keys()].sort().slice(-MAX_PERSISTED_WRITE_TELEMETRY_DAYS);
  for (const date of [...days.keys()]) if (!retainedDates.includes(date)) days.delete(date);
  pendingWriteTelemetry.set(key, days);
}
async function flushWriteTelemetryNow(root) {
  const key = telemetryKey(root);
  const snapshot = pendingWriteTelemetry.get(key);
  if (!snapshot?.size) return false;
  const writesDuringFlush = /* @__PURE__ */ new Map();
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
    const pending = pendingWriteTelemetry.get(key) ?? /* @__PURE__ */ new Map();
    for (const day of snapshot.values()) pending.set(day.date, mergePendingDay(pending.get(day.date), day));
    pendingWriteTelemetry.set(key, pending);
    throw error;
  }
}
async function flushWriteTelemetry(root) {
  const key = telemetryKey(root);
  const previous = writeTelemetryFlushChains.get(key) ?? Promise.resolve();
  let flushed = false;
  const current = previous.then(
    async () => {
      flushed = await flushWriteTelemetryNow(root);
    },
    async () => {
      flushed = await flushWriteTelemetryNow(root);
    }
  );
  const settled = current.then(() => void 0, () => void 0);
  writeTelemetryFlushChains.set(key, settled);
  try {
    await current;
    return flushed;
  } finally {
    if (writeTelemetryFlushChains.get(key) === settled) writeTelemetryFlushChains.delete(key);
  }
}
async function withFileLock(lock, operation, options = {}) {
  return runWithFileLock(lock, operation, options);
}
function maintenanceSortKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
async function canonicalMaintenanceLocks(root, domains) {
  const locks = await Promise.all([...new Set(domains)].map((domain) => canonicalPersistenceLock(root, domain, "maintenance")));
  const unique = /* @__PURE__ */ new Map();
  for (const lock of locks) unique.set(maintenanceSortKey(lock.anchorPath), lock);
  return Object.freeze([...unique.values()].sort((left, right) => {
    const leftKey = maintenanceSortKey(left.anchorPath);
    const rightKey = maintenanceSortKey(right.anchorPath);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));
}
function assertMaintenanceConfirmation(value) {
  if (value === null || typeof value !== "object" || value.confirmedNoLegacyTokenGraphProcesses !== true) {
    throw new DestructiveMaintenanceConfirmationError();
  }
}
function pathIdentity(stats) {
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
function sameMaintenanceIdentity(left, right, directory) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode || left.birthtimeNs !== right.birthtimeNs) return false;
  return directory || left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function safeMaintenanceRelativePath(value) {
  if (value === void 0) return void 0;
  if (value.length === 0 || isAbsolute2(value) || value.includes("\0")) throw new Error("Maintenance target must be a safe relative path.");
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new Error("Maintenance target must be a safe relative path.");
  return segments.join("/");
}
async function planMaintenanceEntry(path, protectedPaths, plan) {
  const key = maintenanceSortKey(path);
  if (protectedPaths.has(key)) return;
  let stats;
  try {
    stats = await lstat4(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
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
  for (const entry of (await readdir3(path)).sort()) await planMaintenanceEntry(join4(path, entry), protectedPaths, plan);
  plan.push({ path, identity: pathIdentity(stats), directory: true });
}
async function removePlannedMaintenanceEntries(plan) {
  const removed = /* @__PURE__ */ new Set();
  for (const entry of plan) {
    const current = await lstat4(entry.path, { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") throw new Error("Destructive maintenance target identity changed before deletion.");
      throw error;
    });
    if (!sameMaintenanceIdentity(entry.identity, pathIdentity(current), entry.directory) || current.isSymbolicLink() || (entry.directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1n)) {
      throw new Error("Destructive maintenance target identity changed before deletion.");
    }
    if (entry.directory) await rmdir3(entry.path);
    else await unlink3(entry.path);
    removed.add(entry.path);
  }
  return removed;
}
function createMaintenanceContext(locks) {
  const byDomain = /* @__PURE__ */ new Map();
  const protectedPaths = /* @__PURE__ */ new Set();
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
    async remove(targets) {
      const plans = [];
      const roots = /* @__PURE__ */ new Set();
      for (const target of targets) {
        const lock = byDomain.get(target.domain);
        if (!lock) throw new Error("Maintenance target domain was not acquired.");
        const relativePath = safeMaintenanceRelativePath(target.relativePath);
        const targetPath = relativePath === void 0 ? lock.domainRoot : join4(lock.domainRoot, ...relativePath.split("/"));
        const difference = relative3(lock.domainRoot, targetPath);
        if (difference.startsWith("..") || isAbsolute2(difference)) throw new Error("Maintenance target escapes its canonical domain.");
        if (relativePath === void 0) {
          let entries;
          try {
            entries = (await readdir3(lock.domainRoot)).sort();
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          for (const entry of entries) await planMaintenanceEntry(join4(lock.domainRoot, entry), protectedPaths, plans);
        } else if (!roots.has(maintenanceSortKey(targetPath))) {
          roots.add(maintenanceSortKey(targetPath));
          await planMaintenanceEntry(targetPath, protectedPaths, plans);
        }
      }
      return removePlannedMaintenanceEntries(plans);
    }
  });
}
async function withMaintenanceLocks(root, domains, operation) {
  const locks = await canonicalMaintenanceLocks(root, domains);
  const context = createMaintenanceContext(locks);
  const acquire = async (index) => index === locks.length ? operation(context) : withFileLock(locks[index], () => acquire(index + 1));
  return acquire(0);
}
async function withDestructiveMaintenance(root, domains, confirmation, operation) {
  assertMaintenanceConfirmation(confirmation);
  requireLegacyRuntimeShutdownCapability();
  return withMaintenanceLocks(root, domains, operation);
}
async function withAutomaticMaintenance(root, domains, operation) {
  requireLegacyRuntimeShutdownCapability();
  return withMaintenanceLocks(root, domains, operation);
}
async function canonicalPersistenceLockKey(root, ...segments) {
  const resolvedRoot = resolve4(root);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath2(resolvedRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonicalRoot = resolvedRoot;
  }
  const key = join4(canonicalRoot, ...segments);
  return process.platform === "win32" ? key.toLowerCase() : key;
}
async function readStableAtomicTarget(path, maximumBytes = MAX_ATOMIC_NOOP_READ_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("TokenGraph stable-read limit is invalid.");
  await assertNoSymbolicLinkComponents(path);
  let before;
  try {
    before = await lstat4(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("TokenGraph atomic-write target is not a single-link regular file.");
  }
  if (before.size < 0n || before.size > BigInt(maximumBytes)) {
    throw new Error("TokenGraph atomic-write target exceeds its bounded validation limit.");
  }
  const noFollow = "O_NOFOLLOW" in constants4 ? constants4.O_NOFOLLOW : 0;
  const handle = await open4(path, constants4.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile("utf8");
    const opened = await handle.stat({ bigint: true });
    const after = await lstat4(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameMaintenanceIdentity(pathIdentity(before), pathIdentity(opened), false) || !sameMaintenanceIdentity(pathIdentity(before), pathIdentity(after), false)) {
      throw new Error("TokenGraph atomic-write target changed during no-op validation.");
    }
    return content;
  } finally {
    await handle.close();
  }
}
async function writeJsonAtomic(path, value, options = {}) {
  const payloadHash = canonicalHash(value);
  try {
    const existing = await readStableAtomicTarget(path);
    if (existing !== void 0 && canonicalHash(JSON.parse(existing)) === payloadHash) return false;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return writeTextAtomic(path, `${JSON.stringify(value, null, 2)}
`, options);
}
async function writeTextAtomic(path, content, options = {}) {
  if (await readStableAtomicTarget(path) === content) return false;
  const directory = dirname4(path);
  await assertNoSymbolicLinkComponents(path);
  await mkdir2(directory, { recursive: true, mode: 448 });
  await assertNoSymbolicLinkComponents(path);
  if (process.platform !== "win32") await chmod3(directory, 448);
  const tempPath = join4(directory, `.${process.pid}-${Date.now()}-${randomUUID2()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode: 384 });
    await rename2(tempPath, path);
    if (process.platform !== "win32") await chmod3(path, 384);
  } finally {
    await rm(tempPath, { force: true });
  }
  if (options.telemetry) observeSuccessfulWrite(options.telemetry, Buffer.byteLength(content, "utf8"));
  return true;
}
async function assertNoSymbolicLinkComponents(path) {
  const absolute = resolve4(path);
  const parsed = parse2(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  for (const segment of remainder) {
    current = join4(current, segment);
    try {
      if ((await lstat4(current)).isSymbolicLink()) {
        throw new Error(`State write cannot traverse symbolic-link or junction component: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
}
async function resolveConfinedPath(root, relativeFile, createParents = false) {
  if (!relativeFile || isAbsolute2(relativeFile) || relativeFile.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("Confined path must be a safe relative file path.");
  }
  const canonicalRoot = await realpath2(resolve4(root));
  const segments = relativeFile.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) throw new Error("Confined path must name a file.");
  let parent = canonicalRoot;
  for (const segment of segments) {
    const candidate = join4(parent, segment);
    if (createParents) await mkdir2(candidate, { recursive: false, mode: 448 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    parent = await realpath2(candidate);
    const confined2 = relative3(canonicalRoot, parent);
    if (!confined2 || confined2.startsWith("..") || isAbsolute2(confined2)) {
      throw new Error("Path resolves outside the trusted workspace.");
    }
  }
  const filePath = join4(parent, fileName);
  try {
    if ((await lstat4(filePath)).isSymbolicLink()) throw new Error("Confined file path cannot be a symbolic link.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return filePath;
}
async function writeTextAtomicConfined(root, relativeFile, content, options = {}) {
  return writeTextAtomic(await resolveConfinedPath(root, relativeFile, true), content, options);
}
async function quarantineCorruptJson(path) {
  const corruptPath = `${path}.corrupt-${Date.now()}-${randomUUID2().slice(0, 8)}`;
  try {
    await rename2(path, corruptPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
var MAX_PERSISTED_WRITE_TELEMETRY_DAYS, MAX_ATOMIC_NOOP_READ_BYTES, MAX_WRITE_TELEMETRY_BYTES, WRITE_STORAGE_CLASSES, pendingWriteTelemetry, writeTelemetryFlushChains, DestructiveMaintenanceConfirmationError, SAFE_WIKI_SLUG_PATTERN, JsonTokenGraphStore, SqliteTokenGraphStore;
var init_storage = __esm({
  "src/core/storage.ts"() {
    "use strict";
    init_fileLockLease();
    init_canonical();
    init_lockDomain();
    init_legacyRuntimeActivation();
    MAX_PERSISTED_WRITE_TELEMETRY_DAYS = 14;
    MAX_ATOMIC_NOOP_READ_BYTES = 64 * 1024 * 1024;
    MAX_WRITE_TELEMETRY_BYTES = 256 * 1024;
    WRITE_STORAGE_CLASSES = ["runs", "cache", "vault", "durable"];
    pendingWriteTelemetry = /* @__PURE__ */ new Map();
    writeTelemetryFlushChains = /* @__PURE__ */ new Map();
    DestructiveMaintenanceConfirmationError = class extends Error {
      code = "DESTRUCTIVE_MAINTENANCE_UNCONFIRMED";
      constructor() {
        super("Destructive TokenGraph maintenance requires a fresh confirmation that no legacy TokenGraph process is running.");
        this.name = "DestructiveMaintenanceConfirmationError";
      }
    };
    SAFE_WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
    JsonTokenGraphStore = class {
      constructor(filePath, options) {
        this.filePath = filePath;
        this.options = options;
      }
      filePath;
      options;
      async read() {
        try {
          const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
          if (Array.isArray(parsed)) {
            return parsed;
          }
          if (parsed && typeof parsed === "object") {
            const schemaVersion = parsed.schemaVersion;
            if (typeof schemaVersion === "number" && schemaVersion !== this.options.schemaVersion) {
              throw new Error(`Unsupported TokenGraph store schema version ${schemaVersion}; expected ${this.options.schemaVersion}.`);
            }
            const value = parsed[this.options.dataKey];
            return Array.isArray(value) ? value : [];
          }
          return [];
        } catch (error) {
          if (error.code === "ENOENT") {
            return [];
          }
          if (error instanceof SyntaxError) {
            if (getLegacyRuntimeActivationStatus().activated) await quarantineCorruptJson(this.filePath);
            return [];
          }
          throw error;
        }
      }
      async write(data) {
        await writeJsonAtomic(resolve4(this.filePath), {
          schemaVersion: this.options.schemaVersion,
          [this.options.dataKey]: data
        });
      }
    };
    SqliteTokenGraphStore = class {
      constructor(_databasePath) {
        throw new Error("The optional SQLite backend is not implemented; JSON storage remains the default.");
      }
    };
  }
});

// node_modules/.pnpm/ignore@5.3.2/node_modules/ignore/index.js
var require_ignore = __commonJS({
  "node_modules/.pnpm/ignore@5.3.2/node_modules/ignore/index.js"(exports, module) {
    function makeArray(subject) {
      return Array.isArray(subject) ? subject : [subject];
    }
    var EMPTY = "";
    var SPACE = " ";
    var ESCAPE = "\\";
    var REGEX_TEST_BLANK_LINE = /^\s+$/;
    var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
    var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
    var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
    var REGEX_SPLITALL_CRLF = /\r?\n/g;
    var REGEX_TEST_INVALID_PATH = /^\.*\/|^\.+$/;
    var SLASH = "/";
    var TMP_KEY_IGNORE = "node-ignore";
    if (typeof Symbol !== "undefined") {
      TMP_KEY_IGNORE = /* @__PURE__ */ Symbol.for("node-ignore");
    }
    var KEY_IGNORE = TMP_KEY_IGNORE;
    var define = (object, key, value) => Object.defineProperty(object, key, { value });
    var REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
    var RETURN_FALSE = () => false;
    var sanitizeRange = (range) => range.replace(
      REGEX_REGEXP_RANGE,
      (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY
    );
    var cleanRangeBackSlash = (slashes) => {
      const { length } = slashes;
      return slashes.slice(0, length - length % 2);
    };
    var REPLACERS = [
      [
        // remove BOM
        // TODO:
        // Other similar zero-width characters?
        /^\uFEFF/,
        () => EMPTY
      ],
      // > Trailing spaces are ignored unless they are quoted with backslash ("\")
      [
        // (a\ ) -> (a )
        // (a  ) -> (a)
        // (a ) -> (a)
        // (a \ ) -> (a  )
        /((?:\\\\)*?)(\\?\s+)$/,
        (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
      ],
      // replace (\ ) with ' '
      // (\ ) -> ' '
      // (\\ ) -> '\\ '
      // (\\\ ) -> '\\ '
      [
        /(\\+?)\s/g,
        (_, m1) => {
          const { length } = m1;
          return m1.slice(0, length - length % 2) + SPACE;
        }
      ],
      // Escape metacharacters
      // which is written down by users but means special for regular expressions.
      // > There are 12 characters with special meanings:
      // > - the backslash \,
      // > - the caret ^,
      // > - the dollar sign $,
      // > - the period or dot .,
      // > - the vertical bar or pipe symbol |,
      // > - the question mark ?,
      // > - the asterisk or star *,
      // > - the plus sign +,
      // > - the opening parenthesis (,
      // > - the closing parenthesis ),
      // > - and the opening square bracket [,
      // > - the opening curly brace {,
      // > These special characters are often called "metacharacters".
      [
        /[\\$.|*+(){^]/g,
        (match) => `\\${match}`
      ],
      [
        // > a question mark (?) matches a single character
        /(?!\\)\?/g,
        () => "[^/]"
      ],
      // leading slash
      [
        // > A leading slash matches the beginning of the pathname.
        // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
        // A leading slash matches the beginning of the pathname
        /^\//,
        () => "^"
      ],
      // replace special metacharacter slash after the leading slash
      [
        /\//g,
        () => "\\/"
      ],
      [
        // > A leading "**" followed by a slash means match in all directories.
        // > For example, "**/foo" matches file or directory "foo" anywhere,
        // > the same as pattern "foo".
        // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
        // >   under directory "foo".
        // Notice that the '*'s have been replaced as '\\*'
        /^\^*\\\*\\\*\\\//,
        // '**/foo' <-> 'foo'
        () => "^(?:.*\\/)?"
      ],
      // starting
      [
        // there will be no leading '/'
        //   (which has been replaced by section "leading slash")
        // If starts with '**', adding a '^' to the regular expression also works
        /^(?=[^^])/,
        function startingReplacer() {
          return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
        }
      ],
      // two globstars
      [
        // Use lookahead assertions so that we could match more than one `'/**'`
        /\\\/\\\*\\\*(?=\\\/|$)/g,
        // Zero, one or several directories
        // should not use '*', or it will be replaced by the next replacer
        // Check if it is not the last `'/**'`
        (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"
      ],
      // normal intermediate wildcards
      [
        // Never replace escaped '*'
        // ignore rule '\*' will match the path '*'
        // 'abc.*/' -> go
        // 'abc.*'  -> skip this rule,
        //    coz trailing single wildcard will be handed by [trailing wildcard]
        /(^|[^\\]+)(\\\*)+(?=.+)/g,
        // '*.js' matches '.js'
        // '*.js' doesn't match 'abc'
        (_, p1, p2) => {
          const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
          return p1 + unescaped;
        }
      ],
      [
        // unescape, revert step 3 except for back slash
        // For example, if a user escape a '\\*',
        // after step 3, the result will be '\\\\\\*'
        /\\\\\\(?=[$.|*+(){^])/g,
        () => ESCAPE
      ],
      [
        // '\\\\' -> '\\'
        /\\\\/g,
        () => ESCAPE
      ],
      [
        // > The range notation, e.g. [a-zA-Z],
        // > can be used to match one of the characters in a range.
        // `\` is escaped by step 3
        /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
        (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${sanitizeRange(range)}${endEscape}]` : "[]" : "[]"
      ],
      // ending
      [
        // 'js' will not match 'js.'
        // 'ab' will not match 'abc'
        /(?:[^*])$/,
        // WTF!
        // https://git-scm.com/docs/gitignore
        // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
        // which re-fixes #24, #38
        // > If there is a separator at the end of the pattern then the pattern
        // > will only match directories, otherwise the pattern can match both
        // > files and directories.
        // 'js*' will not match 'a.js'
        // 'js/' will not match 'a.js'
        // 'js' will match 'a.js' and 'a.js/'
        (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`
      ],
      // trailing wildcard
      [
        /(\^|\\\/)?\\\*$/,
        (_, p1) => {
          const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
          return `${prefix}(?=$|\\/$)`;
        }
      ]
    ];
    var regexCache = /* @__PURE__ */ Object.create(null);
    var makeRegex = (pattern, ignoreCase) => {
      let source = regexCache[pattern];
      if (!source) {
        source = REPLACERS.reduce(
          (prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)),
          pattern
        );
        regexCache[pattern] = source;
      }
      return ignoreCase ? new RegExp(source, "i") : new RegExp(source);
    };
    var isString = (subject) => typeof subject === "string";
    var checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
    var splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF);
    var IgnoreRule = class {
      constructor(origin, pattern, negative, regex) {
        this.origin = origin;
        this.pattern = pattern;
        this.negative = negative;
        this.regex = regex;
      }
    };
    var createRule = (pattern, ignoreCase) => {
      const origin = pattern;
      let negative = false;
      if (pattern.indexOf("!") === 0) {
        negative = true;
        pattern = pattern.substr(1);
      }
      pattern = pattern.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
      const regex = makeRegex(pattern, ignoreCase);
      return new IgnoreRule(
        origin,
        pattern,
        negative,
        regex
      );
    };
    var throwError = (message, Ctor) => {
      throw new Ctor(message);
    };
    var checkPath = (path, originalPath, doThrow) => {
      if (!isString(path)) {
        return doThrow(
          `path must be a string, but got \`${originalPath}\``,
          TypeError
        );
      }
      if (!path) {
        return doThrow(`path must not be empty`, TypeError);
      }
      if (checkPath.isNotRelative(path)) {
        const r = "`path.relative()`d";
        return doThrow(
          `path should be a ${r} string, but got "${originalPath}"`,
          RangeError
        );
      }
      return true;
    };
    var isNotRelative = (path) => REGEX_TEST_INVALID_PATH.test(path);
    checkPath.isNotRelative = isNotRelative;
    checkPath.convert = (p) => p;
    var Ignore = class {
      constructor({
        ignorecase = true,
        ignoreCase = ignorecase,
        allowRelativePaths = false
      } = {}) {
        define(this, KEY_IGNORE, true);
        this._rules = [];
        this._ignoreCase = ignoreCase;
        this._allowRelativePaths = allowRelativePaths;
        this._initCache();
      }
      _initCache() {
        this._ignoreCache = /* @__PURE__ */ Object.create(null);
        this._testCache = /* @__PURE__ */ Object.create(null);
      }
      _addPattern(pattern) {
        if (pattern && pattern[KEY_IGNORE]) {
          this._rules = this._rules.concat(pattern._rules);
          this._added = true;
          return;
        }
        if (checkPattern(pattern)) {
          const rule = createRule(pattern, this._ignoreCase);
          this._added = true;
          this._rules.push(rule);
        }
      }
      // @param {Array<string> | string | Ignore} pattern
      add(pattern) {
        this._added = false;
        makeArray(
          isString(pattern) ? splitPattern(pattern) : pattern
        ).forEach(this._addPattern, this);
        if (this._added) {
          this._initCache();
        }
        return this;
      }
      // legacy
      addPattern(pattern) {
        return this.add(pattern);
      }
      //          |           ignored : unignored
      // negative |   0:0   |   0:1   |   1:0   |   1:1
      // -------- | ------- | ------- | ------- | --------
      //     0    |  TEST   |  TEST   |  SKIP   |    X
      //     1    |  TESTIF |  SKIP   |  TEST   |    X
      // - SKIP: always skip
      // - TEST: always test
      // - TESTIF: only test if checkUnignored
      // - X: that never happen
      // @param {boolean} whether should check if the path is unignored,
      //   setting `checkUnignored` to `false` could reduce additional
      //   path matching.
      // @returns {TestResult} true if a file is ignored
      _testOne(path, checkUnignored) {
        let ignored = false;
        let unignored = false;
        this._rules.forEach((rule) => {
          const { negative } = rule;
          if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) {
            return;
          }
          const matched = rule.regex.test(path);
          if (matched) {
            ignored = !negative;
            unignored = negative;
          }
        });
        return {
          ignored,
          unignored
        };
      }
      // @returns {TestResult}
      _test(originalPath, cache, checkUnignored, slices) {
        const path = originalPath && checkPath.convert(originalPath);
        checkPath(
          path,
          originalPath,
          this._allowRelativePaths ? RETURN_FALSE : throwError
        );
        return this._t(path, cache, checkUnignored, slices);
      }
      _t(path, cache, checkUnignored, slices) {
        if (path in cache) {
          return cache[path];
        }
        if (!slices) {
          slices = path.split(SLASH);
        }
        slices.pop();
        if (!slices.length) {
          return cache[path] = this._testOne(path, checkUnignored);
        }
        const parent = this._t(
          slices.join(SLASH) + SLASH,
          cache,
          checkUnignored,
          slices
        );
        return cache[path] = parent.ignored ? parent : this._testOne(path, checkUnignored);
      }
      ignores(path) {
        return this._test(path, this._ignoreCache, false).ignored;
      }
      createFilter() {
        return (path) => !this.ignores(path);
      }
      filter(paths) {
        return makeArray(paths).filter(this.createFilter());
      }
      // @returns {TestResult}
      test(path) {
        return this._test(path, this._testCache, true);
      }
    };
    var factory = (options) => new Ignore(options);
    var isPathValid = (path) => checkPath(path && checkPath.convert(path), path, RETURN_FALSE);
    factory.isPathValid = isPathValid;
    factory.default = factory;
    module.exports = factory;
    if (
      // Detect `process` so that it can run in browsers.
      typeof process !== "undefined" && (process.env && process.env.IGNORE_TEST_WIN32 || process.platform === "win32")
    ) {
      const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
      checkPath.convert = makePosix;
      const REGIX_IS_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
      checkPath.isNotRelative = (path) => REGIX_IS_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
    }
  }
});

// src/core/token.ts
var PICTOGRAPHIC_CHARACTER;
var init_token = __esm({
  "src/core/token.ts"() {
    "use strict";
    PICTOGRAPHIC_CHARACTER = new RegExp("\\p{Extended_Pictographic}", "u");
  }
});

// src/core/polyglot.ts
var TREE_SITTER_RUNTIME, PINNED_GRAMMARS;
var init_polyglot = __esm({
  "src/core/polyglot.ts"() {
    "use strict";
    TREE_SITTER_RUNTIME = "web-tree-sitter@0.26.11";
    PINNED_GRAMMARS = {
      python: { version: "v0.25.0", asset: "tree-sitter-python.wasm" },
      go: { version: "v0.25.0", asset: "tree-sitter-go.wasm" },
      rust: { version: "v0.24.2", asset: "tree-sitter-rust.wasm" },
      java: { version: "v0.23.5", asset: "tree-sitter-java.wasm" }
    };
  }
});

// src/core/typescriptParser.ts
var init_typescriptParser = __esm({
  "src/core/typescriptParser.ts"() {
    "use strict";
  }
});

// src/core/fileScanner.ts
import { createHash as createHash4 } from "node:crypto";
import { readdir as readdir4, readFile as readFile2, stat } from "node:fs/promises";
import { basename as basename2, dirname as dirname5, extname, join as join5, normalize, relative as relative4, sep as sep2 } from "node:path";
function normalizePath(path) {
  return path.split(sep2).join("/");
}
function hashText(text) {
  return createHash4("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex");
}
function exclusionForName(name) {
  if (DEPENDENCY_DIRS.has(name)) return "dependency";
  if (BUILD_DIRS.has(name)) return "build-output";
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))) return "secret";
  return void 0;
}
async function loadIgnoreScopes(base, inherited = [], reader) {
  let content;
  if (reader) {
    const inspected = await reader.text(join5(base, ".gitignore"), MAX_INDEXED_BYTES);
    if (inspected === void 0) return inherited;
    content = inspected;
  } else {
    try {
      content = await readFile2(join5(base, ".gitignore"), "utf8");
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      return inherited;
    }
  }
  const matcher = createIgnore();
  matcher.add(content);
  return [...inherited, { base, matcher }];
}
function isIgnored(scopes, absolutePath, isDirectory) {
  let ignored = false;
  for (const { base, matcher } of scopes) {
    const path = normalizePath(relative4(base, absolutePath));
    if (!path) continue;
    const decision = matcher.test(isDirectory ? `${path}/` : path);
    if (decision.ignored) ignored = true;
    if (decision.unignored) ignored = false;
  }
  return ignored;
}
function languageForExtension(extension) {
  switch (extension) {
    case ".tsx":
      return "tsx";
    case ".ts":
      return "typescript";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".sql":
      return "sql";
    case ".md":
    case ".mdx":
      return "markdown";
    default:
      return "text";
  }
}
function isGeneratedFile(path, content) {
  return /(?:^|\/)(?:generated|__generated__)(?:\/|$)|(?:\.generated\.|\.g\.)[A-Za-z0-9]+$/i.test(path) || /^(?:\/\/|#|\/\*)\s*@?generated\b/im.test(content.slice(0, 512));
}
function isTestPath(path) {
  return /(^|[/.])(test|spec)\.[jt]sx?$/.test(path) || /(^|\/)(__tests__|tests)\//.test(path);
}
function nextRouteForPath(path) {
  const parts = path.split("/");
  const fileName = parts.at(-1) ?? "";
  if (path.startsWith("app/")) {
    if (!/^(page|route)\.[jt]sx?$/.test(fileName)) {
      return void 0;
    }
    const routeParts2 = parts.slice(1, -1).filter((part) => !part.startsWith("("));
    return `/${routeParts2.join("/")}`.replace(/\/$/, "") || "/";
  }
  if (!path.startsWith("pages/") || !/\.[jt]sx?$/.test(fileName) || fileName.startsWith("_")) {
    return void 0;
  }
  const routeParts = parts.slice(1);
  const leaf = routeParts.at(-1);
  if (!leaf) return void 0;
  routeParts[routeParts.length - 1] = leaf.replace(/\.[jt]sx?$/, "");
  if (routeParts.at(-1) === "index") {
    routeParts.pop();
  }
  return `/${routeParts.join("/")}`.replace(/\/$/, "") || "/";
}
function budgetFromOptions(options) {
  return {
    maxFiles: options?.maxFiles ?? DEFAULT_SCAN_BUDGET.maxFiles,
    maxDirectories: options?.maxDirectories ?? DEFAULT_SCAN_BUDGET.maxDirectories,
    maxDepth: options?.maxDepth ?? DEFAULT_SCAN_BUDGET.maxDepth,
    maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_SCAN_BUDGET.maxTotalBytes,
    maxFileBytes: options?.maxFileBytes ?? DEFAULT_SCAN_BUDGET.maxFileBytes,
    maxSymbols: options?.maxSymbols ?? DEFAULT_SCAN_BUDGET.maxSymbols,
    maxNodes: options?.maxNodes ?? DEFAULT_SCAN_BUDGET.maxNodes,
    maxGeneratedFiles: options?.maxGeneratedFiles ?? DEFAULT_SCAN_BUDGET.maxGeneratedFiles,
    perFileTimeoutMs: options?.perFileTimeoutMs ?? DEFAULT_SCAN_BUDGET.perFileTimeoutMs,
    wholeIndexTimeoutMs: options?.wholeIndexTimeoutMs ?? DEFAULT_SCAN_BUDGET.wholeIndexTimeoutMs,
    polyglotEnabled: options?.polyglotEnabled ?? DEFAULT_SCAN_BUDGET.polyglotEnabled
  };
}
async function configurationSignatureRows(root, reader) {
  const configurationRows = [];
  for (const path of CONFIGURATION_FILES) {
    if (reader) {
      const content = await reader.text(join5(root, path), MAX_INDEXED_BYTES);
      if (content !== void 0) configurationRows.push({ path, contentHash: hashText(content) });
      continue;
    }
    try {
      configurationRows.push({ path, contentHash: hashText(await readFile2(join5(root, path), "utf8")) });
    } catch (error) {
      if (error.code !== "ENOENT") configurationRows.push({ path, contentHash: "unreadable" });
    }
  }
  return configurationRows;
}
async function scanProjectSignature(root, options, reader) {
  return (await scanProjectFileMetadata(root, options, reader)).scanSignature;
}
async function scanProjectFileMetadata(root, options, reader) {
  const ignoreScopes = await loadIgnoreScopes(root, [], reader);
  const rows = [];
  const files = [];
  const exclusions = [];
  const budget = budgetFromOptions(options);
  const deadline = Date.now() + budget.wholeIndexTimeoutMs;
  let directories = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let generatedFiles = 0;
  async function walkSignature(current, depth, inheritedScopes) {
    const currentScopes = current === root ? inheritedScopes : await loadIgnoreScopes(current, inheritedScopes, reader);
    let entries;
    try {
      entries = reader ? await reader.directory(current) : await readdir4(current, { withFileTypes: true });
      if (entries === void 0) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    } catch (error) {
      if (reader) throw error;
      const path = normalizePath(relative4(root, current)) || ".";
      rows.push({ path, reason: "unreadable" });
      exclusions.push({ path, reason: "unreadable" });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        rows.push({ path: normalizePath(relative4(root, current)) || ".", reason: "budget" });
        exclusions.push({ path: normalizePath(relative4(root, current)) || ".", reason: "budget" });
        break;
      }
      const absolute = join5(current, entry.name);
      const relativePath = normalizePath(relative4(root, absolute));
      if (entry.name === ".tokengraph") continue;
      if (relativePath && isIgnored(currentScopes, absolute, entry.isDirectory())) {
        rows.push({ path: relativePath, reason: "ignored" });
        exclusions.push({ path: relativePath, reason: "ignored" });
        continue;
      }
      const exclusionReason = exclusionForName(entry.name);
      if (exclusionReason) {
        rows.push({ path: relativePath, reason: exclusionReason });
        exclusions.push({ path: relativePath, reason: exclusionReason });
        continue;
      }
      if (entry.name.startsWith(".")) {
        rows.push({ path: relativePath, reason: "hidden" });
        exclusions.push({ path: relativePath, reason: "hidden" });
        continue;
      }
      if (entry.isSymbolicLink()) {
        rows.push({ path: relativePath, reason: "symlink" });
        exclusions.push({ path: relativePath, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (depth + 1 > budget.maxDepth || directories >= budget.maxDirectories) {
          rows.push({ path: relativePath, reason: "budget" });
          exclusions.push({ path: relativePath, reason: "budget" });
          continue;
        }
        directories += 1;
        await walkSignature(absolute, depth + 1, currentScopes);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        rows.push({ path: relativePath, reason: "unsupported" });
        exclusions.push({ path: relativePath, reason: "unsupported" });
        continue;
      }
      let fileStat;
      try {
        fileStat = reader ? await reader.inspect(absolute) : await stat(absolute, { bigint: true });
        if (!fileStat) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      } catch (error) {
        if (reader) throw error;
        rows.push({ path: relativePath, reason: "unreadable" });
        exclusions.push({ path: relativePath, reason: "unreadable" });
        continue;
      }
      const size = Number(fileStat.size);
      if (fileCount >= budget.maxFiles || totalBytes + size > budget.maxTotalBytes) {
        rows.push({ path: relativePath, reason: "budget" });
        exclusions.push({ path: relativePath, reason: "budget" });
        continue;
      }
      if (size > budget.maxFileBytes) {
        rows.push({ path: relativePath, reason: "large-file" });
        exclusions.push({ path: relativePath, reason: "large-file" });
        continue;
      }
      let content;
      try {
        content = reader ? await reader.text(absolute, budget.maxFileBytes) : await readFile2(absolute, "utf8");
        if (content === void 0) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      } catch (error) {
        if (reader) throw error;
        rows.push({ path: relativePath, reason: "unreadable" });
        exclusions.push({ path: relativePath, reason: "unreadable" });
        continue;
      }
      if (content.includes("\0")) {
        rows.push({ path: relativePath, reason: "binary" });
        exclusions.push({ path: relativePath, reason: "binary" });
        continue;
      }
      if (isGeneratedFile(relativePath, content)) {
        if (generatedFiles >= budget.maxGeneratedFiles) {
          rows.push({ path: relativePath, reason: "budget" });
          exclusions.push({ path: relativePath, reason: "budget" });
          continue;
        }
        generatedFiles += 1;
      }
      const metadata = {
        path: relativePath,
        size,
        mtimeNs: fileStat.mtimeNs.toString(),
        ctimeNs: fileStat.ctimeNs.toString(),
        contentHash: hashText(content),
        language: languageForExtension(extension),
        extension,
        route: nextRouteForPath(relativePath),
        isTest: isTestPath(relativePath)
      };
      rows.push({ path: relativePath, size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs, contentHash: metadata.contentHash });
      files.push(metadata);
      fileCount += 1;
      totalBytes += size;
    }
  }
  await walkSignature(root, 0, ignoreScopes);
  files.sort((a, b) => a.path.localeCompare(b.path));
  exclusions.sort((a, b) => a.path.localeCompare(b.path));
  const configurationRows = await configurationSignatureRows(root, reader);
  return { files, exclusions, scanSignature: hashText(JSON.stringify({ rows, configurationRows })) };
}
var ignorePackage, DEPENDENCY_DIRS, BUILD_DIRS, SUPPORTED_EXTENSIONS, CONFIGURATION_FILES, SECRET_FILE_PATTERNS, MAX_INDEXED_BYTES, DEFAULT_SCAN_BUDGET, createIgnore;
var init_fileScanner = __esm({
  "src/core/fileScanner.ts"() {
    "use strict";
    ignorePackage = __toESM(require_ignore(), 1);
    init_token();
    init_polyglot();
    init_typescriptParser();
    DEPENDENCY_DIRS = /* @__PURE__ */ new Set(["node_modules", "vendor", "bower_components"]);
    BUILD_DIRS = /* @__PURE__ */ new Set([".next", "dist", "build", "out", "coverage", ".turbo", ".cache", ".parcel-cache"]);
    SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".sql", ".md", ".mdx"]);
    CONFIGURATION_FILES = ["tsconfig.json", "jsconfig.json", ".eslintrc.json", ".prettierrc.json"];
    SECRET_FILE_PATTERNS = [/^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_rsa$/i, /^id_ed25519$/i];
    MAX_INDEXED_BYTES = 512 * 1024;
    DEFAULT_SCAN_BUDGET = {
      maxFiles: 5e3,
      maxDirectories: 1e3,
      maxDepth: 32,
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: MAX_INDEXED_BYTES,
      maxSymbols: 1e4,
      maxNodes: 25e4,
      maxGeneratedFiles: 200,
      perFileTimeoutMs: 2e3,
      wholeIndexTimeoutMs: 6e4,
      polyglotEnabled: false
    };
    createIgnore = "default" in ignorePackage ? ignorePackage.default : ignorePackage;
  }
});

// src/core/sqlParser.ts
var init_sqlParser = __esm({
  "src/core/sqlParser.ts"() {
    "use strict";
  }
});

// src/core/symbolChunks.ts
var init_symbolChunks = __esm({
  "src/core/symbolChunks.ts"() {
    "use strict";
  }
});

// src/core/configData.ts
var DEFAULT_LIMITS;
var init_configData = __esm({
  "src/core/configData.ts"() {
    "use strict";
    DEFAULT_LIMITS = { maxBytes: 512 * 1024, maxDepth: 32, maxNodes: 2e4, timeoutMs: 2e3 };
  }
});

// src/core/diagnosticRead.ts
import { constants as constants5 } from "node:fs";
import { lstat as lstat5, open as open5, opendir, realpath as realpath3 } from "node:fs/promises";
import { isAbsolute as isAbsolute3, join as join6, parse as parse3, relative as relative5, resolve as resolve5 } from "node:path";
function same(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function confined(root, path) {
  const nested = relative5(root, path);
  return nested === "" || !isAbsolute3(nested) && nested !== ".." && !nested.startsWith("../") && !nested.startsWith("..\\");
}
var DiagnosticBoundaryError, DiagnosticReader;
var init_diagnosticRead = __esm({
  "src/core/diagnosticRead.ts"() {
    "use strict";
    DiagnosticBoundaryError = class extends Error {
      code = "DIAGNOSTIC_BOUNDARY_VIOLATION";
      constructor() {
        super("TokenGraph diagnostic path is linked, outside its authorized root, or changed identity.");
      }
    };
    DiagnosticReader = class {
      root;
      remainingEntries = 2e4;
      remainingBytes = 512 * 1024 * 1024;
      constructor(root) {
        this.root = resolve5(root);
      }
      async capture(path) {
        const absolute = resolve5(path);
        if (!confined(this.root, absolute)) throw new DiagnosticBoundaryError();
        const volume = parse3(absolute).root;
        let current = volume;
        const snapshots = [];
        for (const segment of absolute.slice(volume.length).split(/[\\/]+/).filter(Boolean)) {
          current = join6(current, segment);
          let stats;
          try {
            stats = await lstat5(current, { bigint: true });
          } catch (error) {
            if (error.code === "ENOENT") {
              await this.validate(snapshots);
              return void 0;
            }
            throw error;
          }
          if (stats.isSymbolicLink() || current !== absolute && !stats.isDirectory()) throw new DiagnosticBoundaryError();
          if (confined(this.root, current)) snapshots.push({ path: current, stats });
        }
        if (await realpath3(absolute) !== absolute) throw new DiagnosticBoundaryError();
        return snapshots;
      }
      async validate(snapshots) {
        for (const snapshot of snapshots) {
          const current = await lstat5(snapshot.path, { bigint: true }).catch(() => {
            throw new DiagnosticBoundaryError();
          });
          if (current.isSymbolicLink() || !same(snapshot.stats, current)) throw new DiagnosticBoundaryError();
        }
      }
      async inspect(path) {
        const snapshots = await this.capture(path);
        if (!snapshots) return void 0;
        await this.validate(snapshots);
        return snapshots.at(-1)?.stats;
      }
      async directory(path) {
        path = resolve5(path);
        const snapshots = await this.capture(path);
        if (!snapshots) return void 0;
        if (!snapshots.at(-1)?.stats.isDirectory()) throw new DiagnosticBoundaryError();
        const directory = await opendir(path, { bufferSize: 1 });
        try {
          await this.validate(snapshots);
          const entries = [];
          for (; ; ) {
            await this.validate(snapshots);
            const entry = await directory.read();
            await this.validate(snapshots);
            if (!entry) return entries.sort((a, b) => a.name.localeCompare(b.name));
            if (--this.remainingEntries < 0) throw new Error("TokenGraph diagnostic entry budget exceeded.");
            if (entry.isSymbolicLink()) throw new DiagnosticBoundaryError();
            entries.push(entry);
          }
        } finally {
          await directory.close();
        }
      }
      async bytes(path, maximumBytes) {
        path = resolve5(path);
        const snapshots = await this.capture(path);
        if (!snapshots) return void 0;
        const before = snapshots.at(-1).stats;
        if (!before.isFile() || before.nlink !== 1n) throw new DiagnosticBoundaryError();
        if (before.size < 0n || before.size > BigInt(maximumBytes) || before.size > BigInt(this.remainingBytes)) {
          throw new Error("TokenGraph diagnostic byte budget exceeded.");
        }
        this.remainingBytes -= Number(before.size);
        const handle = await open5(path, constants5.O_RDONLY | (constants5.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat({ bigint: true });
          if (!same(before, opened)) throw new DiagnosticBoundaryError();
          await this.validate(snapshots);
          const bytes = Buffer.alloc(Number(before.size) + 1);
          let count = 0;
          while (count < bytes.length) {
            const result = await handle.read(bytes, count, bytes.length - count, count);
            if (!result.bytesRead) break;
            count += result.bytesRead;
          }
          if (BigInt(count) !== before.size || !same(before, await handle.stat({ bigint: true }))) throw new DiagnosticBoundaryError();
          await this.validate(snapshots);
          return bytes.subarray(0, count);
        } finally {
          await handle.close();
        }
      }
      async text(path, maximumBytes) {
        return (await this.bytes(path, maximumBytes))?.toString("utf8");
      }
    };
  }
});

// src/core/repositoryIdentity.ts
var repositoryIdentity_exports = {};
__export(repositoryIdentity_exports, {
  LOCAL_EXCLUDE_WARNING: () => LOCAL_EXCLUDE_WARNING,
  getGitFileRecency: () => getGitFileRecency,
  getRepositoryIdentity: () => getRepositoryIdentity,
  getRepositoryIdentityReadOnly: () => getRepositoryIdentityReadOnly,
  getRepositorySetupWarnings: () => getRepositorySetupWarnings,
  gitCommonDirectory: () => gitCommonDirectory,
  isGitWorkspace: () => isGitWorkspace,
  repositoryStateDirectory: () => repositoryStateDirectory,
  resolveRepositoryStateDirectory: () => resolveRepositoryStateDirectory
});
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash as createHash5 } from "node:crypto";
import { access, lstat as lstat6, readFile as readFile3, readdir as readdir5 } from "node:fs/promises";
import { isAbsolute as isAbsolute4, join as join7, relative as relative6, resolve as resolve6 } from "node:path";
async function git(root, ...args) {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim();
    return output || void 0;
  } catch {
    return void 0;
  }
}
async function getGitFileRecency(root, requestedPaths, requestedDepth = 50) {
  const historyDepth = Math.max(1, Math.min(50, Number.isFinite(requestedDepth) ? Math.trunc(requestedDepth) : 50));
  const neutral = { source: "unavailable", historyDepth, fileCommitDistance: {} };
  const normalizedPaths = [...new Set(requestedPaths.map((path) => path.replaceAll("\\", "/")))].sort();
  const requested = new Set(normalizedPaths);
  try {
    const result = await execFileAsync("git", [
      "-C",
      resolve6(root),
      "-c",
      "core.quotePath=false",
      "log",
      "-n",
      String(historyDepth),
      "--format=commit:%H%x00",
      "--name-only",
      "-z",
      "--no-renames",
      "HEAD",
      "--"
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const distances = /* @__PURE__ */ new Map();
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
async function ensureLocalExclude(root) {
  const exclude = await git(root, "rev-parse", "--git-path", "info/exclude");
  if (!exclude) return;
  const path = resolve6(root, exclude);
  try {
    const lock = await canonicalPersistenceLock(root, "git-info", "exclude");
    await withFileLock(lock, async () => {
      let existing = "";
      try {
        existing = await readFile3(path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const lines = existing.split(/\r?\n/);
      if (lines.some((line) => line.trim() === ".tokengraph/")) return;
      const next = `${existing.replace(/[\r\n]*$/, "")}${existing ? "\n" : ""}.tokengraph/
`;
      await writeTextAtomic(path, next);
    });
    setupWarnings.delete(resolve6(root));
  } catch {
    setupWarnings.set(resolve6(root), [LOCAL_EXCLUDE_WARNING]);
  }
}
function getRepositorySetupWarnings(root) {
  return [...setupWarnings.get(resolve6(root)) ?? []];
}
function digest(value) {
  return createHash5("sha256").update(value).digest("hex");
}
async function remoteIdentity(root) {
  const remotes = await git(root, "remote", "get-url", "--all", "origin");
  return remotes?.split(/\r?\n/).map((value) => sanitizeRemote(value.trim())).filter(Boolean).sort().join("\n");
}
function sanitizeRemote(value) {
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
async function loadOrCreateRepositoryIdUnqueued(workspaceRoot, directory) {
  const path = join7(directory, "identity.json");
  try {
    const parsed = JSON.parse(await readFile3(path, "utf8"));
    if (parsed.schemaVersion === 1 && typeof parsed.repositoryId === "string" && parsed.repositoryId.length >= 16) return parsed.repositoryId;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const repositoryId = digest(`${directory}
${Date.now()}
${Math.random()}`);
  const lock = await canonicalPersistenceLock(workspaceRoot, "repository-state", "identity.json");
  await withFileLock(lock, async () => {
    try {
      const existing = JSON.parse(await readFile3(path, "utf8"));
      if (existing.schemaVersion === 1 && typeof existing.repositoryId === "string" && existing.repositoryId.length >= 16) return;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await writeJsonAtomic(path, { schemaVersion: 1, repositoryId }, { telemetry: { root: workspaceRoot, storageClass: "durable" } });
  });
  try {
    const persisted = JSON.parse(await readFile3(path, "utf8"));
    return typeof persisted.repositoryId === "string" ? persisted.repositoryId : repositoryId;
  } catch {
    return repositoryId;
  }
}
async function loadOrCreateRepositoryId(workspaceRoot, directory) {
  const key = process.platform === "win32" ? resolve6(directory).toLowerCase() : resolve6(directory);
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
async function getRepositoryIdentity(root) {
  const workspaceRoot = resolve6(root);
  return getRepositoryIdentityUncached(workspaceRoot);
}
async function getRepositoryIdentityReadOnly(root) {
  const workspaceRoot = resolve6(root);
  const reader = new DiagnosticReader(workspaceRoot);
  await reader.inspect(join7(workspaceRoot, ".tokengraph"));
  const dotGit = await reader.inspect(join7(workspaceRoot, ".git"));
  if (!dotGit?.isDirectory()) return void 0;
  const [topLevel, gitDir, branch, headCommit, firstCommits, remote] = await Promise.all([
    git(workspaceRoot, "rev-parse", "--show-toplevel"),
    git(workspaceRoot, "rev-parse", "--git-dir"),
    git(workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"),
    git(workspaceRoot, "rev-parse", "HEAD"),
    git(workspaceRoot, "rev-list", "--max-parents=0", "HEAD"),
    remoteIdentity(workspaceRoot)
  ]);
  const normalizedRoot = resolve6(topLevel ?? workspaceRoot);
  const within2 = relative6(workspaceRoot, normalizedRoot);
  if (isAbsolute4(within2) || within2 === ".." || within2.startsWith("..\\") || within2.startsWith("../")) return void 0;
  const normalizedGitDir = gitDir ? resolve6(workspaceRoot, gitDir) : void 0;
  let repositoryId;
  try {
    const text = await reader.text(join7(repositoryStateDirectory(normalizedRoot), "identity.json"), 64 * 1024);
    if (text === void 0) return void 0;
    const persisted = JSON.parse(text);
    if (persisted.schemaVersion === 1 && typeof persisted.repositoryId === "string" && persisted.repositoryId.length >= 16) {
      repositoryId = persisted.repositoryId;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!repositoryId) return void 0;
  const firstCommit = firstCommits?.split(/\r?\n/).filter(Boolean).sort()[0] ?? "unborn";
  return {
    repositoryId,
    repositoryFingerprint: digest(`${repositoryId}
${firstCommit}`),
    workspaceId: digest(normalizedRoot),
    worktreeId: digest(normalizedGitDir ?? normalizedRoot),
    branch: branch ?? "detached",
    headCommit: headCommit ?? "unborn",
    ...remote ? { remoteIdentity: remote } : {}
  };
}
async function getRepositoryIdentityUncached(workspaceRoot) {
  const [topLevel, commonDir, gitDir, branch, headCommit, firstCommits, remote] = await Promise.all([
    git(workspaceRoot, "rev-parse", "--show-toplevel"),
    git(workspaceRoot, "rev-parse", "--git-common-dir"),
    git(workspaceRoot, "rev-parse", "--git-dir"),
    git(workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"),
    git(workspaceRoot, "rev-parse", "HEAD"),
    git(workspaceRoot, "rev-list", "--max-parents=0", "HEAD"),
    remoteIdentity(workspaceRoot)
  ]);
  const normalizedRoot = resolve6(topLevel ?? workspaceRoot);
  const normalizedGitDir = gitDir ? resolve6(workspaceRoot, gitDir) : void 0;
  if (topLevel && commonDir) await ensureLocalExclude(workspaceRoot);
  const repositoryState = await resolveRepositoryStateDirectory(normalizedRoot);
  const repositoryId = await loadOrCreateRepositoryId(workspaceRoot, repositoryState);
  const firstCommit = firstCommits?.split(/\r?\n/).filter(Boolean).sort()[0] ?? "unborn";
  const repositoryFingerprint = digest(`${repositoryId}
${firstCommit}`);
  return {
    repositoryId,
    repositoryFingerprint,
    workspaceId: digest(normalizedRoot),
    worktreeId: digest(normalizedGitDir ?? normalizedRoot),
    branch: branch ?? "detached",
    headCommit: headCommit ?? "unborn",
    ...remote ? { remoteIdentity: remote } : {}
  };
}
async function gitCommonDirectory(root) {
  const commonDir = await git(resolve6(root), "rev-parse", "--git-common-dir");
  if (!commonDir) return void 0;
  return resolve6(root, commonDir);
}
function repositoryStateDirectory(root, commonDirectory) {
  void commonDirectory;
  return join7(resolve6(root), ".tokengraph", "repository");
}
async function isGitWorkspace(root) {
  try {
    await access(join7(resolve6(root), ".git"));
    return Boolean(await git(resolve6(root), "rev-parse", "--show-toplevel"));
  } catch {
    return false;
  }
}
async function resolveRepositoryStateDirectory(root) {
  const normalizedRoot = resolve6(root);
  const target = repositoryStateDirectory(normalizedRoot);
  if (!getLegacyRuntimeActivationStatus().activated) return target;
  const commonDirectory = await gitCommonDirectory(normalizedRoot);
  if (commonDirectory) await migrateLegacyRepositoryState(normalizedRoot, join7(commonDirectory, "tokengraph"), target);
  return target;
}
async function migrateLegacyRepositoryState(workspaceRoot, source, target) {
  try {
    await lstat6(join7(target, "migration.json"));
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let sourceStats;
  try {
    sourceStats = await lstat6(source);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!sourceStats.isDirectory()) return;
  const lock = await canonicalPersistenceLock(workspaceRoot, "repository-state", "migration.json");
  await withFileLock(lock, async () => {
    try {
      await lstat6(join7(target, "migration.json"));
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const report = {
      schemaVersion: LEGACY_REPOSITORY_STATE_SCHEMA_VERSION,
      source,
      migratedAt: (/* @__PURE__ */ new Date()).toISOString(),
      migrated: [],
      skippedExisting: [],
      skippedInvalid: [],
      skippedUnsupported: [],
      skippedSymlink: []
    };
    await migrateLegacyEntries(workspaceRoot, source, target, "", report);
    await writeJsonAtomic(join7(target, "migration.json"), report, { telemetry: { root: workspaceRoot, storageClass: "durable" } });
  });
}
async function migrateLegacyEntries(workspaceRoot, sourceRoot, targetRoot, relativePath, report) {
  const sourceDirectory = join7(sourceRoot, relativePath);
  for (const entry of await readdir5(sourceDirectory, { withFileTypes: true })) {
    const entryRelativePath = relativePath ? join7(relativePath, entry.name) : entry.name;
    const sourcePath = join7(sourceRoot, entryRelativePath);
    if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) {
      report.skippedUnsupported.push(entryRelativePath);
      continue;
    }
    const stats = await lstat6(sourcePath);
    if (stats.isSymbolicLink()) {
      report.skippedSymlink.push(entryRelativePath);
      continue;
    }
    if (stats.isDirectory()) {
      await migrateLegacyEntries(workspaceRoot, sourceRoot, targetRoot, entryRelativePath, report);
      continue;
    }
    if (!stats.isFile() || !entry.name.endsWith(".json")) {
      report.skippedUnsupported.push(entryRelativePath);
      continue;
    }
    const targetPath = join7(targetRoot, entryRelativePath);
    try {
      await lstat6(targetPath);
      report.skippedExisting.push(entryRelativePath);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let contents;
    try {
      contents = await readFile3(sourcePath, "utf8");
      JSON.parse(contents);
    } catch (error) {
      if (error instanceof SyntaxError) {
        report.skippedInvalid.push(entryRelativePath);
        continue;
      }
      throw error;
    }
    await writeTextAtomic(targetPath, contents, { telemetry: { root: workspaceRoot, storageClass: "durable" } });
    report.migrated.push(entryRelativePath);
  }
}
var execFileAsync, LOCAL_EXCLUDE_WARNING, setupWarnings, LEGACY_REPOSITORY_STATE_SCHEMA_VERSION, repositoryIdLoads;
var init_repositoryIdentity = __esm({
  "src/core/repositoryIdentity.ts"() {
    "use strict";
    init_lockDomain();
    init_legacyRuntimeActivation();
    init_storage();
    init_diagnosticRead();
    execFileAsync = promisify(execFile);
    LOCAL_EXCLUDE_WARNING = "TokenGraph could not update .git/info/exclude; add this exact line manually: .tokengraph/";
    setupWarnings = /* @__PURE__ */ new Map();
    LEGACY_REPOSITORY_STATE_SCHEMA_VERSION = 1;
    repositoryIdLoads = /* @__PURE__ */ new Map();
  }
});

// src/core/projectIndexer.ts
import { createHash as createHash6, randomUUID as randomUUID3 } from "node:crypto";
import { dirname as dirname6, extname as extname2, isAbsolute as isAbsolute5, relative as relative7, resolve as resolve7 } from "node:path";
function fingerprintPayload(value) {
  return createHash6("sha256").update(JSON.stringify(value)).digest("hex");
}
function terminalExclusions(scanMetadata, exclusions) {
  const indexedPaths = new Set(Object.keys(scanMetadata.files));
  return exclusions.filter((exclusion) => !indexedPaths.has(exclusion.path)).sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
}
function validatedContentSetHash(scanMetadata, exclusions) {
  const files = Object.values(scanMetadata.files).map(({ path, contentHash }) => ({ path, contentHash })).sort((left, right) => left.path.localeCompare(right.path));
  return fingerprintPayload({ files, terminalExclusions: terminalExclusions(scanMetadata, exclusions) });
}
function unsupportedLanguageCounts(graph) {
  const counts = {};
  for (const exclusion of graph.exclusions) {
    if (exclusion.reason !== "unsupported") continue;
    const extension = extname2(exclusion.path).toLowerCase() || "<extensionless>";
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
function projectIndexFingerprint(index) {
  return fingerprintPayload({
    files: index.files,
    symbols: index.symbols,
    imports: index.imports,
    exclusions: index.exclusions,
    sql: index.sql,
    configuration: index.configuration ?? [],
    unsupportedLanguageCounts: index.unsupportedLanguageCounts ?? unsupportedLanguageCounts(index),
    retrievalSignals: index.retrievalSignals
  });
}
var CURRENT_INDEX_SCHEMA_VERSION;
var init_projectIndexer = __esm({
  "src/core/projectIndexer.ts"() {
    "use strict";
    init_fileScanner();
    init_sqlParser();
    init_symbolChunks();
    init_configData();
    init_repositoryIdentity();
    init_storage();
    CURRENT_INDEX_SCHEMA_VERSION = 5;
  }
});

// src/core/persistence.ts
import { createHash as createHash7, randomUUID as randomUUID4 } from "node:crypto";
import { constants as constants6 } from "node:fs";
import { chmod as chmod4, lstat as lstat7, mkdir as mkdir3, open as open6, readFile as readFile4, readdir as readdir6, rename as rename3, rm as rm2 } from "node:fs/promises";
import { basename as basename3, dirname as dirname7, isAbsolute as isAbsolute6, join as join8, relative as relative8, resolve as resolve8 } from "node:path";
function stateDir(root) {
  return join8(root, ".tokengraph");
}
async function repositoryDir(root) {
  return resolveRepositoryStateDirectory(root);
}
function indexPath(root) {
  return join8(stateDir(root), "index.json");
}
function indexManifestPath(root) {
  return join8(stateDir(root), ".index-manifest.json");
}
function configPath(root) {
  return join8(stateDir(root), "config.json");
}
function runsDir(root) {
  return join8(stateDir(root), "runs");
}
function runPath(root, runId) {
  return join8(runsDir(root), `${runId}.json`);
}
function wikiDir(root) {
  return join8(stateDir(root), "wiki");
}
function vaultDir(root) {
  return join8(stateDir(root), "vault");
}
function isIndexGenerationArtifactName(name) {
  return INDEX_GENERATION_PATTERN.test(name) || INDEX_CANDIDATE_PATTERN.test(name) || INDEX_MANIFEST_TEMP_PATTERN.test(name);
}
function sha256(content) {
  return createHash7("sha256").update(content).digest("hex");
}
function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}
function sameRepositoryIdentity(left, right) {
  return Boolean(left && right && sameRepositoryLineage(left, right) && left.headCommit === right.headCommit);
}
function sameRepositoryLineage(left, right) {
  return Boolean(left && right && left.repositoryId === right.repositoryId && left.repositoryFingerprint === right.repositoryFingerprint && left.workspaceId === right.workspaceId && left.worktreeId === right.worktreeId && left.branch === right.branch && left.remoteIdentity === right.remoteIdentity);
}
function generationValidationFailure(root, index, currentIdentity) {
  const generation = index.generation;
  if (!generation) return "generation metadata is missing";
  if (!INDEX_GENERATION_PATTERN.test(`.index-generation-${generation.id}.json`)) return "generation id is malformed";
  if (!isCanonicalIsoTimestamp(generation.createdAt) || generation.createdAt !== index.scannedAt) return "generation creation time is invalid";
  if (typeof index.scanSignature !== "string" || !SHA256_PATTERN.test(index.scanSignature) || typeof generation.sourceScanSignature !== "string" || !SHA256_PATTERN.test(generation.sourceScanSignature)) {
    return "generation source scan signature is malformed";
  }
  if (generation.sourceScanSignature !== index.scanSignature) return "generation source scan signature does not match the index";
  if (!index.scanMetadata?.files || !Array.isArray(index.scanMetadata.exclusions)) return "scan metadata is missing";
  const metadataEntries = Object.entries(index.scanMetadata.files);
  if (metadataEntries.some(([path, metadata]) => path !== metadata.path || !isNormalizedRelativePath(path))) return "scan metadata paths are malformed";
  const indexedPaths = index.files.map((file) => file.path).sort();
  const metadataPaths = metadataEntries.map(([path]) => path).sort();
  if (new Set(indexedPaths).size !== indexedPaths.length || JSON.stringify(indexedPaths) !== JSON.stringify(metadataPaths)) {
    return "scan metadata and indexed file paths differ";
  }
  if (index.files.some((file) => index.scanMetadata?.files[file.path]?.contentHash !== file.contentHash)) {
    return "scan metadata and indexed content hashes differ";
  }
  const indexedPathSet = new Set(indexedPaths);
  const terminalPaths = new Set(index.exclusions.filter((entry) => !indexedPathSet.has(entry.path)).map((entry) => entry.path));
  const scannerTerminalExclusions = index.scanMetadata.exclusions.filter((entry) => !indexedPathSet.has(entry.path)).sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  const indexedTerminalExclusions = index.exclusions.filter((entry) => !indexedPathSet.has(entry.path)).sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  if (JSON.stringify(scannerTerminalExclusions) !== JSON.stringify(indexedTerminalExclusions)) {
    return "scanner terminal exclusions and indexed exclusions differ";
  }
  if (generation.intendedFileCount !== metadataPaths.length + terminalPaths.size) return "generation intended-file count is invalid";
  if (generation.terminalExclusionsHash !== sha256(JSON.stringify(scannerTerminalExclusions))) {
    return "generation terminal-exclusions hash is invalid";
  }
  if (generation.validatedContentSetHash !== validatedContentSetHash(index.scanMetadata, index.exclusions)) {
    return "generation content-set hash is invalid";
  }
  if (index.fingerprint !== projectIndexFingerprint(index)) return "index fingerprint is invalid";
  if (resolve8(index.root) !== resolve8(root)) return "index root does not match the requested workspace";
  if (!sameRepositoryIdentity(index.repositoryIdentity, currentIdentity)) return "repository identity changed before index promotion";
  return void 0;
}
function stableFileSnapshot(stats) {
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
function sameStableFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const entries = Object.keys(value);
  if (entries.length !== 3 || !entries.includes("generationFile") || !entries.includes("generationId") || !entries.includes("contentHash")) return void 0;
  const candidate = value;
  const match = typeof candidate.generationFile === "string" ? INDEX_GENERATION_PATTERN.exec(candidate.generationFile) : void 0;
  if (!match || basename3(candidate.generationFile) !== candidate.generationFile) return void 0;
  if (candidate.generationId !== match[1]) return void 0;
  if (typeof candidate.contentHash !== "string" || !SHA256_PATTERN.test(candidate.contentHash)) return void 0;
  return candidate;
}
async function readRegularFileNoFollow(path, maximumBytes) {
  await assertNoSymbolicLinkComponents(path);
  const before = await lstat7(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error(`Unsafe TokenGraph index file: ${path}`);
  if (before.size < 0n || before.size > BigInt(maximumBytes)) throw new Error("TokenGraph index file exceeds its bounded read limit.");
  const noFollow = "O_NOFOLLOW" in constants6 ? constants6.O_NOFOLLOW : 0;
  const handle = await open6(path, constants6.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat7(path, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n || !sameStableFile(stableFileSnapshot(before), stableFileSnapshot(after)) || !sameStableFile(stableFileSnapshot(before), stableFileSnapshot(pathAfter))) {
      throw Object.assign(new Error(`TokenGraph index file changed while it was being read: ${path}`), {
        code: "UNSTABLE_INDEX_READ"
      });
    }
    return content;
  } finally {
    await handle.close();
  }
}
async function readActiveIndexGenerationName(root) {
  try {
    const manifest = parseManifest(JSON.parse(await readRegularFileNoFollow(indexManifestPath(root), MAX_INDEX_MANIFEST_BYTES)));
    if (!manifest) throw new Error("The active TokenGraph index manifest is malformed.");
    return manifest.generationFile;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function isNormalizedRelativePath(path) {
  return path.length > 0 && !path.includes("\\") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function hasValidRetrievalSignals(index) {
  const signals = index.retrievalSignals;
  if (!signals || signals.source !== "git-commit-distance" && signals.source !== "unavailable") return false;
  if (!Number.isInteger(signals.historyDepth) || signals.historyDepth < 1 || signals.historyDepth > 50) return false;
  if (!signals.fileCommitDistance || typeof signals.fileCommitDistance !== "object" || Array.isArray(signals.fileCommitDistance)) return false;
  const entries = Object.entries(signals.fileCommitDistance);
  const indexedPaths = new Set(index.files?.map((file) => file.path) ?? []);
  if (signals.source === "unavailable" && entries.length > 0) return false;
  if (entries.some(
    ([path, distance]) => !isNormalizedRelativePath(path) || !indexedPaths.has(path) || !Number.isInteger(distance) || distance < 0 || distance >= signals.historyDepth
  )) return false;
  return entries.every(([path], index2) => index2 === 0 || entries[index2 - 1][0].localeCompare(path) < 0);
}
function isProjectIndex(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  if (typeof candidate.schemaVersion === "number" && candidate.schemaVersion > CURRENT_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported newer TokenGraph index schema version ${candidate.schemaVersion}; refusing to overwrite it.`);
  }
  return (candidate.schemaVersion === 4 || candidate.schemaVersion === CURRENT_INDEX_SCHEMA_VERSION) && typeof candidate.root === "string" && typeof candidate.scannedAt === "string" && typeof candidate.fingerprint === "string" && Array.isArray(candidate.files) && Array.isArray(candidate.symbols) && Array.isArray(candidate.imports) && Array.isArray(candidate.exclusions) && Array.isArray(candidate.frameworks) && Boolean(candidate.sql) && Array.isArray(candidate.sql?.tables) && Array.isArray(candidate.sql?.relations) && Array.isArray(candidate.sql?.policies) && Array.isArray(candidate.sql?.indexes) && Array.isArray(candidate.sql?.triggers) && Array.isArray(candidate.sql?.functions) && Array.isArray(candidate.sql?.views) && Array.isArray(candidate.sql?.constraints) && Array.isArray(candidate.sql?.enums) && Array.isArray(candidate.sql?.extensions) && Array.isArray(candidate.sql?.grants) && Array.isArray(candidate.sql?.materializedViews) && Array.isArray(candidate.sql?.history) && hasValidRetrievalSignals(candidate) && (candidate.schemaVersion === 4 || Boolean(
    candidate.generation && typeof candidate.scanSignature === "string" && SHA256_PATTERN.test(candidate.scanSignature) && typeof candidate.generation.sourceScanSignature === "string" && SHA256_PATTERN.test(candidate.generation.sourceScanSignature) && typeof candidate.generation.terminalExclusionsHash === "string" && SHA256_PATTERN.test(candidate.generation.terminalExclusionsHash) && candidate.scanMetadata?.files && Array.isArray(candidate.scanMetadata.exclusions)
  ));
}
var INDEX_GENERATION_PATTERN, INDEX_CANDIDATE_PATTERN, INDEX_MANIFEST_TEMP_PATTERN, SHA256_PATTERN, MAX_INDEX_MANIFEST_BYTES, MAX_INDEX_GENERATION_BYTES;
var init_persistence = __esm({
  "src/core/persistence.ts"() {
    "use strict";
    init_lockDomain();
    init_legacyRuntimeActivation();
    init_projectIndexer();
    init_storage();
    init_repositoryIdentity();
    INDEX_GENERATION_PATTERN = /^\.index-generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
    INDEX_CANDIDATE_PATTERN = /^\.index-generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.candidate\.json$/;
    INDEX_MANIFEST_TEMP_PATTERN = /^\.index-manifest-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
    SHA256_PATTERN = /^[a-f0-9]{64}$/;
    MAX_INDEX_MANIFEST_BYTES = 4 * 1024;
    MAX_INDEX_GENERATION_BYTES = 256 * 1024 * 1024;
  }
});

// src/core/storagePolicy.ts
import { chmod as chmod5, lstat as lstat8, mkdir as mkdir4, readFile as readFile5, readdir as readdir7 } from "node:fs/promises";
import { basename as basename4, dirname as dirname8, isAbsolute as isAbsolute7, join as join9, relative as relative9, resolve as resolve9 } from "node:path";
function domainRootSet(root) {
  const state = resolve9(stateDir(root));
  const repository = resolve9(repositoryStateDirectory(root));
  return /* @__PURE__ */ new Set([
    state,
    repository,
    resolve9(runsDir(root)),
    join9(state, "tasks"),
    resolve9(vaultDir(root)),
    resolve9(wikiDir(root)),
    join9(repository, "artifacts")
  ]);
}
function isDomainRootInfrastructure(path, domainRoots) {
  if (!domainRoots.has(resolve9(dirname8(path)))) return false;
  const name = basename4(path);
  return name === NATIVE_LOCK_ANCHOR_NAME || name === NATIVE_LOCK_JOURNAL_NAME || name === NATIVE_LOCK_JOURNAL_TEMP_NAME || name.toLowerCase().endsWith(".lock");
}
function isWriteTelemetryInfrastructure(path, telemetryArtifact) {
  return resolve9(path) === telemetryArtifact;
}
async function usage(path, domainRoots, telemetryArtifact, reader) {
  try {
    const info = reader ? await reader.inspect(path) : await lstat8(path);
    if (!info) return { bytes: 0, files: 0 };
    if (info.isSymbolicLink()) throw new Error(`TokenGraph storage accounting refuses symbolic-link paths: ${path}`);
    if (isWriteTelemetryInfrastructure(path, telemetryArtifact)) return { bytes: 0, files: 0 };
    if (isDomainRootInfrastructure(path, domainRoots)) return { bytes: 0, files: 0 };
    if (info.isFile()) {
      const bytes = Number(info.size);
      if (!Number.isSafeInteger(bytes)) throw new Error("TokenGraph storage usage exceeds the safe integer range.");
      return { bytes, files: 1 };
    }
    if (!info.isDirectory()) return { bytes: 0, files: 0 };
    const entries = reader ? (await reader.directory(path) ?? []).map((entry) => entry.name) : await readdir7(path);
    const children = await Promise.all(entries.map((entry) => usage(join9(path, entry), domainRoots, telemetryArtifact, reader)));
    return children.reduce((total, child) => ({ bytes: total.bytes + child.bytes, files: total.files + child.files }), { bytes: 0, files: 0 });
  } catch (error) {
    if (error.code === "ENOENT") return { bytes: 0, files: 0 };
    throw error;
  }
}
async function usageMany(paths, domainRoots, telemetryArtifact, reader) {
  const unique = paths.map((path) => resolve9(path)).filter((path, index, all) => all.indexOf(path) === index);
  const roots = unique.filter((path, index, all) => !all.some((candidate, candidateIndex) => {
    if (candidateIndex === index) return false;
    const nested = relative9(candidate, path);
    return nested === "" || !nested.startsWith("..") && !isAbsolute7(nested);
  }));
  const values = await Promise.all(roots.map((path) => usage(path, domainRoots, telemetryArtifact, reader)));
  return values.reduce((total, current) => ({ bytes: total.bytes + current.bytes, files: total.files + current.files }), { bytes: 0, files: 0 });
}
async function collectStorageClassUsage(root, reader) {
  const repository = repositoryStateDirectory(root);
  const domainRoots = domainRootSet(root);
  const telemetryArtifact = resolve9(writeTelemetryPath(root));
  const state = stateDir(root);
  const stateEntries = reader ? (await reader.directory(state) ?? []).map((entry) => entry.name) : await readdir7(state).catch(
    (error) => error.code === "ENOENT" ? [] : Promise.reject(error)
  );
  const generationArtifacts = stateEntries.filter(isIndexGenerationArtifactName).map((entry) => join9(state, entry));
  const [total, runs, cache, vault] = await Promise.all([
    usageMany([stateDir(root), repositoryStateDirectory(root)], domainRoots, telemetryArtifact, reader),
    usage(runsDir(root), domainRoots, telemetryArtifact, reader),
    usageMany([
      join9(state, "index.json"),
      indexManifestPath(root),
      ...generationArtifacts,
      wikiDir(root),
      join9(repository, "index.json"),
      join9(repository, "artifacts")
    ], domainRoots, telemetryArtifact, reader),
    usage(vaultDir(root), domainRoots, telemetryArtifact, reader)
  ]);
  return {
    total,
    runs,
    cache,
    vault,
    durable: {
      bytes: Math.max(0, total.bytes - runs.bytes - cache.bytes - vault.bytes),
      files: Math.max(0, total.files - runs.files - cache.files - vault.files)
    }
  };
}
async function storageClassUsage(root) {
  return collectStorageClassUsage(root);
}
async function storageClassUsageReadOnly(root) {
  return collectStorageClassUsage(root, new DiagnosticReader(root));
}
function assertClassQuotas(quotas) {
  for (const name of ["maxBytes", "runsMaxBytes", "cacheMaxBytes", "vaultMaxBytes", "durableMaxBytes"]) {
    const value = quotas[name];
    if (!Number.isInteger(value) || value < (name === "maxBytes" ? 1 : 0)) throw new Error(`Storage ${name} must be a non-negative integer${name === "maxBytes" ? " greater than zero" : ""}.`);
  }
}
function classQuota(quotas, storageClass) {
  return quotas[`${storageClass}MaxBytes`];
}
function quotaExceededError(storageClass, current, maximum) {
  if (storageClass === "runs") return new Error(`TokenGraph runs storage quota exceeded (${current}/${maximum} bytes); run \`tokengraph purge --class runs\` or raise storage.runsMaxBytes.`);
  if (storageClass === "vault") return new Error(`TokenGraph vault storage quota exceeded (${current}/${maximum} bytes); explicitly purge derived projections with \`tokengraph purge --class derived\` or raise storage.vaultMaxBytes.`);
  if (storageClass === "durable") return new Error(`TokenGraph durable storage quota exceeded (${current}/${maximum} bytes); refusing the write. Review durable state or raise storage.durableMaxBytes; reviewed decisions and preferences are never purged implicitly.`);
  return new Error(`TokenGraph cache item exceeds its storage quota (${current}/${maximum} bytes); raise storage.cacheMaxBytes.`);
}
async function outcomeTargets(root) {
  const directory = join9(resolve9(root), ".tokengraph", "tasks");
  const entries = await readdir7(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const targets = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile5(join9(directory, entry), "utf8"));
      if (parsed.status !== "completed" && parsed.status !== "quarantined") continue;
    } catch {
      continue;
    }
    targets.push({ target: { domain: "tasks", relativePath: entry }, label: `.tokengraph/tasks/${entry}` });
  }
  targets.push({ target: { domain: "tasks", relativePath: "completed-outcomes.json" }, label: ".tokengraph/tasks/completed-outcomes.json" });
  return targets;
}
function purgeDomains(storageClass) {
  const domains = [];
  if (storageClass === "runs" || storageClass === "derived") domains.push("runs");
  if (storageClass === "cache" || storageClass === "derived") domains.push("workspace-state", "wiki", "repository-state", "artifacts");
  if (storageClass === "outcomes" || storageClass === "derived") domains.push("tasks");
  if (storageClass === "derived") domains.push("vault");
  return domains;
}
async function purgeStorageClassUnlocked(root, storageClass, context) {
  const targets = [];
  if (storageClass === "runs" || storageClass === "derived") targets.push({ target: { domain: "runs" }, label: ".tokengraph/runs" });
  if (storageClass === "cache" || storageClass === "derived") {
    const [activeGeneration, stateEntries] = await Promise.all([
      readActiveIndexGenerationName(root),
      readdir7(stateDir(root)).catch(
        (error) => error.code === "ENOENT" ? [] : Promise.reject(error)
      )
    ]);
    targets.push(
      ...stateEntries.filter((entry) => isIndexGenerationArtifactName(entry) && entry !== activeGeneration).map((entry) => ({ target: { domain: "workspace-state", relativePath: entry }, label: `.tokengraph/${entry}` })),
      { target: { domain: "wiki" }, label: ".tokengraph/wiki" },
      { target: { domain: "artifacts" }, label: "repository/artifacts" }
    );
  }
  if (storageClass === "outcomes" || storageClass === "derived") targets.push(...await outcomeTargets(root));
  if (storageClass === "derived") targets.push({ target: { domain: "vault" }, label: ".tokengraph/vault" });
  const removedPaths = await context.remove(targets.map(({ target }) => target));
  const locks = new Map(context.locks.map((lock) => [lock.domain, lock]));
  const removed = targets.filter(({ target }) => {
    const lock = locks.get(target.domain);
    const path = target.relativePath ? join9(lock.domainRoot, ...target.relativePath.split("/")) : lock.domainRoot;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    return [...removedPaths].some((removedPath) => {
      const candidate = process.platform === "win32" ? removedPath.toLowerCase() : removedPath;
      return candidate === key || candidate.startsWith(`${key}${process.platform === "win32" ? "\\" : "/"}`);
    });
  }).map(({ label }) => label);
  return { class: storageClass, removed: [...new Set(removed)] };
}
async function purgeStorageClass(root, storageClass, confirmation) {
  return withDestructiveMaintenance(root, purgeDomains(storageClass), confirmation, (context) => purgeStorageClassUnlocked(root, storageClass, context));
}
async function purgeStorageClassAutomatically(root, storageClass) {
  return withAutomaticMaintenance(root, purgeDomains(storageClass), (context) => purgeStorageClassUnlocked(root, storageClass, context));
}
async function enforceStorageClassQuotas(root, quotas) {
  assertClassQuotas(quotas);
  let current = await storageClassUsage(root);
  const cleaned = [];
  if (current.cache.bytes > quotas.cacheMaxBytes || current.total.bytes > quotas.maxBytes) {
    if (current.cache.bytes > 0) {
      await purgeStorageClassAutomatically(root, "cache");
      cleaned.push("cache");
      current = await storageClassUsage(root);
    }
  }
  for (const storageClass of ["runs", "vault", "durable"]) {
    const maximum = classQuota(quotas, storageClass);
    if (current[storageClass].bytes > maximum) throw quotaExceededError(storageClass, current[storageClass].bytes, maximum);
  }
  if (current.cache.bytes > quotas.cacheMaxBytes) throw quotaExceededError("cache", current.cache.bytes, quotas.cacheMaxBytes);
  if (current.total.bytes > quotas.maxBytes) throw new Error(`TokenGraph total storage quota exceeded (${current.total.bytes}/${quotas.maxBytes} bytes) after cache cleanup; explicitly purge runs, outcomes, or derived state, or raise storage.maxBytes.`);
  return { usage: current, cleaned };
}
async function assertStorageWriteAllowed(root, storageClass, incomingBytes, quotas) {
  if (!Number.isInteger(incomingBytes) || incomingBytes < 0) throw new Error("Incoming storage bytes must be a non-negative integer.");
  let report = await enforceStorageClassQuotas(root, quotas);
  let projectedClassBytes = report.usage[storageClass].bytes + incomingBytes;
  if (storageClass === "cache" && projectedClassBytes > quotas.cacheMaxBytes && report.usage.cache.bytes > 0) {
    await purgeStorageClassAutomatically(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [.../* @__PURE__ */ new Set([...report.cleaned, "cache"])] };
    projectedClassBytes = report.usage.cache.bytes + incomingBytes;
  }
  const maximum = classQuota(quotas, storageClass);
  if (projectedClassBytes > maximum) throw quotaExceededError(storageClass, projectedClassBytes, maximum);
  let projectedTotal = report.usage.total.bytes + incomingBytes;
  if (projectedTotal > quotas.maxBytes && report.usage.cache.bytes > 0 && storageClass !== "cache") {
    await purgeStorageClassAutomatically(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [.../* @__PURE__ */ new Set([...report.cleaned, "cache"])] };
    projectedTotal = report.usage.total.bytes + incomingBytes;
  }
  if (projectedTotal > quotas.maxBytes) throw new Error(`TokenGraph total storage quota would be exceeded (${projectedTotal}/${quotas.maxBytes} bytes); explicitly purge storage or raise storage.maxBytes.`);
  return report;
}
function isInstructionLikeSourceLine(line) {
  return /^\s*(?:ignore previous|you must\b|system message|developer message|assistant message|instructions?:|(?:agent|model|assistant)\s*:|(?:call|invoke|use|run|execute)\s+(?:the\s+)?(?:tool|function|command)\b)/i.test(line);
}
function filterUntrustedSourceText(value) {
  return value.split(/\r?\n/).filter((line) => !isInstructionLikeSourceLine(line)).map((line) => SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), line)).join("\n");
}
var SECRET_PATTERNS;
var init_storagePolicy = __esm({
  "src/core/storagePolicy.ts"() {
    "use strict";
    init_repositoryIdentity();
    init_lockDomain();
    init_diagnosticRead();
    init_persistence();
    init_storage();
    SECRET_PATTERNS = [
      /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]+/gi,
      /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g
    ];
  }
});

// src/cli.ts
import { realpath as realpath4 } from "node:fs/promises";
import { dirname as dirname10, resolve as resolve13 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/core/runner.ts
init_lockDomain();
init_storage();
init_persistence();
import { createHash as createHash9, randomUUID as randomUUID5 } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile as readFile6, readdir as readdir8, rm as rm3 } from "node:fs/promises";
import { join as join10 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// src/core/memoryCore.ts
init_storagePolicy();
init_token();
import { createHash as createHash8 } from "node:crypto";
function createTaskOutcome(input) {
  const status = ["runner", "hook", "filesystem-diff"].includes(input.provenance) ? "verified" : "proposed";
  const summary = filterUntrustedSourceText(input.summary).trim();
  if (!summary) throw new Error("Task outcome summary is empty after safety filtering.");
  const content = {
    taskId: input.taskId.trim(),
    summary,
    status,
    evidence: [...new Set(input.evidence.map((entry) => entry.trim()).filter(Boolean))].sort(),
    createdAt: input.createdAt,
    ...input.staleAt ? { staleAt: input.staleAt } : {},
    ...input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {},
    branch: input.branch,
    worktreeId: input.worktreeId,
    headCommit: input.headCommit
  };
  const id = input.id?.trim() || createHash8("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 24);
  return { id, ...content };
}

// src/core/runner.ts
var ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
var INTERACTIVE_COMMANDS = /* @__PURE__ */ new Set(["ssh", "vim", "vi", "nano", "less", "more", "top", "htop", "pwsh", "powershell"]);
var SENSITIVE_ARGUMENT_NAMES = /* @__PURE__ */ new Set([
  "api-key",
  "apikey",
  "access-token",
  "auth-token",
  "authorization",
  "client-secret",
  "cookie",
  "password",
  "passwd",
  "refresh-token",
  "secret",
  "token"
]);
var SENSITIVE_ENVIRONMENT_NAME = /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|CLIENT_SECRET|DATABASE_URL|GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|PASSWORD|SLACK_TOKEN|TOKEN)$/i;
var SENSITIVE_HEADER_NAME = /^(?:authorization|cookie|proxy-authorization|set-cookie)$|(?:^|[-_])(?:api[-_]?key|credential|password|secret|token)(?:$|[-_])/i;
var CREDENTIAL_CONTEXT = /\b(?:api[ _-]?key|authorization|client[ _-]?secret|cookie|credential(?:s)?|password|private[ _-]?key)\b/i;
var RunnerSanitizer = class {
  constructor(prior) {
    this.prior = prior;
  }
  prior;
  categories = /* @__PURE__ */ new Set();
  withheldLineCount = 0;
  replace(value, pattern, replacement, category) {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return value;
    this.categories.add(category);
    pattern.lastIndex = 0;
    return value.replace(pattern, replacement);
  }
  sanitizeText(value) {
    let sanitized = value.replace(ANSI_PATTERN, "");
    sanitized = this.replace(
      sanitized,
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi,
      "[REDACTED PRIVATE KEY]",
      "private-key"
    );
    return sanitized.split(/(\r?\n)/).map((line) => {
      if (/^\r?\n$/.test(line) || !line) return line;
      let result = line;
      result = this.replace(result, /\b(authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, "$1: [REDACTED]", "authorization-header");
      result = this.replace(result, /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]", "cookie-header");
      result = this.replace(result, /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@", "url-credentials");
      result = this.replace(result, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED]", "jwt");
      result = this.replace(result, /\b(?:npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]", "service-token");
      result = this.replace(result, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]", "aws-access-key");
      result = this.replace(
        result,
        /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|refresh[ _-]?token|secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        (_match, name, separator) => `${name}${separator}[REDACTED]`,
        "credential-assignment"
      );
      const unresolvedContext = result.replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*\[REDACTED\]/gi, "").replace(/\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|refresh[ _-]?token|secret)\s*[:=]\s*\[REDACTED\]/gi, "").replace(/\b[a-z][a-z0-9+.-]*:\/\/\[REDACTED\]:\[REDACTED\]@/gi, "").replace(/\[(?:REDACTED(?: PRIVATE KEY)?|WITHHELD CREDENTIAL LINE)\]/g, "");
      if (CREDENTIAL_CONTEXT.test(unresolvedContext)) {
        this.categories.add("credential-line");
        this.withheldLineCount += 1;
        return "[WITHHELD CREDENTIAL LINE]";
      }
      return result;
    }).join("");
  }
  sanitizeArguments(args) {
    const sanitized = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      const normalizedName = argument.replace(/^--?/, "").toLowerCase().replaceAll("_", "-");
      if (SENSITIVE_ARGUMENT_NAMES.has(normalizedName) || SENSITIVE_ENVIRONMENT_NAME.test(argument)) {
        sanitized.push(argument);
        if (index + 1 < args.length) {
          sanitized.push("[REDACTED]");
          this.categories.add("sensitive-argument");
          index += 1;
        }
        continue;
      }
      if (argument === "--header" || argument === "-H") {
        sanitized.push(argument);
        if (index + 1 < args.length) {
          sanitized.push(this.sanitizeHeader(args[index + 1]));
          index += 1;
        }
        continue;
      }
      const inlineHeader = argument.match(/^(--header|-H)=([\s\S]*)$/i);
      if (inlineHeader) {
        sanitized.push(`${inlineHeader[1]}=${this.sanitizeHeader(inlineHeader[2])}`);
        continue;
      }
      const inlineSwitch = argument.match(/^(--?)([^=]+)=(.*)$/s);
      if (inlineSwitch && SENSITIVE_ARGUMENT_NAMES.has(inlineSwitch[2].toLowerCase().replaceAll("_", "-"))) {
        sanitized.push(`${inlineSwitch[1]}${inlineSwitch[2]}=[REDACTED]`);
        this.categories.add("sensitive-argument");
        continue;
      }
      const environmentAssignment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (environmentAssignment && SENSITIVE_ENVIRONMENT_NAME.test(environmentAssignment[1])) {
        sanitized.push(`${environmentAssignment[1]}=[REDACTED]`);
        this.categories.add("sensitive-argument");
        continue;
      }
      sanitized.push(this.sanitizeText(argument));
    }
    return sanitized;
  }
  sanitizeHeader(value) {
    const header = value.match(/^\s*([^:]+)\s*:\s*([\s\S]*)$/);
    if (header && SENSITIVE_HEADER_NAME.test(header[1].trim())) {
      this.categories.add(/cookie/i.test(header[1]) ? "cookie-header" : "authorization-header");
      return `${header[1]}: [REDACTED]`;
    }
    return this.sanitizeText(value);
  }
  metadata() {
    const categories = [.../* @__PURE__ */ new Set([...this.prior?.categories ?? [], ...this.categories])].sort();
    const withheldLineCount = (this.prior?.withheldLineCount ?? 0) + this.withheldLineCount;
    return categories.length || withheldLineCount ? { categories, withheldLineCount } : void 0;
  }
};
function compactRepeatedLines(value) {
  const lines = value.split("\n");
  const output = [];
  for (let index = 0; index < lines.length; ) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    output.push(lines[index]);
    if (count > 3) output.push(`[repeated line x${count}]`);
    index = end;
  }
  return output.join("\n");
}
var StreamCapture = class {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
  }
  maxBytes;
  chunks = [];
  hash = createHash9("sha256");
  capturedBytes = 0;
  observedBytes = 0;
  truncated = false;
  binary = false;
  append(chunk) {
    this.hash.update(chunk);
    this.observedBytes += chunk.length;
    if (chunk.includes(0)) this.binary = true;
    if (this.capturedBytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.capturedBytes;
    const selected = chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(selected));
    this.capturedBytes += selected.length;
    if (selected.length < chunk.length) this.truncated = true;
  }
  get hasBinary() {
    return this.binary;
  }
  finish(sanitizer) {
    const sha2563 = this.hash.digest("hex");
    if (this.binary) {
      return { text: "", truncated: this.truncated, bytes: this.observedBytes, sha256: sha2563, binary: true };
    }
    const raw = sanitizer.sanitizeText(compactRepeatedLines(Buffer.concat(this.chunks).toString("utf8")));
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes <= this.maxBytes && !this.truncated) {
      return { text: raw, truncated: false, bytes: this.observedBytes, sha256: sha2563, binary: false };
    }
    const buffer = Buffer.from(raw, "utf8");
    return {
      text: `${buffer.subarray(0, Math.max(0, this.maxBytes - 32)).toString("utf8")}
[truncated]`,
      truncated: true,
      bytes: this.observedBytes,
      sha256: sha2563,
      binary: false
    };
  }
};
function validateCommand(command, interactive) {
  if (!command.trim()) throw new Error("Runner command is required.");
  if (!interactive && INTERACTIVE_COMMANDS.has(command.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, ""))) {
    throw new Error("Interactive commands are refused unless interactive mode is explicitly enabled.");
  }
}
function taskOutcomeFromRun(run, taskId, identity2) {
  const sanitizer = new RunnerSanitizer(run.redaction);
  const command = sanitizer.sanitizeArguments([run.command, ...run.args]).join(" ");
  return createTaskOutcome({
    id: `run-${run.runId}`,
    taskId,
    summary: `${command} -> ${run.status} (exit ${run.exitCode ?? "null"})`,
    evidence: [`run:${run.runId}`, `exit-code:${run.exitCode ?? "null"}`, `runner-status:${run.status}`],
    createdAt: run.finishedAt,
    branch: identity2.branch,
    worktreeId: identity2.worktreeId,
    headCommit: identity2.headCommit,
    provenance: "runner"
  });
}
function inferRunMetadata(stdout, stderr) {
  const combined = `${stderr}
${stdout}`;
  const errorClass = combined.match(/\b([A-Z][A-Za-z0-9_$]*(?:Error|Exception))\b/)?.[1];
  const file = combined.match(/((?:[A-Za-z]:[\\/])?(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+):\d+(?::\d+)?/)?.[1]?.replaceAll("\\", "/");
  const test = combined.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(?:FAIL|FAILED)\s+\S/i.test(line))?.replace(/^(?:FAIL|FAILED)\s+/i, "");
  const metadata = { ...test ? { test } : {}, ...file ? { file } : {}, ...errorClass ? { errorClass } : {} };
  return Object.keys(metadata).length ? metadata : void 0;
}
function sanitizeRunMetadata(metadata, sanitizer) {
  if (!metadata) return void 0;
  const sanitized = {
    ...metadata.test ? { test: sanitizer.sanitizeText(metadata.test) } : {},
    ...metadata.file ? { file: sanitizer.sanitizeText(metadata.file) } : {},
    ...metadata.errorClass ? { errorClass: sanitizer.sanitizeText(metadata.errorClass) } : {}
  };
  return Object.keys(sanitized).length ? sanitized : void 0;
}
function signalPosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function taskkillProcessTree(pid) {
  await new Promise((resolve14, reject) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.once("error", (error) => reject(new Error(`taskkill failed to spawn: ${error.message}`)));
    killer.once("close", (code, signal) => {
      if (code === 0) resolve14();
      else reject(new Error(`taskkill failed with exit code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`));
    });
  });
}
async function executeRun(options, signal) {
  const interactive = options.interactive === true;
  validateCommand(options.command, interactive);
  if (interactive) throw new Error("Interactive runner mode is not supported by the bounded capture interface.");
  const maxBytes = Math.max(256, Math.min(options.maxBytes ?? 64 * 1024, 1024 * 1024));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12e4, 15 * 6e4));
  const terminateGraceMs = Math.max(100, Math.min(options.terminateGraceMs ?? 2e3, 15e3));
  const startedAt = /* @__PURE__ */ new Date();
  const sanitizer = new RunnerSanitizer();
  const stdout = new StreamCapture(maxBytes);
  const stderr = new StreamCapture(maxBytes);
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.root,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let binaryOutput = false;
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  let timedOut = false;
  let cancelled = false;
  let terminationPromise;
  const terminate = () => {
    if (terminationPromise) return terminationPromise;
    const pid = child.pid;
    if (!pid) return Promise.resolve();
    terminationPromise = (async () => {
      if (process.platform !== "win32") signalPosixProcessGroup(pid, "SIGTERM");
      await delay(terminateGraceMs);
      if (process.platform === "win32") await taskkillProcessTree(pid);
      else signalPosixProcessGroup(pid, "SIGKILL");
    })();
    return terminationPromise;
  };
  let rejectResult;
  const resultPromise = new Promise((resolve14, reject) => {
    rejectResult = reject;
    child.once("error", reject);
    child.once("close", (code, childSignal) => resolve14({ code, signal: childSignal }));
  });
  const requestTermination = () => {
    void terminate().catch((error) => {
      if (process.platform === "win32") {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
      rejectResult(error);
    });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, timeoutMs);
  const abort = () => {
    cancelled = true;
    requestTermination();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const result = await resultPromise.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
  if (terminationPromise) await terminationPromise;
  const stdoutCapture = stdout.finish(sanitizer);
  const stderrCapture = stderr.finish(sanitizer);
  binaryOutput = stdoutCapture.binary || stderrCapture.binary;
  const inferredMetadata = inferRunMetadata(stdoutCapture.text, stderrCapture.text);
  const metadata = sanitizeRunMetadata(
    inferredMetadata || options.metadata ? { ...inferredMetadata ?? {}, ...options.metadata ?? {} } : void 0,
    sanitizer
  );
  return {
    runId: randomUUID5(),
    root: options.root,
    command: sanitizer.sanitizeText(options.command),
    args: sanitizer.sanitizeArguments(options.args ?? []),
    startedAt: startedAt.toISOString(),
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: cancelled ? "cancelled" : timedOut ? "timed-out" : binaryOutput ? "failed" : result.code === 0 ? "completed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    stdout: stdoutCapture.text,
    stderr: stderrCapture.text,
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    stdoutBytes: stdoutCapture.bytes,
    stderrBytes: stderrCapture.bytes,
    stdoutSha256: stdoutCapture.sha256,
    stderrSha256: stderrCapture.sha256,
    stdoutBinary: stdoutCapture.binary,
    stderrBinary: stderrCapture.binary,
    ...binaryOutput ? { binaryOutput: true } : {},
    ...sanitizer.metadata() ? { redaction: sanitizer.metadata() } : {},
    ...metadata ? { metadata } : {}
  };
}
function sanitizeSavedRun(run) {
  const sanitizer = new RunnerSanitizer(run.redaction);
  const metadata = sanitizeRunMetadata(run.metadata, sanitizer);
  const sanitized = {
    ...run,
    command: sanitizer.sanitizeText(run.command),
    args: sanitizer.sanitizeArguments(run.args),
    stdout: sanitizer.sanitizeText(run.stdout),
    stderr: sanitizer.sanitizeText(run.stderr),
    ...metadata && Object.keys(metadata).length ? { metadata } : {}
  };
  const redaction = sanitizer.metadata();
  if (redaction) sanitized.redaction = redaction;
  return sanitized;
}
async function saveRun(root, run) {
  const lock = await canonicalPersistenceLock(root, "runs", `${run.runId}.json`);
  await withFileLock(lock, () => writeJsonAtomic(runPath(root, run.runId), sanitizeSavedRun(run), { telemetry: { root, storageClass: "runs" } }));
}
async function loadRun(root, runId, repairInsideLock = false) {
  try {
    const parsed = JSON.parse(await readFile6(runPath(root, runId), "utf8"));
    return parsed && parsed.runId === runId && parsed.root === root ? sanitizeSavedRun(parsed) : void 0;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    if (error instanceof SyntaxError) {
      if (repairInsideLock) await quarantineCorruptJson(runPath(root, runId));
      return void 0;
    }
    throw error;
  }
}
function summarizeRun(run) {
  const sanitizer = new RunnerSanitizer(run.redaction);
  const combined = sanitizer.sanitizeText(`${run.stderr}
${run.stdout}`);
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstError = lines.find((line) => /\b(error|failed|failure|exception)\b/i.test(line));
  const tests = lines.filter((line) => /(?:test|spec)\b|\b(pass|fail)ed\b/i.test(line)).slice(0, 20);
  const stackFrames = lines.filter((line) => /^\s*at\s+|\bat\s+.+:\d+:\d+/.test(line)).slice(0, 20);
  const locations = lines.map((line) => line.match(/[^\s:()]+:\d+(?::\d+)?/)?.[0]).filter((value) => Boolean(value)).slice(0, 20);
  const repeatCount = lines.length - new Set(lines).size;
  return {
    runId: run.runId,
    status: run.status,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    ...firstError ? { firstError } : {},
    repeatCount,
    tests,
    stackFrames,
    locations,
    ...sanitizer.metadata() ? { redaction: sanitizer.metadata() } : {}
  };
}
async function purgeRuns(root, before) {
  const lock = await canonicalPersistenceLock(root, "runs", "maintenance");
  return withFileLock(lock, () => purgeRunsUnlocked(root, before));
}
async function purgeRunsUnlocked(root, before) {
  const entries = await readdir8(runsDir(root)).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const removed = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const runId = entry.slice(0, -5);
    const run = await loadRun(root, runId, true);
    if (run && (!before || new Date(run.finishedAt) < before)) {
      await rm3(join10(runsDir(root), entry), { force: true });
      removed.push(runId);
    }
  }
  return removed;
}

// src/core/config.ts
init_persistence();
init_lockDomain();
init_legacyRuntimeActivation();
init_storage();
import { readFile as readFile7 } from "node:fs/promises";
var CURRENT_CONFIG_SCHEMA_VERSION = 4;
var PROFILE_DEFAULTS = {
  conservative: {
    maxFiles: 10,
    maxSqlObjects: 10,
    maxMemories: 6,
    firstReads: 5,
    maxPlannedContextTokens: 12e3,
    rawReadWarningThreshold: 12e3
  },
  balanced: {
    maxFiles: 6,
    maxSqlObjects: 6,
    maxMemories: 4,
    firstReads: 3,
    maxPlannedContextTokens: 8e3,
    rawReadWarningThreshold: 8e3
  },
  aggressive: {
    maxFiles: 3,
    maxSqlObjects: 3,
    maxMemories: 2,
    firstReads: 2,
    maxPlannedContextTokens: 4e3,
    rawReadWarningThreshold: 4e3
  }
};
var DEFAULT_TOKEN_GRAPH_CONFIG = {
  tokenSavingProfile: "balanced",
  routingMode: "shadow",
  maxFiles: PROFILE_DEFAULTS.balanced.maxFiles,
  maxSqlObjects: PROFILE_DEFAULTS.balanced.maxSqlObjects,
  maxMemories: PROFILE_DEFAULTS.balanced.maxMemories,
  maxPlannedContextTokens: PROFILE_DEFAULTS.balanced.maxPlannedContextTokens,
  rawReadWarningThreshold: PROFILE_DEFAULTS.balanced.rawReadWarningThreshold,
  sqlIndexingEnabled: true,
  memoryEnabled: true,
  wikiGenerationEnabled: false,
  routingKillSwitch: false,
  routing: { mode: "shadow", killSwitch: false },
  parser: {
    polyglotEnabled: true,
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    maxSymbols: 1e4,
    maxNodes: 25e4,
    perFileTimeoutMs: 2e3,
    wholeIndexTimeoutMs: 6e4,
    maxRecursionDepth: 64,
    maxGraphDepth: 3,
    maxGeneratedFiles: 200,
    maxTsconfigChain: 8,
    maxAliases: 500
  },
  storage: {
    writePolicy: "balanced",
    maxBytes: 64 * 1024 * 1024,
    runsMaxBytes: 16 * 1024 * 1024,
    cacheMaxBytes: 32 * 1024 * 1024,
    vaultMaxBytes: 8 * 1024 * 1024,
    durableMaxBytes: 8 * 1024 * 1024,
    runRetentionDays: 14,
    cacheRetentionDays: 7
  },
  runner: { maxBytes: 64 * 1024, timeoutMs: 12e4, terminateGraceMs: 2e3 },
  memory: { projectBriefTargetTokens: 220, projectBriefMaxTokens: 600, maxRetrievalTokens: 1200 },
  responseFormat: { default: "json" }
};
function isProfile(value) {
  return value === "conservative" || value === "balanced" || value === "aggressive";
}
function isRoutingMode(value) {
  return value === "shadow" || value === "enforced" || value === "always-activate" || value === "always-advisory";
}
function isStorageWritePolicy(value) {
  return value === "minimal" || value === "balanced" || value === "durable";
}
function sanitizeNumber(value, fallback, min = 0) {
  return Number.isInteger(value) && value >= min ? value : fallback;
}
function legacyStorageClassCaps(maxBytes) {
  const runsMaxBytes = Math.floor(maxBytes * 0.25);
  const cacheMaxBytes = Math.floor(maxBytes * 0.5);
  const vaultMaxBytes = Math.floor(maxBytes * 0.125);
  return { runsMaxBytes, cacheMaxBytes, vaultMaxBytes, durableMaxBytes: maxBytes - runsMaxBytes - cacheMaxBytes - vaultMaxBytes };
}
function normalizeConfig(value, applyEnvironment = true) {
  const candidate = value && typeof value === "object" ? value : {};
  const nestedRouting = candidate.routing && typeof candidate.routing === "object" ? candidate.routing : {};
  const nestedParser = candidate.parser && typeof candidate.parser === "object" ? candidate.parser : {};
  const nestedStorage = candidate.storage && typeof candidate.storage === "object" ? candidate.storage : {};
  const nestedRunner = candidate.runner && typeof candidate.runner === "object" ? candidate.runner : {};
  const nestedMemory = candidate.memory && typeof candidate.memory === "object" ? candidate.memory : {};
  const nestedResponse = candidate.responseFormat && typeof candidate.responseFormat === "object" ? candidate.responseFormat : {};
  const storageMaxBytes = sanitizeNumber(nestedStorage.maxBytes, DEFAULT_TOKEN_GRAPH_CONFIG.storage.maxBytes, 1);
  const legacyStorageCaps = legacyStorageClassCaps(storageMaxBytes);
  const routingMode = applyEnvironment && isRoutingMode(process.env.TOKENGRAPH_ROUTING_MODE) ? process.env.TOKENGRAPH_ROUTING_MODE : isRoutingMode(candidate.routingMode) ? candidate.routingMode : isRoutingMode(nestedRouting.mode) ? nestedRouting.mode : DEFAULT_TOKEN_GRAPH_CONFIG.routingMode;
  const routingKillSwitch = typeof candidate.routingKillSwitch === "boolean" ? candidate.routingKillSwitch : typeof nestedRouting.killSwitch === "boolean" ? Boolean(nestedRouting.killSwitch) : DEFAULT_TOKEN_GRAPH_CONFIG.routingKillSwitch;
  const integer = (object, key, fallback, min = 0) => sanitizeNumber(object[key], fallback, min);
  return {
    tokenSavingProfile: isProfile(candidate.tokenSavingProfile) ? candidate.tokenSavingProfile : DEFAULT_TOKEN_GRAPH_CONFIG.tokenSavingProfile,
    routingMode,
    maxFiles: sanitizeNumber(candidate.maxFiles, DEFAULT_TOKEN_GRAPH_CONFIG.maxFiles, 1),
    maxSqlObjects: sanitizeNumber(candidate.maxSqlObjects, DEFAULT_TOKEN_GRAPH_CONFIG.maxSqlObjects),
    maxMemories: sanitizeNumber(candidate.maxMemories, DEFAULT_TOKEN_GRAPH_CONFIG.maxMemories),
    maxPlannedContextTokens: sanitizeNumber(candidate.maxPlannedContextTokens, DEFAULT_TOKEN_GRAPH_CONFIG.maxPlannedContextTokens, 1),
    rawReadWarningThreshold: sanitizeNumber(candidate.rawReadWarningThreshold, DEFAULT_TOKEN_GRAPH_CONFIG.rawReadWarningThreshold, 1),
    sqlIndexingEnabled: typeof candidate.sqlIndexingEnabled === "boolean" ? candidate.sqlIndexingEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.sqlIndexingEnabled,
    memoryEnabled: typeof candidate.memoryEnabled === "boolean" ? candidate.memoryEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.memoryEnabled,
    wikiGenerationEnabled: typeof candidate.wikiGenerationEnabled === "boolean" ? candidate.wikiGenerationEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.wikiGenerationEnabled,
    routingKillSwitch,
    routing: { mode: routingMode, killSwitch: routingKillSwitch },
    parser: {
      polyglotEnabled: typeof nestedParser.polyglotEnabled === "boolean" ? Boolean(nestedParser.polyglotEnabled) : DEFAULT_TOKEN_GRAPH_CONFIG.parser.polyglotEnabled,
      maxFileBytes: integer(nestedParser, "maxFileBytes", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxFileBytes, 1),
      maxTotalBytes: integer(nestedParser, "maxTotalBytes", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxTotalBytes, 1),
      maxSymbols: integer(nestedParser, "maxSymbols", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxSymbols, 1),
      maxNodes: integer(nestedParser, "maxNodes", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxNodes, 1),
      perFileTimeoutMs: integer(nestedParser, "perFileTimeoutMs", DEFAULT_TOKEN_GRAPH_CONFIG.parser.perFileTimeoutMs, 1),
      wholeIndexTimeoutMs: integer(nestedParser, "wholeIndexTimeoutMs", DEFAULT_TOKEN_GRAPH_CONFIG.parser.wholeIndexTimeoutMs, 1),
      maxRecursionDepth: integer(nestedParser, "maxRecursionDepth", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxRecursionDepth, 1),
      maxGraphDepth: integer(nestedParser, "maxGraphDepth", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxGraphDepth, 0),
      maxGeneratedFiles: integer(nestedParser, "maxGeneratedFiles", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxGeneratedFiles, 0),
      maxTsconfigChain: integer(nestedParser, "maxTsconfigChain", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxTsconfigChain, 1),
      maxAliases: integer(nestedParser, "maxAliases", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxAliases, 0)
    },
    storage: {
      writePolicy: isStorageWritePolicy(nestedStorage.writePolicy) ? nestedStorage.writePolicy : DEFAULT_TOKEN_GRAPH_CONFIG.storage.writePolicy,
      maxBytes: storageMaxBytes,
      runsMaxBytes: integer(nestedStorage, "runsMaxBytes", legacyStorageCaps.runsMaxBytes, 0),
      cacheMaxBytes: integer(nestedStorage, "cacheMaxBytes", legacyStorageCaps.cacheMaxBytes, 0),
      vaultMaxBytes: integer(nestedStorage, "vaultMaxBytes", legacyStorageCaps.vaultMaxBytes, 0),
      durableMaxBytes: integer(nestedStorage, "durableMaxBytes", legacyStorageCaps.durableMaxBytes, 0),
      runRetentionDays: integer(nestedStorage, "runRetentionDays", DEFAULT_TOKEN_GRAPH_CONFIG.storage.runRetentionDays, 0),
      cacheRetentionDays: integer(nestedStorage, "cacheRetentionDays", DEFAULT_TOKEN_GRAPH_CONFIG.storage.cacheRetentionDays, 0)
    },
    runner: {
      maxBytes: integer(nestedRunner, "maxBytes", DEFAULT_TOKEN_GRAPH_CONFIG.runner.maxBytes, 256),
      timeoutMs: integer(nestedRunner, "timeoutMs", DEFAULT_TOKEN_GRAPH_CONFIG.runner.timeoutMs, 1),
      terminateGraceMs: integer(nestedRunner, "terminateGraceMs", DEFAULT_TOKEN_GRAPH_CONFIG.runner.terminateGraceMs, 1)
    },
    memory: {
      projectBriefTargetTokens: integer(nestedMemory, "projectBriefTargetTokens", DEFAULT_TOKEN_GRAPH_CONFIG.memory.projectBriefTargetTokens, 150),
      projectBriefMaxTokens: integer(nestedMemory, "projectBriefMaxTokens", DEFAULT_TOKEN_GRAPH_CONFIG.memory.projectBriefMaxTokens, 1),
      maxRetrievalTokens: integer(nestedMemory, "maxRetrievalTokens", DEFAULT_TOKEN_GRAPH_CONFIG.memory.maxRetrievalTokens, 1)
    },
    responseFormat: { default: nestedResponse.default === "compact-tabular" ? "compact-tabular" : "json" }
  };
}
function unwrapPersistedConfig(value) {
  if (value && typeof value === "object" && "schemaVersion" in value && "config" in value) {
    const schemaVersion = value.schemaVersion;
    if (typeof schemaVersion === "number" && schemaVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
      throw new Error(`Unsupported newer TokenGraph config schema version ${schemaVersion}; refusing to overwrite it.`);
    }
    return {
      config: value.config,
      needsMigration: schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION
    };
  }
  return { config: value, needsMigration: true };
}
function inspectTokenGraphConfig(value) {
  const unwrapped = unwrapPersistedConfig(value);
  const persisted = normalizeConfig(unwrapped.config, false);
  return {
    config: normalizeConfig(persisted),
    valid: !unwrapped.needsMigration && JSON.stringify(unwrapped.config) === JSON.stringify(persisted)
  };
}
async function readConfigSnapshot(root) {
  let rawBytes;
  try {
    rawBytes = await readFile7(configPath(root), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { state: "missing", config: normalizeConfig(DEFAULT_TOKEN_GRAPH_CONFIG) };
    }
    throw error;
  }
  try {
    const unwrapped = unwrapPersistedConfig(JSON.parse(rawBytes));
    const persisted = normalizeConfig(unwrapped.config, false);
    return {
      state: "valid",
      config: normalizeConfig(persisted),
      persisted,
      rawBytes,
      needsRepair: unwrapped.needsMigration || JSON.stringify(unwrapped.config) !== JSON.stringify(persisted)
    };
  } catch (error) {
    if (error instanceof SyntaxError) return { state: "corrupt", config: normalizeConfig(DEFAULT_TOKEN_GRAPH_CONFIG) };
    throw error;
  }
}
async function persistConfigLocked(root, persisted) {
  await writeJsonAtomic(configPath(root), {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    config: persisted
  }, { telemetry: { root, storageClass: "durable" } });
}
async function repairConfigSnapshotLocked(root, snapshot) {
  if (snapshot.state === "missing") {
    const reread = await readConfigSnapshot(root);
    if (reread.state !== "missing") return repairConfigSnapshotLocked(root, reread);
    const persisted = normalizeConfig(DEFAULT_TOKEN_GRAPH_CONFIG, false);
    await persistConfigLocked(root, persisted);
    return normalizeConfig(persisted);
  }
  if (snapshot.state === "corrupt") {
    const reread = await readConfigSnapshot(root);
    if (reread.state !== "corrupt") return repairConfigSnapshotLocked(root, reread);
    await quarantineCorruptJson(configPath(root));
    const persisted = normalizeConfig(DEFAULT_TOKEN_GRAPH_CONFIG, false);
    await persistConfigLocked(root, persisted);
    return normalizeConfig(persisted);
  }
  if (snapshot.needsRepair) {
    await writeTextAtomic(`${configPath(root)}.bak`, snapshot.rawBytes, { telemetry: { root, storageClass: "durable" } });
    await persistConfigLocked(root, snapshot.persisted);
  }
  return snapshot.config;
}
async function loadTokenGraphConfig(root) {
  const initial = await readConfigSnapshot(root);
  if (!getLegacyRuntimeActivationStatus().activated) return initial.config;
  if (initial.state === "valid" && !initial.needsRepair) return initial.config;
  const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");
  return withFileLock(lock, async () => repairConfigSnapshotLocked(root, await readConfigSnapshot(root)));
}

// src/core/doctor.ts
import { createHash as createHash10 } from "node:crypto";
import { isAbsolute as isAbsolute9, join as join12, relative as relative10, resolve as resolve11 } from "node:path";
init_diagnosticRead();
init_fileScanner();
init_fileLockLease();
init_legacyRuntimeActivation();
init_lockDomain();
init_polyglot();
init_persistence();
init_projectIndexer();
init_repositoryIdentity();
init_storage();
init_storagePolicy();

// src/core/taskLedger.ts
import { lstat as lstat9, open as open7, readFile as readFile8, readdir as readdir9, rename as rename4, rm as rm4 } from "node:fs/promises";
import { isAbsolute as isAbsolute8, join as join11, parse as parse4, resolve as resolve10 } from "node:path";

// src/core/taskEstimator.ts
var TASK_ESTIMATOR_VERSION = "task-estimator-v2";
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isConfidence(value) {
  return value === "low" || value === "medium" || value === "high";
}
function isQualityStatus(value) {
  return value === "passed" || value === "warning" || value === "not_evaluated";
}
function reconstructCategory(value) {
  if (!isRecord(value) || !isRecord(value.range) || !Array.isArray(value.basis)) return void 0;
  if (typeof value.category !== "string" || value.category.length === 0 || !Number.isInteger(value.eventCount) || value.eventCount < 1 || !isFiniteNumber(value.range.low) || !isFiniteNumber(value.range.likely) || !isFiniteNumber(value.range.high) || value.range.low > value.range.likely || value.range.likely > value.range.high || value.range.unit !== "estimated_tokens" || !isConfidence(value.confidence) || !value.basis.every((item) => typeof item === "string") || !isFiniteNumber(value.overhead) || value.overhead < 0) return void 0;
  return {
    category: value.category,
    eventCount: value.eventCount,
    range: {
      low: value.range.low,
      likely: value.range.likely,
      high: value.range.high,
      unit: "estimated_tokens"
    },
    confidence: value.confidence,
    basis: [...value.basis],
    overhead: value.overhead
  };
}
function reconstructTaskReport(value, expectedTaskId, expectedEventCount) {
  if (!isRecord(value) || !isRecord(value.estimate) || !isRecord(value.estimate.range) || !isRecord(value.quality) || !Array.isArray(value.categories)) {
    return void 0;
  }
  const range = value.estimate.range;
  const basis = value.estimate.basis;
  const checks = value.quality.checks;
  const categories = value.categories.map(reconstructCategory);
  if (value.taskId !== expectedTaskId || value.eventCount !== expectedEventCount || !Number.isInteger(value.eventCount) || !isFiniteNumber(range.low) || !isFiniteNumber(range.likely) || !isFiniteNumber(range.high) || range.low > range.likely || range.likely > range.high || range.unit !== "estimated_tokens" || !isConfidence(value.estimate.confidence) || !Array.isArray(basis) || !basis.every((item) => typeof item === "string") || !isFiniteNumber(value.estimate.overhead) || value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION || !isQualityStatus(value.quality.status) || !Array.isArray(checks) || !checks.every((item) => typeof item === "string") || categories.some((entry) => entry === void 0)) {
    return void 0;
  }
  const reconstructedCategories = categories;
  if (reconstructedCategories.reduce((count, entry) => count + entry.eventCount, 0) !== expectedEventCount || reconstructedCategories.some((entry, index) => index > 0 && reconstructedCategories[index - 1].category.localeCompare(entry.category) >= 0)) return void 0;
  return {
    taskId: value.taskId,
    eventCount: value.eventCount,
    estimate: {
      range: { low: range.low, likely: range.likely, high: range.high, unit: "estimated_tokens" },
      confidence: value.estimate.confidence,
      basis: [...basis],
      overhead: value.estimate.overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    categories: reconstructedCategories,
    quality: { status: value.quality.status, checks: [...checks] }
  };
}
var confidenceRank = { low: 0, medium: 1, high: 2 };
function finite(value) {
  return Number.isFinite(value) ? value : 0;
}
function estimateEvents(events, calibration, reportOverheadTokens = 0) {
  let low = 0;
  let likely = 0;
  let high = 0;
  let overhead = 0;
  let confidence = events.length > 0 ? "high" : "low";
  const basis = /* @__PURE__ */ new Set();
  for (const event of events) {
    const original = Math.max(0, finite(event.originalTokens));
    const compact = Math.max(0, finite(event.compactTokens));
    const eventOverhead = Math.max(0, finite(event.overheadTokens));
    const net = original - compact - eventOverhead;
    const gross = original - compact;
    const categoryCalibration = calibration[event.category];
    const isCalibrated = Boolean(categoryCalibration && categoryCalibration.observations >= 10);
    likely += net;
    overhead += eventOverhead;
    if (isCalibrated && categoryCalibration) {
      low += net + finite(categoryCalibration.lowResidual);
      high += Math.max(net, gross, net + finite(categoryCalibration.highResidual));
      basis.add(`${event.category}:calibrated:${categoryCalibration.observations}`);
      if (confidenceRank[event.confidence] < confidenceRank[confidence]) confidence = event.confidence;
    } else {
      if (net < 0) low += net;
      high += Math.max(0, gross);
      confidence = "low";
      basis.add(`${event.category}:uncalibrated`);
    }
  }
  const reportOverhead = Math.max(0, finite(reportOverheadTokens));
  const hasNegativeEvent = events.some((event) => event.originalTokens - event.compactTokens - event.overheadTokens < 0);
  if (!hasNegativeEvent) low = Math.max(0, low);
  low = Math.min(low, likely);
  high = Math.max(likely, high);
  low -= reportOverhead;
  likely -= reportOverhead;
  high = Math.max(likely, high - reportOverhead);
  if (!hasNegativeEvent) low = Math.max(0, low);
  low = Math.min(low, likely);
  overhead += reportOverhead;
  return {
    range: { low, likely, high, unit: "estimated_tokens" },
    confidence,
    basis: [...basis].sort(),
    overhead
  };
}
function buildTaskReport(ledger, calibration = {}, reportOverheadTokens = 0) {
  const checks = [];
  let hasFailedCheck = false;
  for (const event of ledger.events) {
    for (const check of event.qualityChecks) {
      checks.push(`${check.name}:${check.passed ? "passed" : "failed"}`);
      if (!check.passed) {
        hasFailedCheck = true;
      }
    }
  }
  const aggregate = estimateEvents(ledger.events, calibration, reportOverheadTokens);
  const categories = [...new Set(ledger.events.map((event) => event.category))].sort((a, b) => a.localeCompare(b)).map((category) => {
    const events = ledger.events.filter((event) => event.category === category);
    return { category, eventCount: events.length, ...estimateEvents(events, calibration) };
  });
  return {
    taskId: ledger.taskId,
    eventCount: ledger.events.length,
    estimate: {
      range: aggregate.range,
      confidence: aggregate.confidence,
      basis: aggregate.basis,
      overhead: aggregate.overhead,
      estimatorVersion: TASK_ESTIMATOR_VERSION
    },
    categories,
    quality: {
      status: hasFailedCheck ? "warning" : checks.length > 0 ? "passed" : "not_evaluated",
      checks
    }
  };
}

// src/core/taskLedger.ts
var TASK_LEDGER_SCHEMA_ID = "tokengraph-task-ledger";
var TASK_LEDGER_SCHEMA_VERSION = 3;
var TASK_LEDGER_RETENTION_DAYS = 30;
var UUID_PATTERN2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var SHA256_PATTERN2 = /^[a-f0-9]{64}$/;
var taskLedgerWriteChains = /* @__PURE__ */ new Map();
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
async function canonicalTaskLock(root, relativeDataName) {
  const { canonicalPersistenceLock: canonicalPersistenceLock2 } = await Promise.resolve().then(() => (init_lockDomain(), lockDomain_exports));
  return canonicalPersistenceLock2(root, "tasks", relativeDataName);
}
async function runWithTaskLock(lock, operation) {
  const { withFileLock: withFileLock2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  return withFileLock2(lock, operation);
}
async function writeTaskJson(root, path, value) {
  const { writeJsonAtomic: writeJsonAtomic2 } = await Promise.resolve().then(() => (init_storage(), storage_exports));
  await writeJsonAtomic2(path, value, { telemetry: { root, storageClass: "durable" } });
}
async function readRepositoryIdentity(root) {
  const { getRepositoryIdentity: getRepositoryIdentity2 } = await Promise.resolve().then(() => (init_repositoryIdentity(), repositoryIdentity_exports));
  return getRepositoryIdentity2(root);
}
function assertTaskId(taskId) {
  if (!UUID_PATTERN2.test(taskId)) {
    throw new Error("Task id must be a UUID.");
  }
}
function tasksDirectory(root) {
  return join11(resolve10(root), ".tokengraph", "tasks");
}
function taskLedgerPath(root, taskId) {
  assertTaskId(taskId);
  return join11(tasksDirectory(root), `${taskId}.json`);
}
function hasExactKeys2(value, required, optional = []) {
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
  if (!hasExactKeys2(value, required, ["remoteIdentity"]) || !required.every((key) => isIdentifier(value[key])) || value.remoteIdentity !== void 0 && !isIdentifier(value.remoteIdentity)) return void 0;
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
  if (!hasExactKeys2(value, ["decision", "stage", "reason", "expectedOverheadTokens", "mode", "enforced"]) || value.decision !== "activate" && value.decision !== "bypass" || !Number.isInteger(value.stage) || value.stage < 0 || typeof value.reason !== "string" || !finiteNonnegative(value.expectedOverheadTokens) || !isLiteral(value.mode, ["shadow", "enforced", "always-activate", "always-advisory"]) || typeof value.enforced !== "boolean") return void 0;
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
  if (!hasExactKeys2(value, ["level", "allowRawReads", "reason"], [
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
  if (!hasExactKeys2(value, ["name", "passed"]) || typeof value.name !== "string" || typeof value.passed !== "boolean") return void 0;
  return { name: value.name, passed: value.passed };
}
function decodeCurrentEvent(value) {
  if (!hasExactKeys2(value, [
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
  ], ["deferredMemoryUseDigests"]) || typeof value.id !== "string" || typeof value.fingerprint !== "string" || typeof value.category !== "string" || typeof value.toolName !== "string" || !finiteNonnegative(value.originalTokens) || !finiteNonnegative(value.compactTokens) || !finiteNonnegative(value.overheadTokens) || !isLiteral(value.confidence, ["low", "medium", "high"]) || !isTimestamp(value.timestamp) || !Array.isArray(value.qualityChecks) || value.deferredMemoryUseDigests !== void 0 && (!Array.isArray(value.deferredMemoryUseDigests) || value.deferredMemoryUseDigests.length > 100 || !value.deferredMemoryUseDigests.every((digest2) => typeof digest2 === "string" && SHA256_PATTERN2.test(digest2)) || new Set(value.deferredMemoryUseDigests).size !== value.deferredMemoryUseDigests.length)) return void 0;
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
    qualityChecks,
    ...value.deferredMemoryUseDigests === void 0 ? {} : { deferredMemoryUseDigests: [...value.deferredMemoryUseDigests] }
  };
}
function decodeCurrentOutcome(value, expectedTaskId) {
  if (!hasExactKeys2(value, [
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
  if (!hasExactKeys2(value, ["low", "likely", "high", "unit"]) || typeof value.low !== "number" || !Number.isFinite(value.low) || typeof value.likely !== "number" || !Number.isFinite(value.likely) || typeof value.high !== "number" || !Number.isFinite(value.high) || value.low > value.likely || value.likely > value.high || value.unit !== "estimated_tokens") return void 0;
  return { low: value.low, likely: value.likely, high: value.high, unit: "estimated_tokens" };
}
function decodeCurrentTaskReport(value, expectedTaskId, expectedEventCount) {
  if (!hasExactKeys2(value, ["taskId", "eventCount", "estimate", "categories", "quality"]) || value.taskId !== expectedTaskId || value.eventCount !== expectedEventCount || !Number.isInteger(value.eventCount) || !Array.isArray(value.categories) || !hasExactKeys2(value.estimate, ["range", "confidence", "basis", "overhead", "estimatorVersion"]) || !hasExactKeys2(value.quality, ["status", "checks"])) return void 0;
  const estimateRange = decodeCurrentRange(value.estimate.range);
  if (!estimateRange || !isLiteral(value.estimate.confidence, ["low", "medium", "high"]) || !stringArray(value.estimate.basis) || !finiteNonnegative(value.estimate.overhead) || value.estimate.estimatorVersion !== TASK_ESTIMATOR_VERSION || !isLiteral(value.quality.status, ["passed", "warning", "not_evaluated"]) || !stringArray(value.quality.checks)) return void 0;
  const categories = value.categories.map((category) => {
    if (!hasExactKeys2(category, ["category", "eventCount", "range", "confidence", "basis", "overhead"]) || !isIdentifier(category.category) || !Number.isInteger(category.eventCount) || category.eventCount < 1 || !isLiteral(category.confidence, ["low", "medium", "high"]) || !stringArray(category.basis) || !finiteNonnegative(category.overhead)) return void 0;
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
  if (!hasExactKeys2(value, REQUIRED_CURRENT_LEDGER_KEYS, [...CURRENT_LEDGER_KEYS].filter((key) => !REQUIRED_CURRENT_LEDGER_KEYS.includes(key))) || value.schemaId !== TASK_LEDGER_SCHEMA_ID || value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || value.taskId !== expectedTaskId || !isLiteral(value.host, ["codex", "claude", "unknown"]) || !isLiteral(value.status, ["open", "paused", "completed", "quarantined"]) || !isOptionalIdentifier(value.sessionId) || !isOptionalIdentifier(value.turnId) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.pausedAt !== void 0 && !isTimestamp(value.pausedAt) || value.completedAt !== void 0 && !isTimestamp(value.completedAt) || value.estimatorVersion !== TASK_ESTIMATOR_VERSION || !Array.isArray(value.deliveredArtifacts) || !value.deliveredArtifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) || !Array.isArray(value.outcomes) || !Array.isArray(value.events) || value.lastDisposition !== void 0 && value.lastDisposition !== "pause" && value.lastDisposition !== "complete" || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && (Date.parse(value.pausedAt) < Date.parse(value.createdAt) || Date.parse(value.pausedAt) > Date.parse(value.updatedAt)) || value.completedAt !== void 0 && (Date.parse(value.completedAt) < Date.parse(value.createdAt) || Date.parse(value.completedAt) > Date.parse(value.updatedAt))) return void 0;
  const repositoryIdentity = value.repositoryIdentity === void 0 ? void 0 : decodeCurrentRepositoryIdentity(value.repositoryIdentity);
  const routingObservation2 = value.routingObservation === void 0 ? void 0 : decodeCurrentRoutingObservation(value.routingObservation);
  const readPolicy = value.readPolicy === void 0 ? void 0 : decodeCurrentReadPolicy(value.readPolicy);
  const events = value.events.map(decodeCurrentEvent);
  const outcomes = value.outcomes.map((outcome) => decodeCurrentOutcome(outcome, expectedTaskId));
  if (value.repositoryIdentity !== void 0 && !repositoryIdentity || value.routingObservation !== void 0 && !routingObservation2 || value.readPolicy !== void 0 && !readPolicy || events.some((entry) => entry === void 0) || outcomes.some((entry) => entry === void 0)) return void 0;
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
    ...routingObservation2 === void 0 ? {} : { routingObservation: routingObservation2 },
    ...readPolicy === void 0 ? {} : { readPolicy },
    deliveredArtifacts: [...value.deliveredArtifacts],
    outcomes,
    events,
    ...value.lastDisposition === void 0 ? {} : { lastDisposition: value.lastDisposition },
    ...completedReport === void 0 ? {} : { completedReport }
  };
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
function reconstructQualityCheck(value) {
  if (!isRecord2(value) || typeof value.name !== "string" || typeof value.passed !== "boolean") return void 0;
  return { name: value.name, passed: value.passed };
}
function reconstructEvent(value) {
  if (!isRecord2(value) || !Array.isArray(value.qualityChecks)) return void 0;
  const qualityChecks = value.qualityChecks.map(reconstructQualityCheck);
  if (typeof value.id !== "string" || typeof value.fingerprint !== "string" || typeof value.category !== "string" || typeof value.toolName !== "string" || typeof value.originalTokens !== "number" || !Number.isFinite(value.originalTokens) || value.originalTokens < 0 || typeof value.compactTokens !== "number" || !Number.isFinite(value.compactTokens) || value.compactTokens < 0 || typeof value.overheadTokens !== "number" || !Number.isFinite(value.overheadTokens) || value.overheadTokens < 0 || value.confidence !== "low" && value.confidence !== "medium" && value.confidence !== "high" || !isTimestamp(value.timestamp) || qualityChecks.some((check) => check === void 0) || value.deferredMemoryUseDigests !== void 0 && (!Array.isArray(value.deferredMemoryUseDigests) || value.deferredMemoryUseDigests.length > 100 || !value.deferredMemoryUseDigests.every((digest2) => typeof digest2 === "string" && SHA256_PATTERN2.test(digest2)))) {
    return void 0;
  }
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
    qualityChecks,
    ...value.deferredMemoryUseDigests === void 0 ? {} : { deferredMemoryUseDigests: [...new Set(value.deferredMemoryUseDigests)] }
  };
}
function reconstructOutcome(value) {
  if (!isRecord2(value) || !Array.isArray(value.evidence)) return void 0;
  if (!isIdentifier(value.id) || !isIdentifier(value.taskId) || typeof value.summary !== "string" || value.summary.trim().length === 0 || !isLiteral(value.status, ["verified", "proposed", "failed"]) || !value.evidence.every((entry) => isIdentifier(entry)) || !isTimestamp(value.createdAt) || value.staleAt !== void 0 && !isTimestamp(value.staleAt) || value.sourceFingerprint !== void 0 && !isIdentifier(value.sourceFingerprint) || !isIdentifier(value.branch) || !isIdentifier(value.worktreeId) || !isIdentifier(value.headCommit)) return void 0;
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
function reconstructTaskLedger(value, expectedTaskId) {
  if (!isRecord2(value) || !Array.isArray(value.events)) return void 0;
  const legacy = value.schemaVersion === 1 || value.schemaVersion === 2;
  const events = value.events.map(reconstructEvent);
  const outcomes = value.outcomes === void 0 && legacy ? [] : Array.isArray(value.outcomes) ? value.outcomes.map(reconstructOutcome) : void 0;
  const routingObservation2 = value.routingObservation === void 0 ? void 0 : reconstructRoutingObservation(value.routingObservation);
  const readPolicy = value.readPolicy === void 0 ? void 0 : reconstructReadPolicy(value.readPolicy);
  const deliveredArtifacts = value.deliveredArtifacts === void 0 ? [] : Array.isArray(value.deliveredArtifacts) && value.deliveredArtifacts.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512) ? [...new Set(value.deliveredArtifacts)] : void 0;
  if (value.schemaId !== TASK_LEDGER_SCHEMA_ID || value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || value.taskId !== expectedTaskId || !isLiteral(value.host, ["codex", "claude", "unknown"]) || !isLiteral(value.status, ["open", "paused", "completed", "quarantined"]) || !isOptionalIdentifier(value.sessionId) || !isOptionalIdentifier(value.turnId) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.pausedAt !== void 0 && !isTimestamp(value.pausedAt) || value.completedAt !== void 0 && !isTimestamp(value.completedAt) || !legacy && value.estimatorVersion !== TASK_ESTIMATOR_VERSION || legacy && value.estimatorVersion !== "task-estimator-v1" && value.estimatorVersion !== TASK_ESTIMATOR_VERSION || value.repositoryIdentity !== void 0 && !isRepositoryIdentity(value.repositoryIdentity) || value.routingObservation !== void 0 && routingObservation2 === void 0 || value.readPolicy !== void 0 && readPolicy === void 0 || deliveredArtifacts === void 0 || outcomes === void 0 || outcomes.some((outcome) => outcome === void 0) || events.some((event) => event === void 0) || value.lastDisposition !== void 0 && value.lastDisposition !== "pause" && value.lastDisposition !== "complete" || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && Date.parse(value.pausedAt) < Date.parse(value.createdAt) || value.pausedAt !== void 0 && Date.parse(value.pausedAt) > Date.parse(value.updatedAt) || value.completedAt !== void 0 && Date.parse(value.completedAt) < Date.parse(value.createdAt) || value.completedAt !== void 0 && Date.parse(value.completedAt) > Date.parse(value.updatedAt)) {
    return void 0;
  }
  const completedReport = legacy && value.status === "completed" ? void 0 : value.completedReport === void 0 ? void 0 : reconstructTaskReport(value.completedReport, expectedTaskId, events.length);
  if (!legacy && value.completedReport !== void 0 && completedReport === void 0) return void 0;
  if (value.status === "open" && (value.pausedAt !== void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== void 0)) {
    return void 0;
  }
  if (value.status === "paused" && (value.pausedAt === void 0 || value.completedAt !== void 0 || completedReport !== void 0 || value.lastDisposition !== "pause")) {
    return void 0;
  }
  if (value.status === "completed" && (value.completedAt === void 0 || !legacy && completedReport === void 0 || value.completedReport === void 0 || value.lastDisposition !== "complete")) {
    return void 0;
  }
  const ledger = {
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
    ...value.repositoryIdentity === void 0 ? {} : { repositoryIdentity: value.repositoryIdentity },
    ...routingObservation2 === void 0 ? {} : { routingObservation: routingObservation2 },
    ...readPolicy === void 0 ? {} : { readPolicy },
    deliveredArtifacts,
    outcomes,
    events,
    ...value.lastDisposition === void 0 ? {} : { lastDisposition: value.lastDisposition },
    ...completedReport === void 0 ? {} : { completedReport }
  };
  if (legacy && ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
  return ledger;
}
function isRepositoryIdentity(value) {
  if (!isRecord2(value)) return false;
  return ["repositoryId", "repositoryFingerprint", "workspaceId", "worktreeId", "branch", "headCommit"].every((key) => isIdentifier(value[key]));
}
function reconstructRoutingObservation(value) {
  if (!isRecord2(value)) return void 0;
  if (value.decision !== "activate" && value.decision !== "bypass" || !Number.isInteger(value.stage) || value.stage < 0 || typeof value.reason !== "string" || typeof value.expectedOverheadTokens !== "number" || !Number.isFinite(value.expectedOverheadTokens) || value.expectedOverheadTokens < 0 || !isLiteral(value.mode, ["shadow", "enforced", "always-activate", "always-advisory"]) || typeof value.enforced !== "boolean") return void 0;
  return {
    decision: value.decision,
    stage: value.stage,
    reason: value.reason,
    expectedOverheadTokens: value.expectedOverheadTokens,
    mode: value.mode,
    enforced: value.enforced
  };
}
function reconstructReadPolicy(value) {
  if (!isRecord2(value)) return void 0;
  if (!isLiteral(value.level, ["L0", "L1", "L2", "L3", "L4"]) || typeof value.allowRawReads !== "boolean" || typeof value.reason !== "string" || value.targetedReads !== void 0 && (!Number.isInteger(value.targetedReads) || value.targetedReads < 0) || value.recommendedReadsThisResponse !== void 0 && (!Number.isInteger(value.recommendedReadsThisResponse) || value.recommendedReadsThisResponse < 0) || value.requiresReassessment !== void 0 && typeof value.requiresReassessment !== "boolean" || value.hasReassessed !== void 0 && typeof value.hasReassessed !== "boolean" || value.evidenceGap !== void 0 && typeof value.evidenceGap !== "string") return void 0;
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
async function quarantine(path, now = /* @__PURE__ */ new Date()) {
  const timestamp = now.toISOString().replaceAll(":", "-");
  try {
    await rename4(path, `${path}.quarantine-${timestamp}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function enqueueLedgerOperation(root, taskId, operation) {
  assertTaskId(taskId);
  const lock = await canonicalTaskLock(root, `${taskId}.json`);
  const key = process.platform === "win32" ? lock.anchorPath.toLowerCase() : lock.anchorPath;
  const previous = taskLedgerWriteChains.get(key) ?? Promise.resolve();
  const runWithFileLock2 = async () => runWithTaskLock(lock, operation);
  const current = previous.then(runWithFileLock2, runWithFileLock2);
  let settled;
  const cleanUp = () => {
    if (taskLedgerWriteChains.get(key) === settled) {
      taskLedgerWriteChains.delete(key);
    }
  };
  settled = current.then(cleanUp, cleanUp);
  taskLedgerWriteChains.set(key, settled);
  return current;
}
async function loadTaskLedger(root, taskId, repairInsideLock = false) {
  const path = taskLedgerPath(root, taskId);
  try {
    const parsed = JSON.parse(await readFile8(path, "utf8"));
    if (isRecord2(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > TASK_LEDGER_SCHEMA_VERSION) {
      throw new Error(`Task ledger schema ${parsed.schemaVersion} is newer than supported schema ${TASK_LEDGER_SCHEMA_VERSION}; refusing to modify it.`);
    }
    const ledger = reconstructTaskLedger(parsed, taskId);
    if (!ledger) {
      if (repairInsideLock) await quarantine(path);
      return void 0;
    }
    if (!ledger.repositoryIdentity || isRecord2(parsed) && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)) {
      ledger.repositoryIdentity ??= await readRepositoryIdentity(root);
      ledger.schemaVersion = TASK_LEDGER_SCHEMA_VERSION;
      ledger.estimatorVersion = TASK_ESTIMATOR_VERSION;
      ledger.outcomes ??= [];
      if (ledger.status === "completed") ledger.completedReport = buildTaskReport(ledger);
      if (repairInsideLock) await writeTaskJson(root, path, ledger);
    }
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    if (error instanceof SyntaxError) {
      if (repairInsideLock) await quarantine(path);
      return void 0;
    }
    throw error;
  }
}
async function requireTaskLedger(root, taskId, repairInsideLock = false) {
  const ledger = await loadTaskLedger(root, taskId, repairInsideLock);
  if (!ledger) throw new Error(`Task ledger ${taskId} was not found or was corrupt.`);
  return ledger;
}
async function requireOpenTaskForOutcome(root, taskId, repairInsideLock = false) {
  const ledger = await requireTaskLedger(root, taskId, repairInsideLock);
  if (ledger.status !== "open") {
    throw new Error(`Task ${taskId} must be open to record an outcome; current status is ${ledger.status}.`);
  }
  if (!ledger.repositoryIdentity) throw new Error(`Task ${taskId} has no repository identity.`);
  const currentIdentity = await readRepositoryIdentity(root);
  if (currentIdentity.repositoryId !== ledger.repositoryIdentity.repositoryId) {
    throw new Error(`Task ${taskId} belongs to a different repository.`);
  }
  if (currentIdentity.worktreeId !== ledger.repositoryIdentity.worktreeId) {
    throw new Error(`Task ${taskId} belongs to a different worktree.`);
  }
  if (currentIdentity.branch !== ledger.repositoryIdentity.branch) {
    throw new Error(`Task ${taskId} belongs to a different branch.`);
  }
  return ledger;
}
async function recordTaskOutcome(root, taskId, outcome) {
  return enqueueLedgerOperation(root, taskId, async () => {
    const ledger = await requireOpenTaskForOutcome(root, taskId);
    const candidate = reconstructOutcome(outcome);
    if (!candidate) throw new Error("Task outcome is malformed.");
    if (candidate.taskId !== taskId) throw new Error("Task outcome task id does not match the ledger task id.");
    if (candidate.branch !== ledger.repositoryIdentity.branch) {
      throw new Error("Task outcome branch does not match the ledger branch.");
    }
    if (candidate.worktreeId !== ledger.repositoryIdentity.worktreeId) {
      throw new Error("Task outcome worktree does not match the ledger worktree.");
    }
    if (!ledger.outcomes.some((stored) => stored.id === candidate.id)) {
      ledger.outcomes.push(candidate);
      ledger.outcomes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      ledger.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      await writeTaskJson(root, taskLedgerPath(root, taskId), ledger);
    }
    return ledger;
  });
}

// src/core/version.ts
var TOKEN_GRAPH_RUNTIME_VERSION = "0.25.0";

// src/core/doctor.ts
var SHA256_PATTERN3 = /^[a-f0-9]{64}$/u;
var UUID_PATTERN3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var MAX_JSON_BYTES = 256 * 1024 * 1024;
var MAX_MANIFEST_BYTES = 4 * 1024;
var LOCK_INFRASTRUCTURE_NAMES = /* @__PURE__ */ new Set([
  NATIVE_LOCK_ANCHOR_NAME,
  NATIVE_LOCK_JOURNAL_NAME,
  NATIVE_LOCK_JOURNAL_TEMP_NAME
]);
function isObject2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function emptyUsage() {
  const empty = () => ({ bytes: 0, files: 0 });
  return { total: empty(), runs: empty(), cache: empty(), vault: empty(), durable: empty() };
}
function defaultStorage() {
  const storage = DEFAULT_TOKEN_GRAPH_CONFIG.storage;
  return {
    usage: emptyUsage(),
    quotas: {
      maxBytes: storage.maxBytes,
      runsMaxBytes: storage.runsMaxBytes,
      cacheMaxBytes: storage.cacheMaxBytes,
      vaultMaxBytes: storage.vaultMaxBytes,
      durableMaxBytes: storage.durableMaxBytes
    },
    writePolicy: storage.writePolicy,
    recentWrites: { operations: 0, logicalBytes: 0, physicalBytes: null, sampledPeakRssBytes: 0, available: false },
    quotaPressure: false,
    configState: "default"
  };
}
function unavailableVersions() {
  return {
    runtime: TOKEN_GRAPH_RUNTIME_VERSION,
    node: process.version,
    package: null,
    codexManifest: null,
    claudeManifest: null,
    generatedRelease: null,
    agreement: "unavailable"
  };
}
function unavailableParser() {
  return {
    runtime: TREE_SITTER_RUNTIME,
    grammars: Object.entries(PINNED_GRAMMARS).map(([language, grammar]) => ({
      language,
      version: grammar.version,
      present: false
    }))
  };
}
function within(root, candidate) {
  const nested = relative10(resolve11(root), resolve11(candidate));
  return nested === "" || !isAbsolute9(nested) && nested !== ".." && !nested.startsWith("../") && !nested.startsWith("..\\");
}
async function readJson(reader, path, maximumBytes) {
  try {
    const content = await reader.text(path, maximumBytes);
    if (content === void 0) return { state: "missing" };
    const parsed = JSON.parse(content);
    return isObject2(parsed) ? { state: "present", value: parsed } : { state: "corrupt" };
  } catch (error) {
    if (error instanceof SyntaxError) return { state: "corrupt" };
    throw error;
  }
}
async function readVersion(reader, path) {
  const result = await readJson(reader, path, 1024 * 1024);
  return result.state === "present" && typeof result.value?.version === "string" ? result.value.version : null;
}
async function collectVersions(pluginRoot, authorizedWorkspace) {
  const root = resolve11(pluginRoot);
  const reader = new DiagnosticReader(root);
  const [packageVersion, codexManifest, claudeManifest] = await Promise.all([
    readVersion(reader, join12(root, "package.json")),
    readVersion(reader, join12(root, ".codex-plugin", "plugin.json")),
    readVersion(reader, join12(root, ".claude-plugin", "plugin.json"))
  ]);
  const sourceLayout = (await reader.inspect(join12(root, "src")))?.isDirectory() === true;
  let generatedRelease = null;
  if (sourceLayout && authorizedWorkspace) {
    const releaseRoot = resolve11(root, "..", "..", "release", "tokengraph");
    const nested = relative10(resolve11(authorizedWorkspace), releaseRoot);
    if (!isAbsolute9(nested) && nested !== ".." && !nested.startsWith("..\\") && !nested.startsWith("../")) {
      const releaseReader = new DiagnosticReader(authorizedWorkspace);
      const [releasePackage, releaseCodex, releaseClaude] = await Promise.all([
        readVersion(releaseReader, join12(releaseRoot, "package.json")),
        readVersion(releaseReader, join12(releaseRoot, ".codex-plugin", "plugin.json")),
        readVersion(releaseReader, join12(releaseRoot, ".claude-plugin", "plugin.json"))
      ]);
      generatedRelease = { package: releasePackage, codexManifest: releaseCodex, claudeManifest: releaseClaude };
    }
  }
  const requiredVersions = [
    TOKEN_GRAPH_RUNTIME_VERSION,
    packageVersion,
    codexManifest,
    claudeManifest,
    ...generatedRelease ? [generatedRelease.package, generatedRelease.codexManifest, generatedRelease.claudeManifest] : []
  ];
  const known = requiredVersions.filter((value) => typeof value === "string");
  const agreement = packageVersion === null && codexManifest === null && claudeManifest === null ? "unavailable" : requiredVersions.some((value) => value === null) ? "mismatch" : new Set(known).size === 1 ? "match" : "mismatch";
  return {
    runtime: TOKEN_GRAPH_RUNTIME_VERSION,
    node: process.version,
    package: packageVersion,
    codexManifest,
    claudeManifest,
    generatedRelease,
    agreement
  };
}
async function collectParser(pluginRoot) {
  const reader = new DiagnosticReader(pluginRoot);
  const assetRoot = join12(resolve11(pluginRoot), "assets", "grammars");
  const grammars = await Promise.all(Object.entries(PINNED_GRAMMARS).map(async ([language, grammar]) => {
    try {
      const content = await reader.bytes(join12(assetRoot, grammar.asset), 32 * 1024 * 1024);
      if (content === void 0) return { language, version: grammar.version, present: false };
      return {
        language,
        version: grammar.version,
        present: content.length > 0,
        ...content.length ? { bytes: content.length, sha256: createHash10("sha256").update(content).digest("hex") } : {}
      };
    } catch (error) {
      if (error instanceof DiagnosticBoundaryError) throw error;
      return { language, version: grammar.version, present: false };
    }
  }));
  return { runtime: TREE_SITTER_RUNTIME, grammars };
}
async function collectLeases(root, now) {
  const result = { active: 0, stale: 0, malformed: 0, unavailableDomains: [] };
  const reader = new DiagnosticReader(root);
  for (const domain of LOCK_DOMAINS) {
    if (domain === "git-info") {
      const dotGit = await reader.inspect(join12(root, ".git"));
      if (!dotGit) continue;
      if (!dotGit.isDirectory()) {
        result.unavailableDomains.push(domain);
        continue;
      }
    }
    const directory = await resolveLockDomainRootReadOnly(root, domain);
    const entries = await reader.directory(directory) ?? [];
    for (const entry of entries) {
      const path = join12(directory, entry.name);
      if (LOCK_INFRASTRUCTURE_NAMES.has(entry.name)) continue;
      if (entry.name.toLowerCase().endsWith(".lock")) {
        if (!entry.isDirectory()) {
          result.malformed += 1;
          continue;
        }
        const text = await reader.text(join12(path, "lease.json"), 4 * 1024);
        const lease = text === void 0 ? void 0 : parseFileLockLease(text);
        if (!lease) result.malformed += 1;
        else if (now.getTime() - Date.parse(lease.heartbeatAt) > DEFAULT_FILE_LOCK_POLICY.staleMs) result.stale += 1;
        else result.active += 1;
      }
    }
  }
  return result;
}
async function collectLedgers(root, now) {
  const result = { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 };
  const reader = new DiagnosticReader(root);
  const entries = await reader.directory(join12(stateDir(root), "tasks")) ?? [];
  const cutoff = now.getTime() - TASK_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
  for (const entry of entries) {
    if (entry.name === "completed-outcomes.json") continue;
    if (LOCK_INFRASTRUCTURE_NAMES.has(entry.name) || entry.name.toLowerCase().endsWith(".lock")) continue;
    const taskId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    if (entry.isSymbolicLink() || !entry.isFile() || !UUID_PATTERN3.test(taskId)) {
      result.malformed += 1;
      continue;
    }
    const inspected = await readJson(reader, join12(stateDir(root), "tasks", entry.name), MAX_READ_ONLY_LEDGER_BYTES);
    const ledger = decodeCurrentTaskLedger(inspected.value, taskId);
    if (!ledger) {
      result.malformed += 1;
      continue;
    }
    if (ledger.status === "open") {
      result.open += 1;
      if (ledger.events.length === 0 && Date.parse(ledger.updatedAt) < cutoff) result.orphanCandidates += 1;
    } else if (ledger.status === "paused") result.paused += 1;
    else if (ledger.status === "completed") result.completed += 1;
  }
  return result;
}
async function collectConfig(root) {
  const read = await readJson(new DiagnosticReader(root), join12(stateDir(root), "config.json"), 1024 * 1024);
  if (read.state === "missing") return { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "default" };
  if (read.state === "corrupt") return { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "invalid" };
  const decoded = inspectTokenGraphConfig(read.value);
  return { config: decoded.config, state: decoded.valid ? "valid" : "invalid" };
}
async function collectStorage(root, configured, failures) {
  const usage2 = await storageClassUsageReadOnly(root);
  let telemetry = { schemaVersion: 1, days: [] };
  try {
    const text = await new DiagnosticReader(root).text(writeTelemetryPath(root), 256 * 1024);
    if (text !== void 0) telemetry = normalizeWriteTelemetry(JSON.parse(text));
  } catch (error) {
    if (error instanceof DiagnosticBoundaryError) throw error;
    failures.push("write-telemetry-unavailable");
  }
  const storage = configured.config.storage;
  const quotas = {
    maxBytes: storage.maxBytes,
    runsMaxBytes: storage.runsMaxBytes,
    cacheMaxBytes: storage.cacheMaxBytes,
    vaultMaxBytes: storage.vaultMaxBytes,
    durableMaxBytes: storage.durableMaxBytes
  };
  let operations = 0;
  let logicalBytes = 0;
  let physicalBytes = 0;
  let physicalAvailable = true;
  let aggregateCount = 0;
  let sampledPeakRssBytes = 0;
  for (const day of telemetry.days) {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, day.sampledPeakRssBytes);
    for (const aggregate of Object.values(day.classes)) {
      if (!aggregate) continue;
      aggregateCount += 1;
      operations += aggregate.operationCount;
      logicalBytes += aggregate.logicalBytes;
      if (aggregate.physicalBytes !== void 0) {
        physicalBytes += aggregate.physicalBytes;
      } else physicalAvailable = false;
    }
  }
  if (![operations, logicalBytes, physicalBytes].every(Number.isSafeInteger)) throw new Error("TokenGraph diagnostic aggregate exceeds the safe integer range.");
  return {
    usage: usage2,
    quotas,
    writePolicy: storage.writePolicy,
    configState: configured.state,
    recentWrites: {
      operations,
      logicalBytes,
      physicalBytes: physicalAvailable && aggregateCount > 0 ? physicalBytes : null,
      sampledPeakRssBytes,
      available: telemetry.days.length > 0
    },
    quotaPressure: usage2.total.bytes > quotas.maxBytes || usage2.runs.bytes > quotas.runsMaxBytes || usage2.cache.bytes > quotas.cacheMaxBytes || usage2.vault.bytes > quotas.vaultMaxBytes || usage2.durable.bytes > quotas.durableMaxBytes
  };
}
function isSafeRelativeFile(root, path) {
  if (typeof path !== "string" || !path || isAbsolute9(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  const nested = relative10(resolve11(root), resolve11(root, path));
  return Boolean(nested) && !nested.startsWith("..") && !isAbsolute9(nested);
}
function sameIdentity(left, right) {
  if (!left || !right) return null;
  return left.repositoryId === right.repositoryId && left.repositoryFingerprint === right.repositoryFingerprint && left.workspaceId === right.workspaceId && left.worktreeId === right.worktreeId && left.branch === right.branch && left.headCommit === right.headCommit && left.remoteIdentity === right.remoteIdentity;
}
async function indexedFilesMatchContent(reader, root, index, requireMetadata) {
  const paths = index.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) return false;
  if (requireMetadata) {
    if (!index.scanMetadata?.files || !Array.isArray(index.scanMetadata.exclusions)) return false;
    if (JSON.stringify([...paths].sort()) !== JSON.stringify(Object.keys(index.scanMetadata.files).sort())) return false;
  }
  for (const file of index.files) {
    if (!isSafeRelativeFile(root, file.path) || !SHA256_PATTERN3.test(file.contentHash)) return false;
    if (requireMetadata && index.scanMetadata?.files[file.path]?.contentHash !== file.contentHash) return false;
    const content = await reader.text(resolve11(root, file.path), MAX_JSON_BYTES);
    if (content === void 0 || createHash10("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex") !== file.contentHash) return false;
  }
  return true;
}
function scannerBudget(config) {
  return {
    maxFiles: config.maxFiles,
    maxDepth: config.parser.maxRecursionDepth,
    maxTotalBytes: config.parser.maxTotalBytes,
    maxFileBytes: config.parser.maxFileBytes,
    maxSymbols: config.parser.maxSymbols,
    maxNodes: config.parser.maxNodes,
    maxGeneratedFiles: config.parser.maxGeneratedFiles,
    perFileTimeoutMs: config.parser.perFileTimeoutMs,
    wholeIndexTimeoutMs: config.parser.wholeIndexTimeoutMs,
    polyglotEnabled: config.parser.polyglotEnabled
  };
}
function corruptIndex(schemaVersion, generation) {
  return { presence: "corrupt", state: "corrupt", schemaVersion, generation, rootValid: null, identityValid: null, metadataContentConsistent: null };
}
async function collectIndex(root, config, failures) {
  const reader = new DiagnosticReader(root);
  const manifestText = await reader.text(indexManifestPath(root), MAX_MANIFEST_BYTES);
  let parsed;
  let generation = null;
  if (manifestText !== void 0) {
    let manifest;
    try {
      manifest = parseManifest(JSON.parse(manifestText));
    } catch {
      return corruptIndex(null, null);
    }
    if (!manifest) return corruptIndex(null, null);
    generation = manifest.generationId;
    const generationContent = await reader.text(join12(stateDir(root), manifest.generationFile), MAX_JSON_BYTES);
    if (generationContent === void 0 || createHash10("sha256").update(generationContent).digest("hex") !== manifest.contentHash) {
      return corruptIndex(null, generation);
    }
    try {
      parsed = JSON.parse(generationContent);
    } catch {
      return corruptIndex(null, generation);
    }
  } else {
    const legacyText = await reader.text(indexPath(root), MAX_JSON_BYTES);
    if (legacyText === void 0) return { presence: "missing", state: "missing", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null };
    try {
      parsed = JSON.parse(legacyText);
    } catch {
      return corruptIndex(null, null);
    }
  }
  const schemaVersion = isObject2(parsed) && typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null;
  let index;
  try {
    if (!isProjectIndex(parsed)) return corruptIndex(schemaVersion, generation);
    index = parsed;
  } catch {
    failures.push("index-schema-unsupported");
    return corruptIndex(schemaVersion, generation);
  }
  if (manifestText !== void 0 && index.schemaVersion !== 5 || manifestText === void 0 && index.schemaVersion !== 4 || generation !== null && index.generation?.id !== generation) {
    return corruptIndex(typeof index.schemaVersion === "number" ? index.schemaVersion : null, generation);
  }
  const rootValid = resolve11(index.root) === resolve11(root);
  const currentIdentity = await getRepositoryIdentityReadOnly(root);
  const identityValid = sameIdentity(index.repositoryIdentity, currentIdentity);
  let metadataContentConsistent = false;
  try {
    metadataContentConsistent = index.schemaVersion === 5 ? generationValidationFailure(root, index, index.repositoryIdentity) === void 0 && await indexedFilesMatchContent(reader, root, index, true) : await indexedFilesMatchContent(reader, root, index, false) && index.fingerprint === projectIndexFingerprint(index);
  } catch (error) {
    if (error instanceof DiagnosticBoundaryError) throw error;
    metadataContentConsistent = false;
  }
  let state = !rootValid || identityValid === false || !metadataContentConsistent ? "stale" : "unknown";
  if (state === "unknown" && identityValid === true && typeof index.scanSignature === "string") {
    try {
      state = await scanProjectSignature(root, scannerBudget(config), reader) === index.scanSignature ? "fresh" : "stale";
    } catch (error) {
      if (error instanceof DiagnosticBoundaryError) throw error;
      failures.push("index-freshness-unavailable");
      state = "unknown";
    }
  }
  return {
    presence: "present",
    state,
    schemaVersion: typeof index.schemaVersion === "number" ? index.schemaVersion : null,
    generation,
    rootValid,
    identityValid,
    metadataContentConsistent
  };
}
function blockedReport(workspace, versions, parser, attestation, recommendation) {
  return {
    schemaVersion: 1,
    status: "blocked",
    workspace,
    stateAccess: "blocked",
    versions,
    lifecycle: { attestation, nativeLockActivation: getLegacyRuntimeActivationStatus().activated ? "activated" : "unactivated" },
    parser,
    leases: { active: 0, stale: 0, malformed: 0, unavailableDomains: [] },
    ledgers: { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 },
    storage: defaultStorage(),
    index: { presence: "missing", state: "unknown", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null },
    recommendations: [recommendation]
  };
}
async function collectDoctorReport(options) {
  const attestation = options.attestation ?? "unavailable";
  const failures = [];
  const authorizedWorkspace = options.workspace.status === "ready" && within(options.workspace.root, options.pluginRoot) ? options.workspace.root : void 0;
  let versions = unavailableVersions();
  let parser = unavailableParser();
  try {
    versions = await collectVersions(options.pluginRoot, authorizedWorkspace);
  } catch {
    failures.push("version-unavailable");
  }
  try {
    parser = await collectParser(options.pluginRoot);
  } catch {
    failures.push("parser-assets-unavailable");
  }
  if (options.workspace.status === "blocked") {
    return blockedReport(
      { status: "blocked", source: options.workspace.source, blockingReason: options.workspace.blockingReason },
      versions,
      parser,
      attestation,
      options.workspace.blockingReason
    );
  }
  const readyWorkspace = options.workspace;
  const workspace = { status: "ready", source: readyWorkspace.source };
  const emptyLeases = { active: 0, stale: 0, malformed: 0, unavailableDomains: [] };
  const emptyLedgers = { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 };
  const emptyIndex = { presence: "missing", state: "unknown", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null };
  let leases = emptyLeases;
  let ledgers = emptyLedgers;
  let storage = defaultStorage();
  let index = emptyIndex;
  const now = options.now ?? /* @__PURE__ */ new Date();
  try {
    const boundary = new DiagnosticReader(readyWorkspace.root);
    await boundary.inspect(readyWorkspace.root);
    await boundary.inspect(stateDir(readyWorkspace.root));
  } catch (error) {
    if (!(error instanceof DiagnosticBoundaryError)) failures.push("workspace-state-unavailable");
    return blockedReport(workspace, versions, parser, attestation, "state-boundary-violation");
  }
  let configured = { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "default" };
  const collect = async (operation, fallback, code) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DiagnosticBoundaryError) throw error;
      failures.push(code);
      return fallback;
    }
  };
  try {
    configured = await collect(
      () => collectConfig(readyWorkspace.root),
      { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "invalid" },
      "config-state-unavailable"
    );
    leases = await collect(() => collectLeases(readyWorkspace.root, now), emptyLeases, "lease-state-unavailable");
    ledgers = await collect(() => collectLedgers(readyWorkspace.root, now), emptyLedgers, "ledger-state-unavailable");
    storage = await collect(() => collectStorage(readyWorkspace.root, configured, failures), defaultStorage(), "storage-state-unavailable");
    index = await collect(() => collectIndex(readyWorkspace.root, configured.config, failures), emptyIndex, "index-state-unavailable");
  } catch (error) {
    if (error instanceof DiagnosticBoundaryError) return blockedReport(workspace, versions, parser, attestation, "state-boundary-violation");
    throw error;
  }
  const recommendations = [
    ...versions.agreement === "unavailable" ? ["version-unavailable"] : [],
    ...versions.agreement === "mismatch" ? ["version-mismatch"] : [],
    ...parser.grammars.some((grammar) => !grammar.present) ? ["parser-assets-missing"] : [],
    ...leases.unavailableDomains.length ? ["lease-domain-unavailable"] : [],
    ...leases.stale ? ["stale-lease"] : [],
    ...leases.malformed ? ["malformed-lease"] : [],
    ...ledgers.orphanCandidates ? ["orphan-ledger"] : [],
    ...ledgers.malformed ? ["malformed-ledger"] : [],
    ...storage.configState === "invalid" ? ["config-invalid"] : [],
    ...storage.quotaPressure ? ["storage-quota-pressure"] : [],
    ...index.presence === "missing" ? ["index-missing"] : [],
    ...index.presence === "corrupt" ? ["index-corrupt"] : [],
    ...index.presence === "present" && index.state === "stale" ? ["index-inconsistent"] : [],
    ...index.presence === "present" && index.state === "unknown" ? ["index-freshness-unknown"] : [],
    ...failures
  ];
  const stableRecommendations = [...new Set(recommendations)];
  return {
    schemaVersion: 1,
    status: stableRecommendations.length ? "degraded" : "healthy",
    workspace,
    stateAccess: "safe",
    versions,
    lifecycle: { attestation, nativeLockActivation: getLegacyRuntimeActivationStatus().activated ? "activated" : "unactivated" },
    parser,
    leases,
    ledgers,
    storage,
    index,
    recommendations: stableRecommendations
  };
}
function formatDoctorReport(report) {
  return [
    `TokenGraph doctor: ${report.status}`,
    `workspace: ${report.workspace.status} (${report.workspace.source})`,
    `state access: ${report.stateAccess}`,
    `versions: ${report.versions.agreement}`,
    `parser: ${report.parser.grammars.filter((grammar) => grammar.present).length}/${report.parser.grammars.length} grammar assets present`,
    `leases: ${report.leases.active} active, ${report.leases.stale} stale, ${report.leases.malformed} malformed, ${report.leases.unavailableDomains.length} domains unavailable`,
    `ledgers: ${report.ledgers.open} open, ${report.ledgers.paused} paused, ${report.ledgers.completed} completed, ${report.ledgers.orphanCandidates} orphan candidates`,
    `storage: ${report.storage.usage.total.bytes}/${report.storage.quotas.maxBytes} bytes (${report.storage.writePolicy})`,
    `index: ${report.index.state}`,
    `recommendations: ${report.recommendations.length ? report.recommendations.join(", ") : "none"}`
  ].join("\n");
}

// src/cli.ts
init_storagePolicy();

// src/core/pairedEval.ts
import { readFile as readFile10 } from "node:fs/promises";

// src/core/routingControl.ts
init_lockDomain();
init_legacyRuntimeActivation();
init_storage();
init_persistence();
import { readFile as readFile9 } from "node:fs/promises";
var CURRENT_ROUTING_CONTROL_SCHEMA = 1;
var REQUIRED_PROMOTION_GATES = [
  "minimumSamples",
  "realHostEvidence",
  "qualityNonInferiority",
  "tokenSuperiority",
  "resources",
  "routerRates",
  "routerLatency",
  "executionMedian",
  "executionP25",
  "nonNegativeActivated"
];
function routingControlPath(directory) {
  return `${directory}/routing-control.json`;
}
function isValidatedPromotion(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  const gateRecord = candidate.gates && typeof candidate.gates === "object" ? candidate.gates : void 0;
  const gates = gateRecord ? Object.values(gateRecord) : [];
  const hasRequiredGates = Boolean(gateRecord) && REQUIRED_PROMOTION_GATES.every((name) => typeof gateRecord?.[name] === "boolean") && Object.keys(gateRecord ?? {}).length === REQUIRED_PROMOTION_GATES.length;
  const allGatesPass = hasRequiredGates && gates.every((gate) => gate === true);
  const categoryCounts = candidate.categoryCounts && typeof candidate.categoryCounts === "object" ? Object.values(candidate.categoryCounts) : [];
  const evidencePasses = categoryCounts.length > 0 && categoryCounts.every((count) => Number.isInteger(count) && count >= 10) && candidate.evidenceSource === "real-host" && candidate.reviewed === true && Number.isInteger(candidate.beneficialCount) && candidate.beneficialCount > 0 && Number.isInteger(candidate.boundedCount) && candidate.boundedCount > 0 && typeof candidate.falseBypassRate === "number" && Number.isFinite(candidate.falseBypassRate) && candidate.falseBypassRate >= 0 && candidate.falseBypassRate < 0.1 && typeof candidate.falseActivationRate === "number" && Number.isFinite(candidate.falseActivationRate) && candidate.falseActivationRate >= 0 && candidate.falseActivationRate < 0.1 && typeof candidate.stage0LatencyMs === "number" && Number.isFinite(candidate.stage0LatencyMs) && candidate.stage0LatencyMs >= 0 && typeof candidate.activationLatencyMs === "number" && Number.isFinite(candidate.activationLatencyMs) && candidate.activationLatencyMs > candidate.stage0LatencyMs && candidate.stage0LatencyMaximumMs === 5 && candidate.stage0LatencyMs <= candidate.stage0LatencyMaximumMs && candidate.stage0WithinBudget === true && Number.isInteger(candidate.stage0LatencySamples) && candidate.stage0LatencySamples > 0 && Number.isInteger(candidate.activationLatencySamples) && candidate.activationLatencySamples > 0 && candidate.stage0FasterThanActivation === true && typeof candidate.executionInclusiveMedian === "number" && Number.isFinite(candidate.executionInclusiveMedian) && candidate.executionInclusiveMedian > 0 && typeof candidate.executionInclusiveP25 === "number" && Number.isFinite(candidate.executionInclusiveP25) && candidate.executionInclusiveP25 >= 0 && typeof candidate.nonNegativeActivatedRate === "number" && Number.isFinite(candidate.nonNegativeActivatedRate) && candidate.nonNegativeActivatedRate >= 0.8 && candidate.nonNegativeActivatedRate <= 1;
  return candidate.schemaVersion === 3 && typeof candidate.generatedAt === "string" && typeof candidate.enforcementEnabled === "boolean" && hasRequiredGates && evidencePasses && (!candidate.enforcementEnabled || allGatesPass);
}
function normalize2(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const envKillSwitch = process.env.TOKENGRAPH_ROUTING_KILL_SWITCH;
  return {
    schemaVersion: CURRENT_ROUTING_CONTROL_SCHEMA,
    killSwitch: envKillSwitch === "1" || envKillSwitch === "true" || candidate.killSwitch === true,
    ...isValidatedPromotion(candidate.promotion) ? { promotion: candidate.promotion } : {}
  };
}
async function loadRoutingControl(root) {
  const directory = await repositoryDir(root);
  const path = routingControlPath(directory);
  try {
    return normalize2(JSON.parse(await readFile9(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalize2(void 0);
    if (error instanceof SyntaxError) {
      if (getLegacyRuntimeActivationStatus().activated) {
        const lock = await canonicalPersistenceLock(root, "repository-state", "routing-control.json");
        await withFileLock(lock, () => quarantineCorruptJson(path));
      }
      return normalize2(void 0);
    }
    throw error;
  }
}
async function saveRoutingControl(root, control) {
  const directory = await repositoryDir(root);
  const path = routingControlPath(directory);
  const normalized = normalize2(control);
  const lock = await canonicalPersistenceLock(root, "repository-state", "routing-control.json");
  await withFileLock(lock, () => writeJsonAtomic(path, normalized, { telemetry: { root, storageClass: "durable" } }));
  return normalized;
}

// src/core/pairedEval.ts
function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function random(seed) {
  let state = seed || 1;
  return () => {
    state = state * 1664525 + 1013904223 >>> 0;
    return state / 4294967296;
  };
}
function pairedBootstrap(values, iterations = 2e3, seed = 17) {
  const estimate = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  if (!values.length) return { estimate: 0, lower: 0, upper: 0, samples: 0 };
  const next = random(seed);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(next() * values.length)];
    means.push(total / values.length);
  }
  return { estimate, lower: quantile(means, 0.025), upper: quantile(means, 0.975), samples: values.length };
}
function validateTrace(trace) {
  if (!trace.taskId || !trace.category || !["on", "off"].includes(trace.condition) || !Number.isFinite(trace.tokens) || trace.tokens < 0 || !Number.isFinite(trace.quality) || trace.executionInclusiveTokens !== void 0 && (!Number.isFinite(trace.executionInclusiveTokens) || trace.executionInclusiveTokens < 0)) throw new Error("Invalid host evaluation trace.");
}
function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function validShadowObservation(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return candidate.mode === "shadow" && (candidate.decision === "activate" || candidate.decision === "bypass") && (candidate.stage === 0 || candidate.stage === 1) && typeof candidate.reason === "string" && candidate.reason.length > 0 && typeof candidate.expectedOverheadTokens === "number" && Number.isFinite(candidate.expectedOverheadTokens) && candidate.expectedOverheadTokens >= 0 && typeof candidate.falseBypass === "boolean" && typeof candidate.falseActivation === "boolean";
}
function validateRealHostTrace(trace) {
  validateTrace(trace);
  if (!Number.isInteger(trace.repeat) || trace.repeat < 1 || trace.conditionOrder !== "on-first" && trace.conditionOrder !== "off-first" || trace.usageSource !== "host" || !trace.acceptance || trace.acceptance.status !== "passed" && trace.acceptance.status !== "failed" || !isSha256(trace.acceptance.commandHash)) {
    throw new Error("Real-host trace provenance is invalid.");
  }
  if (![trace.inputTokens, trace.cachedInputTokens, trace.outputTokens, trace.reasoningOutputTokens, trace.toolCalls, trace.fallbackRawReads].every((value) => Number.isSafeInteger(value) && value >= 0) || trace.cachedInputTokens > trace.inputTokens || trace.tokens !== trace.inputTokens + trace.outputTokens) {
    throw new Error("Real-host trace requires exact host token and tool counters.");
  }
  if (trace.condition === "off") return;
  if (!validShadowObservation(trace.routing)) throw new Error("Real-host routing observation is invalid.");
  const routing = trace.routing;
  if (!["none", "low", "medium", "high"].includes(routing.expectedBenefit ?? "") || routing.expectedRouting !== "activate" && routing.expectedRouting !== "bypass" || typeof routing.routingLatencyMs !== "number" || !Number.isFinite(routing.routingLatencyMs) || routing.routingLatencyMs < 0) {
    throw new Error("Real-host routing truth or latency is invalid.");
  }
  if (routing.expectedRouting === "bypass" !== (routing.expectedBenefit === "none")) {
    throw new Error("Real-host routing benefit does not match its reviewed truth.");
  }
  const falseBypass = routing.expectedRouting === "activate" && routing.decision === "bypass";
  const falseActivation = routing.expectedRouting === "bypass" && routing.decision === "activate";
  if (routing.falseBypass !== falseBypass || routing.falseActivation !== falseActivation) {
    throw new Error("Real-host routing outcome does not match its reviewed truth.");
  }
  if (routing.decision === "activate" && (typeof routing.activationLatencyMs !== "number" || !Number.isFinite(routing.activationLatencyMs) || routing.activationLatencyMs <= routing.routingLatencyMs)) {
    throw new Error("Real-host activation latency must be greater than routing latency.");
  }
  if (routing.decision === "bypass" && routing.activationLatencyMs !== void 0) {
    throw new Error("Bypass traces cannot claim activation latency.");
  }
}
function validProtocol(value, schemaVersion) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return Number.isInteger(candidate.runsPerTask) && candidate.runsPerTask >= 1 && Number.isInteger(candidate.minimumPerCategorySamples) && candidate.minimumPerCategorySamples >= 10 && typeof candidate.qualityNonInferiorityMargin === "number" && Number.isFinite(candidate.qualityNonInferiorityMargin) && candidate.qualityNonInferiorityMargin >= 0 && typeof candidate.tokenSuperiorityMinimum === "number" && Number.isFinite(candidate.tokenSuperiorityMinimum) && candidate.tokenSuperiorityMinimum >= 0 && typeof candidate.resourceLimit === "number" && Number.isFinite(candidate.resourceLimit) && candidate.resourceLimit >= 0 && typeof candidate.routerRateMaximum === "number" && Number.isFinite(candidate.routerRateMaximum) && candidate.routerRateMaximum > 0 && candidate.routerRateMaximum <= 0.1 && (schemaVersion !== 3 || candidate.stage0LatencyMaximumMs === 5) && typeof candidate.executionMedianMinimum === "number" && Number.isFinite(candidate.executionMedianMinimum) && candidate.executionMedianMinimum >= 0 && typeof candidate.executionP25Minimum === "number" && Number.isFinite(candidate.executionP25Minimum) && candidate.executionP25Minimum >= 0 && typeof candidate.nonNegativeActivatedMinimum === "number" && Number.isFinite(candidate.nonNegativeActivatedMinimum) && candidate.nonNegativeActivatedMinimum >= 0.8 && candidate.nonNegativeActivatedMinimum <= 1;
}
function evaluatePaired(tasks, traces, options = {}) {
  for (const trace of traces) validateTrace(trace);
  const schemaVersion = options.schemaVersion ?? 1;
  const evidenceSource = options.evidenceSource ?? "fixture";
  const reviewed = options.reviewed === true;
  const promotionEligible = schemaVersion === 3 && evidenceSource === "real-host" && reviewed;
  const runsPerTask = options.runsPerTask ?? 1;
  const byTaskAndRepeat = /* @__PURE__ */ new Map();
  for (const trace of traces) {
    const key = `${trace.taskId}:${trace.repeat ?? 1}`;
    byTaskAndRepeat.set(key, [...byTaskAndRepeat.get(key) ?? [], trace]);
  }
  const failures = [];
  const pairs = [];
  for (const task of tasks) {
    for (let repeat = 1; repeat <= runsPerTask; repeat += 1) {
      const pair = byTaskAndRepeat.get(`${task.taskId}:${repeat}`) ?? [];
      const onTraces = pair.filter((trace) => trace.condition === "on");
      const offTraces = pair.filter((trace) => trace.condition === "off");
      const on = onTraces[0];
      const off = offTraces[0];
      if (!on || !off) {
        failures.push(`${task.taskId}:repeat-${repeat}:missing-pair`);
        continue;
      }
      if (onTraces.length !== 1 || offTraces.length !== 1) failures.push(`${task.taskId}:repeat-${repeat}:duplicate-condition`);
      if (on.category !== task.category || off.category !== task.category) failures.push(`${task.taskId}:repeat-${repeat}:category-mismatch`);
      if (schemaVersion >= 2 && (on.conditionOrder !== off.conditionOrder || on.acceptance?.commandHash !== off.acceptance?.commandHash)) failures.push(`${task.taskId}:repeat-${repeat}:provenance-mismatch`);
      if (on.timedOut || off.timedOut || on.failed || off.failed || on.acceptance?.status === "failed" || off.acceptance?.status === "failed") failures.push(`${task.taskId}:failure-or-timeout`);
      pairs.push({ task, on, off });
    }
  }
  const categoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, pairs.filter((pair) => pair.task.category === category).length]));
  const minimumCategorySamples = options.minimumCategorySamples ?? 10;
  const minimumSamples = Object.values(categoryCounts).every((count) => count >= minimumCategorySamples);
  const tokenDifference = pairedBootstrap(pairs.map(({ on, off }) => on.tokens - off.tokens), 2e3, 11);
  const qualityDifference = pairedBootstrap(pairs.map(({ on, off }) => on.quality - off.quality), 2e3, 13);
  const executionSavingsValues = pairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens));
  const executionInclusiveSavings = pairedBootstrap(executionSavingsValues, 2e3, 19);
  const categoryIntervals = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category, index) => {
    const categoryPairs = pairs.filter((pair) => pair.task.category === category);
    return [category, {
      tokenDifference: pairedBootstrap(categoryPairs.map(({ on, off }) => on.tokens - off.tokens), 2e3, 101 + index),
      qualityDifference: pairedBootstrap(categoryPairs.map(({ on, off }) => on.quality - off.quality), 2e3, 201 + index),
      executionInclusiveSavings: pairedBootstrap(categoryPairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens)), 2e3, 301 + index)
    }];
  }));
  const activatedPairs = pairs.filter(({ on }) => validShadowObservation(on.routing) && on.routing.decision === "activate");
  const activatedExecutionSavings = activatedPairs.map(({ on, off }) => (off.executionInclusiveTokens ?? off.tokens) - (on.executionInclusiveTokens ?? on.tokens));
  const executionSorted = [...activatedExecutionSavings].sort((a, b) => a - b);
  const executionMedian = median(executionSorted);
  const executionP25 = executionSorted.length ? executionSorted[Math.floor((executionSorted.length - 1) * 0.25)] : 0;
  const nonNegativeActivatedRate = activatedExecutionSavings.length ? activatedExecutionSavings.filter((value) => value >= 0).length / activatedExecutionSavings.length : 0;
  const routerObservations = pairs.flatMap(({ on }) => validShadowObservation(on.routing) && on.routing.expectedRouting ? [on.routing] : []);
  const routerObservationCategories = pairs.flatMap(({ task, on }) => validShadowObservation(on.routing) && on.routing.expectedRouting ? [task.category] : []);
  const routerCategoryCounts = Object.fromEntries([...new Set(tasks.map((task) => task.category))].sort().map((category) => [category, routerObservationCategories.filter((candidate) => candidate === category).length]));
  const beneficialObservations = routerObservations.filter((observation) => observation.expectedRouting === "activate");
  const boundedObservations = routerObservations.filter((observation) => observation.expectedRouting === "bypass");
  const falseBypassRate = beneficialObservations.length ? beneficialObservations.filter((observation) => observation.falseBypass).length / beneficialObservations.length : null;
  const falseActivationRate = boundedObservations.length ? boundedObservations.filter((observation) => observation.falseActivation).length / boundedObservations.length : null;
  const stage0Latencies = routerObservations.flatMap((observation) => typeof observation.routingLatencyMs === "number" ? [observation.routingLatencyMs] : []);
  const activationLatencies = routerObservations.flatMap((observation) => typeof observation.activationLatencyMs === "number" ? [observation.activationLatencyMs] : []);
  const stage0LatencyMs = stage0Latencies.length ? median(stage0Latencies) : null;
  const activationLatencyMs = activationLatencies.length ? median(activationLatencies) : null;
  const stage0FasterThanActivation = stage0LatencyMs !== null && activationLatencyMs !== null && stage0LatencyMs < activationLatencyMs;
  const stage0LatencyMaximumMs = schemaVersion === 3 ? options.stage0LatencyMaximumMs ?? null : null;
  const stage0WithinBudget = stage0LatencyMs !== null && stage0LatencyMaximumMs !== null && stage0LatencyMs <= stage0LatencyMaximumMs;
  const qualityMargin = options.qualityMargin ?? 0.02;
  const qualityNonInferiority = qualityDifference.lower >= -qualityMargin;
  const tokenSuperiority = tokenDifference.upper <= -(options.tokenSuperiority ?? 1);
  const resourceLimit = options.resourceLimit;
  const resources = resourceLimit === void 0 || pairs.every(({ on, off }) => (on.resourceUnits ?? 0) <= resourceLimit && (off.resourceUnits ?? 0) <= resourceLimit);
  const routerRateMaximum = options.routerRateMaximum ?? 0.1;
  if (promotionEligible && Object.values(routerCategoryCounts).some((count) => count < 10)) failures.push("router-shadow-sample-incomplete");
  const gates = {
    minimumSamples,
    realHostEvidence: promotionEligible,
    qualityNonInferiority,
    tokenSuperiority,
    resources,
    routerRates: beneficialObservations.length > 0 && boundedObservations.length > 0 && Object.values(routerCategoryCounts).every((count) => count >= 10) && falseBypassRate !== null && falseBypassRate < routerRateMaximum && falseActivationRate !== null && falseActivationRate < routerRateMaximum,
    routerLatency: stage0FasterThanActivation && stage0WithinBudget,
    executionMedian: executionMedian > (options.executionMedianMinimum ?? 0),
    executionP25: executionP25 >= (options.executionP25Minimum ?? 0),
    nonNegativeActivated: nonNegativeActivatedRate >= (options.nonNegativeActivatedMinimum ?? 0.8)
  };
  return {
    schemaVersion,
    evidenceSource,
    reviewed,
    promotionEligible,
    taskCount: pairs.length,
    categoryCounts,
    tokenDifference,
    qualityDifference,
    executionInclusiveSavings,
    gates,
    routerRates: {
      falseBypassRate,
      falseActivationRate,
      beneficialCount: beneficialObservations.length,
      boundedCount: boundedObservations.length,
      observationCount: routerObservations.length,
      categoryCounts: routerCategoryCounts,
      stage0LatencyMs,
      activationLatencyMs,
      stage0LatencyMaximumMs,
      stage0WithinBudget,
      stage0LatencySamples: stage0Latencies.length,
      activationLatencySamples: activationLatencies.length,
      stage0FasterThanActivation
    },
    executionInclusive: { median: executionMedian, p25: executionP25, nonNegativeActivatedRate },
    categoryIntervals,
    enforcementEnabled: Object.values(gates).every(Boolean) && failures.length === 0,
    failures
  };
}
function evaluateManifest(manifest) {
  const protocol = manifest.protocol;
  return evaluatePaired(manifest.tasks, manifest.traces, {
    schemaVersion: manifest.schemaVersion,
    evidenceSource: manifest.evidenceSource,
    reviewed: manifest.reviewed,
    runsPerTask: protocol.runsPerTask,
    minimumCategorySamples: protocol.minimumPerCategorySamples,
    qualityMargin: protocol.qualityNonInferiorityMargin,
    tokenSuperiority: protocol.tokenSuperiorityMinimum,
    resourceLimit: protocol.resourceLimit,
    routerRateMaximum: protocol.routerRateMaximum,
    stage0LatencyMaximumMs: protocol.stage0LatencyMaximumMs,
    executionMedianMinimum: protocol.executionMedianMinimum,
    executionP25Minimum: protocol.executionP25Minimum,
    nonNegativeActivatedMinimum: protocol.nonNegativeActivatedMinimum
  });
}
function parseEvaluationManifest(value) {
  if (!value || typeof value !== "object") throw new Error("Evaluation manifest must be an object.");
  const candidate = value;
  const model = candidate.model && typeof candidate.model === "object" ? candidate.model : void 0;
  const host = candidate.host && typeof candidate.host === "object" ? candidate.host : void 0;
  const plugin = candidate.plugin && typeof candidate.plugin === "object" ? candidate.plugin : void 0;
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2 && candidate.schemaVersion !== 3 || typeof candidate.generatedAt !== "string" || typeof candidate.seed !== "string" || !model || typeof model.identifier !== "string" || !model.identifier || typeof model.versionOrDate !== "string" || !model.versionOrDate || typeof candidate.reasoningLevel !== "string" || !candidate.reasoningLevel || !host || typeof host.name !== "string" || !host.name || typeof host.version !== "string" || !host.version || !plugin || typeof plugin.version !== "string" || !plugin.version || typeof plugin.commit !== "string" || !plugin.commit || typeof candidate.repositoryCommit !== "string" || !candidate.repositoryCommit || typeof candidate.promptTemplate !== "string" || !candidate.promptTemplate || !candidate.toolConfiguration || typeof candidate.toolConfiguration !== "object" || Array.isArray(candidate.toolConfiguration) || typeof candidate.cacheState !== "string" || !candidate.cacheState || candidate.indexState !== "cold" && candidate.indexState !== "warm" || !validProtocol(candidate.protocol, candidate.schemaVersion) || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.traces)) throw new Error("Evaluation manifest schema is invalid.");
  const tasks = candidate.tasks.filter((task) => Boolean(task && typeof task.taskId === "string" && typeof task.category === "string"));
  const traces = candidate.traces.filter((trace) => Boolean(trace && typeof trace.taskId === "string" && typeof trace.category === "string"));
  if (tasks.length !== candidate.tasks.length || traces.length !== candidate.traces.length) throw new Error("Evaluation manifest contains malformed tasks or traces.");
  if (candidate.schemaVersion >= 2) {
    if (candidate.evidenceSource !== "fixture" && candidate.evidenceSource !== "real-host" || typeof candidate.reviewed !== "boolean" || !isSha256(candidate.promptTemplateHash)) {
      throw new Error("Evaluation manifest schema-v2 provenance is invalid.");
    }
    for (const trace of traces) validateRealHostTrace(trace);
  } else {
    for (const trace of traces) validateTrace(trace);
  }
  return {
    schemaVersion: candidate.schemaVersion,
    evidenceSource: candidate.schemaVersion >= 2 ? candidate.evidenceSource : "fixture",
    reviewed: candidate.schemaVersion >= 2 ? candidate.reviewed : false,
    ...candidate.schemaVersion >= 2 ? { promptTemplateHash: candidate.promptTemplateHash } : {},
    generatedAt: candidate.generatedAt,
    seed: candidate.seed,
    model: { identifier: model.identifier, versionOrDate: model.versionOrDate },
    reasoningLevel: candidate.reasoningLevel,
    host: { name: host.name, version: host.version },
    plugin: { version: plugin.version, commit: plugin.commit },
    repositoryCommit: candidate.repositoryCommit,
    promptTemplate: candidate.promptTemplate,
    toolConfiguration: candidate.toolConfiguration,
    cacheState: candidate.cacheState,
    indexState: candidate.indexState,
    protocol: candidate.protocol,
    tasks,
    traces
  };
}
async function loadEvaluationManifest(path) {
  return parseEvaluationManifest(JSON.parse(await readFile10(path, "utf8")));
}
async function persistPromotionReport(root, report) {
  const promotion = {
    schemaVersion: 3,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    enforcementEnabled: report.enforcementEnabled,
    ...report.promotionEligible ? { evidenceSource: "real-host", reviewed: true } : {},
    gates: report.gates,
    ...report.routerRates.falseBypassRate !== null ? { falseBypassRate: report.routerRates.falseBypassRate } : {},
    ...report.routerRates.falseActivationRate !== null ? { falseActivationRate: report.routerRates.falseActivationRate } : {},
    beneficialCount: report.routerRates.beneficialCount,
    boundedCount: report.routerRates.boundedCount,
    ...report.routerRates.stage0LatencyMs !== null ? { stage0LatencyMs: report.routerRates.stage0LatencyMs } : {},
    ...report.routerRates.activationLatencyMs !== null ? { activationLatencyMs: report.routerRates.activationLatencyMs } : {},
    ...report.routerRates.stage0LatencyMaximumMs !== null ? { stage0LatencyMaximumMs: report.routerRates.stage0LatencyMaximumMs } : {},
    stage0WithinBudget: report.routerRates.stage0WithinBudget,
    stage0LatencySamples: report.routerRates.stage0LatencySamples,
    activationLatencySamples: report.routerRates.activationLatencySamples,
    stage0FasterThanActivation: report.routerRates.stage0FasterThanActivation,
    executionInclusiveMedian: report.executionInclusive.median,
    executionInclusiveP25: report.executionInclusive.p25,
    nonNegativeActivatedRate: report.executionInclusive.nonNegativeActivatedRate,
    categoryCounts: report.routerRates.categoryCounts
  };
  const current = await loadRoutingControl(root);
  if (report.enforcementEnabled) {
    await saveRoutingControl(root, { ...current, promotion });
  } else {
    await saveRoutingControl(root, { schemaVersion: current.schemaVersion, killSwitch: current.killSwitch });
  }
  return promotion;
}

// src/core/pairedHost.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash11, randomUUID as randomUUID6 } from "node:crypto";
import { access as access2, chmod as chmod6, mkdir as mkdir5, open as open8, readFile as readFile11, rm as rm5, symlink, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname9, isAbsolute as isAbsolute10, relative as relative11, resolve as resolve12, sep as sep3 } from "node:path";
import { performance } from "node:perf_hooks";

// src/core/routingAdvisor.ts
function failOpenRouting(reason = "routing-unavailable") {
  return { useTokenGraph: false, stage: 0, reason, expectedOverheadTokens: 0, expectedBenefit: "none", enforced: false };
}
var broadTaskPattern = /\b(repository|architecture|migration|security|debug|regression|dependencies|all files|risk)\b/i;
var localActionPattern = /\b(fix|change|update|rename|format|show|find|locate|where is)\b/i;
var relativeSourceLocationPattern = /(?:^|\s|["'`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.\[\]-]+\.(?:cjs|js|jsx|json|md|mjs|sql|ts|tsx|yaml|yml))(?::\d+(?::\d+)?)?/gi;
function boundedExactLocationTask(task) {
  if (!localActionPattern.test(task) || broadTaskPattern.test(task)) return false;
  const locations = [...task.matchAll(relativeSourceLocationPattern)].map((match) => match[1]);
  return locations.length === 1;
}
function boundedTask(task) {
  const normalized = task.trim();
  const singleUsageUpdate = /^update\s+[A-Za-z_$][\w$]*\s+usage\s+in\s+[A-Za-z_$][\w$]*[.!?]?$/i.test(normalized);
  return normalized.length > 0 && normalized.length <= 180 && (/\b(what is|where is|show me|rename|format|explain)\b/i.test(normalized) || /^(find|locate)\b/i.test(normalized) || singleUsageUpdate || boundedExactLocationTask(normalized)) && !broadTaskPattern.test(normalized);
}
function adviseRouting(input) {
  const mode = input.routingMode ?? "shadow";
  const forcedOn = input.routingOverride === "force-on";
  const forcedBypass = input.routingOverride === "force-bypass";
  const killSwitch = input.killSwitch === true;
  if (killSwitch) return failOpenRouting("routing kill switch");
  const bypass = killSwitch || forcedBypass || mode !== "always-activate" && !forcedOn && boundedTask(input.task);
  const useTokenGraph = !bypass && (mode === "always-activate" || forcedOn || !boundedTask(input.task));
  const stage = bypass ? 0 : input.indexAvailable ? 1 : 0;
  const reason = forcedOn ? "routing override force-on" : forcedBypass ? "routing override force-bypass" : bypass ? "bounded-task" : stage === 1 ? "indexed-discovery" : "context-discovery";
  const expectedBenefit = !useTokenGraph ? "none" : stage === 1 ? "high" : "medium";
  return {
    useTokenGraph,
    stage,
    reason,
    expectedOverheadTokens: useTokenGraph ? stage === 1 ? 25 : 80 : 0,
    expectedBenefit,
    enforced: !forcedBypass && Boolean(input.promotion?.enforcementEnabled) && (mode === "enforced" || mode === "always-activate" || forcedOn)
  };
}

// src/core/pairedHost.ts
init_storage();
var MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
var ACCEPTANCE_COMMAND = "node .tokengraph-controller/acceptance.mjs";
var ALLOWED_MCP_ENVIRONMENT = /* @__PURE__ */ new Set(["TOKENGRAPH_TOOL_SURFACE"]);
var APPROVED_VERIFIER_DIRECTORY = "docs/benchmarks/host-evaluations/verifiers";
var APPROVED_VERIFIER_FILE = "plugins/tokengraph/scripts/paired-host-acceptance.mjs";
function hashNumber(value) {
  return Number.parseInt(createHash11("sha256").update(value).digest("hex").slice(0, 12), 16);
}
function sha2562(value) {
  return createHash11("sha256").update(value).digest("hex");
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function containsAbsolutePath(value) {
  if (typeof value === "string") return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  const candidate = record(value);
  return candidate ? Object.values(candidate).some(containsAbsolutePath) : false;
}
function routingFromToolResult(item) {
  if (item.type !== "mcp_tool_call" || item.server !== "tokengraph" || item.tool !== "tokengraph_prepare_context") return void 0;
  const result = record(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type !== "text" || typeof candidate.text !== "string") continue;
    try {
      const payload = record(JSON.parse(candidate.text));
      const routing = record(payload?.routing);
      if (!routing) continue;
      if (typeof routing.useTokenGraph !== "boolean" || routing.stage !== 0 && routing.stage !== 1 || typeof routing.reason !== "string" || !routing.reason || typeof routing.expectedOverheadTokens !== "number" || !Number.isFinite(routing.expectedOverheadTokens) || routing.expectedOverheadTokens < 0 || !["none", "low", "medium", "high"].includes(String(routing.expectedBenefit)) || typeof routing.enforced !== "boolean") continue;
      return routing;
    } catch {
      continue;
    }
  }
  return void 0;
}
function rawReadCommand(command) {
  return typeof command === "string" && /(?:^|\s)(?:Get-Content|type|cat|sed\s+-n)(?:\s|$)/i.test(command);
}
function matchesAcceptanceCommand(recorded, expected) {
  if (typeof recorded !== "string" || expected === void 0) return false;
  if (recorded === expected) return true;
  const windowsWrapper = recorded.match(/^"[a-z]:\\{1,2}windows\\{1,2}system32\\{1,2}windowspowershell\\{1,2}v1\.0\\{1,2}powershell\.exe" -Command '([^'\r\n]*)'$/i);
  return windowsWrapper?.[1] === expected;
}
function parseCodexJsonl(raw, options) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let usage2;
  let finalStatus;
  let failureClass;
  let toolCalls = 0;
  let fallbackRawReads = 0;
  let routing;
  let activationLatencyMs;
  let acceptanceMatches = 0;
  let acceptanceCommandPassed = false;
  let acceptanceInvalidated = false;
  let acceptanceCompletedAt;
  let successfulTerminalAt;
  const startedMcpCalls = /* @__PURE__ */ new Map();
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      const parsed = record(JSON.parse(line));
      if (!parsed || typeof parsed.type !== "string") throw new Error("shape");
      event = parsed;
    } catch {
      throw new Error("Codex JSONL contains an invalid host event.");
    }
    const item = record(event.item);
    if (event.type === "item.started" && item) {
      const mutationCapable = item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "todo_list";
      if (acceptanceCompletedAt !== void 0 && mutationCapable) acceptanceInvalidated = true;
    }
    if (event.type === "item.started" && item?.type === "mcp_tool_call" && typeof item.id === "string") {
      startedMcpCalls.set(item.id, options.lineElapsedMs?.[index] ?? index);
    }
    if (event.type === "item.completed" && item) {
      const mutationCapable = item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "todo_list";
      const matchesAcceptance = item.type === "command_execution" && matchesAcceptanceCommand(item.command, options.acceptanceCommand);
      if (acceptanceMatches > 0 && mutationCapable) acceptanceInvalidated = true;
      if (matchesAcceptance) {
        acceptanceMatches += 1;
        acceptanceCommandPassed = item.status === "completed" && item.exit_code === 0;
        acceptanceCompletedAt = index;
      }
      if (item.type === "command_execution" || item.type === "mcp_tool_call") toolCalls += 1;
      if (item.type === "command_execution" && rawReadCommand(item.command)) fallbackRawReads += 1;
      const observedRouting = routingFromToolResult(item);
      if (observedRouting) {
        routing = observedRouting;
        if (typeof item.id === "string" && startedMcpCalls.has(item.id)) {
          const completedAt = options.lineElapsedMs?.[index] ?? index;
          activationLatencyMs = completedAt - startedMcpCalls.get(item.id);
        }
      }
    }
    if (event.type === "turn.completed") {
      const candidate = record(event.usage);
      const inputTokens = nonNegativeInteger(candidate?.input_tokens);
      const cachedInputTokens = nonNegativeInteger(candidate?.cached_input_tokens);
      const outputTokens = nonNegativeInteger(candidate?.output_tokens);
      const reasoningOutputTokens = nonNegativeInteger(candidate?.reasoning_output_tokens);
      if (inputTokens === void 0 || cachedInputTokens === void 0 || outputTokens === void 0 || reasoningOutputTokens === void 0 || cachedInputTokens > inputTokens) {
        throw new Error("Codex completed without exact host-reported usage.");
      }
      usage2 = { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens: inputTokens + outputTokens };
      if (finalStatus !== "failed") {
        finalStatus = "completed";
        successfulTerminalAt = index;
      }
    } else if (event.type === "turn.failed") {
      finalStatus = "failed";
      failureClass = "host-turn-failed";
    } else if (event.type === "error") {
      finalStatus = "failed";
      failureClass = "host-stream-error";
    }
  }
  if (!finalStatus) throw new Error("Codex JSONL has no terminal host status.");
  if (!usage2 && !(finalStatus === "failed" && options.allowMissingUsageOnFailure)) throw new Error("Codex JSONL has no exact host-reported usage.");
  return {
    modelIdentifier: options.modelIdentifier,
    hostVersion: options.hostVersion,
    ...usage2 ? { usage: usage2 } : {},
    toolCalls,
    fallbackRawReads,
    finalStatus,
    ...failureClass ? { failureClass } : {},
    ...options.acceptanceCommand && options.acceptanceCommandHash ? {
      acceptance: {
        status: acceptanceMatches === 1 && acceptanceCommandPassed && !acceptanceInvalidated && finalStatus === "completed" && acceptanceCompletedAt !== void 0 && successfulTerminalAt !== void 0 && successfulTerminalAt > acceptanceCompletedAt ? "passed" : "failed",
        commandHash: options.acceptanceCommandHash
      }
    } : {},
    ...routing ? { routing } : {},
    ...activationLatencyMs !== void 0 ? { activationLatencyMs } : {}
  };
}
function planPairedHostRuns(tasks, runsPerTask, seed) {
  if (!Number.isInteger(runsPerTask) || runsPerTask < 1) throw new Error("runsPerTask must be a positive integer.");
  const planned = [];
  for (const task of [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    for (let repeat = 1; repeat <= runsPerTask; repeat += 1) {
      const conditionOrder = hashNumber(`${seed}:${task.taskId}:${repeat}`) % 2 === 0 ? "on-first" : "off-first";
      const conditions = conditionOrder === "on-first" ? ["on", "off"] : ["off", "on"];
      for (const condition of conditions) planned.push({ taskId: task.taskId, category: task.category, repeat, condition, conditionOrder });
    }
  }
  return planned;
}
function assertProtocol(value) {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== 2 || typeof candidate.evaluationId !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(candidate.evaluationId) || typeof candidate.seed !== "string" || !candidate.seed || !record(candidate.model) || !record(candidate.plugin) || !record(candidate.promptTemplate) || !record(candidate.tokenGraphMcp) || !record(candidate.acceptance) || !record(candidate.protocol) || !Array.isArray(candidate.tasks) || candidate.tasks.some((task) => !record(task))) {
    throw new Error("Paired host protocol schema is invalid.");
  }
  const typed = value;
  if (typed.reviewed !== void 0 && typeof typed.reviewed !== "boolean" || !typed.tasks.length || new Set(typed.tasks.map((task) => task.taskId)).size !== typed.tasks.length || typeof typed.model.identifier !== "string" || !typed.model.identifier || typeof typed.model.versionOrDate !== "string" || !typed.model.versionOrDate || typeof typed.reasoningLevel !== "string" || !typed.reasoningLevel || typed.approvalPolicy !== "never" || typed.windowsSandbox !== "elevated" || typeof typed.repositoryCommit !== "string" || !/^[a-f0-9]{7,40}$/i.test(typed.repositoryCommit) || typeof typed.plugin.version !== "string" || !typed.plugin.version || typeof typed.plugin.commit !== "string" || !/^[a-f0-9]{40}$/i.test(typed.plugin.commit) || typeof typed.promptTemplate.identifier !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(typed.promptTemplate.identifier) || typeof typed.promptTemplate.template !== "string" || typed.promptTemplate.template.length > 2e4 || !typed.promptTemplate.template.includes("{{task}}") || typeof typed.tokenGraphMcp.command !== "string" || !approvedNodeCommand(typed.tokenGraphMcp.command) || !Array.isArray(typed.tokenGraphMcp.args) || typed.tokenGraphMcp.args.some((entry) => typeof entry !== "string") || typeof typed.acceptance.verifierScript !== "string" || !typed.acceptance.verifierScript || isAbsolute10(typed.acceptance.verifierScript) || typed.acceptance.verifierScript.split(/[\\/]/).includes("..") || !/\.[cm]?js$/i.test(typed.acceptance.verifierScript) || typeof typed.acceptance.verifierCommit !== "string" || !/^[a-f0-9]{40}$/i.test(typed.acceptance.verifierCommit) || typed.dependencySource !== void 0 && (typeof typed.dependencySource !== "string" || isAbsolute10(typed.dependencySource) || typed.dependencySource.split(/[\\/]/).includes("..")) || typeof typed.cacheState !== "string" || !typed.cacheState || !["cold", "warm"].includes(typed.indexState) || !typed.toolConfiguration || typeof typed.toolConfiguration !== "object" || Array.isArray(typed.toolConfiguration) || containsAbsolutePath(typed.toolConfiguration) || typed.tokenGraphMcp.env && Object.entries(typed.tokenGraphMcp.env).some(([key, entry]) => !ALLOWED_MCP_ENVIRONMENT.has(key) || key === "TOKENGRAPH_TOOL_SURFACE" && entry !== "core" && entry !== "full") || !Number.isInteger(typed.protocol.runsPerTask) || typed.protocol.runsPerTask < 1 || !Number.isInteger(typed.protocol.minimumPerCategorySamples) || typed.protocol.minimumPerCategorySamples < 10 || ![typed.protocol.qualityNonInferiorityMargin, typed.protocol.tokenSuperiorityMinimum, typed.protocol.resourceLimit, typed.protocol.executionMedianMinimum, typed.protocol.executionP25Minimum].every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0) || typeof typed.protocol.routerRateMaximum !== "number" || !Number.isFinite(typed.protocol.routerRateMaximum) || typed.protocol.routerRateMaximum <= 0 || typed.protocol.routerRateMaximum > 0.1 || typed.protocol.stage0LatencyMaximumMs !== 5 || typeof typed.protocol.nonNegativeActivatedMinimum !== "number" || !Number.isFinite(typed.protocol.nonNegativeActivatedMinimum) || typed.protocol.nonNegativeActivatedMinimum < 0.8 || typed.protocol.nonNegativeActivatedMinimum > 1 || typed.tasks.some((task) => typeof task.taskId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(task.taskId) || typeof task.category !== "string" || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(task.category) || typeof task.prompt !== "string" || !task.prompt || task.prompt.length > 5e4 || !["none", "low", "medium", "high"].includes(task.expectedBenefit) || !["activate", "bypass"].includes(task.expectedRouting) || task.expectedRouting === "bypass" !== (task.expectedBenefit === "none"))) {
    throw new Error("Paired host protocol fields are invalid.");
  }
  return typed;
}
function approvedNodeCommand(command) {
  if (command === "node" || process.platform === "win32" && command.toLowerCase() === "node.exe") return true;
  if (!isAbsolute10(command)) return false;
  const requested = resolve12(command);
  const controllerRuntime = resolve12(process.execPath);
  return process.platform === "win32" ? requested.toLowerCase() === controllerRuntime.toLowerCase() : requested === controllerRuntime;
}
async function loadPairedHostProtocol(path) {
  return assertProtocol(JSON.parse(await readFile11(path, "utf8")));
}
function beneath(root, candidate) {
  const child = relative11(resolve12(root), resolve12(candidate));
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep3}`) && !isAbsolute10(child);
}
async function runBoundedProcess(command, args, cwd, timeoutMs, stdin, environment) {
  return await new Promise((resolvePromise) => {
    const startedAt = performance.now();
    const child = spawn2(command, args, { cwd, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    const lineElapsedMs = [];
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    let forceKillTimer;
    let settled = false;
    const terminate = () => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 2e3);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
      }
      pendingLine += chunk;
      while (pendingLine.includes("\n")) {
        const newline = pendingLine.indexOf("\n");
        pendingLine = pendingLine.slice(newline + 1);
        lineElapsedMs.push(performance.now() - startedAt);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({ exitCode: null, signal: null, stdout, stderr: "", timedOut, outputLimitExceeded, lineElapsedMs, durationMs: performance.now() - startedAt, spawnFailed: true });
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (pendingLine.trim()) lineElapsedMs.push(performance.now() - startedAt);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, outputLimitExceeded, lineElapsedMs, durationMs: performance.now() - startedAt, spawnFailed: false });
    });
    if (stdin !== void 0) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
var runProcess = runBoundedProcess;
function isolatedHostEnvironment() {
  const environment = { ...process.env };
  for (const name of ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_PERMISSION_PROFILE", "CODEX_SHELL", "CODEX_THREAD_ID"]) delete environment[name];
  return environment;
}
async function git2(root, args) {
  const result = await runProcess("git", args, root, 3e4);
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed.`);
  return result.stdout.trim();
}
async function ensureLocalRunExclusion(root) {
  const pathValue = await git2(root, ["rev-parse", "--git-path", "info/exclude"]);
  const path = isAbsolute10(pathValue) ? pathValue : resolve12(root, pathValue);
  const current = await readFile11(path, "utf8").catch(() => "");
  if (!current.split(/\r?\n/).includes(".tokengraph/")) await writeFile2(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.tokengraph/
`);
}
function renderPrompt(template, task) {
  return template.replaceAll("{{task}}", task.prompt);
}
function tomlString(value) {
  return JSON.stringify(value);
}
function tomlArray(values) {
  return `[${values.map(tomlString).join(",")}]`;
}
function tomlInlineTable(entries) {
  return `{${entries.map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(",")}}`;
}
function modelShellEnvironment(worktree) {
  const temporaryDirectory = resolve12(worktree, ".tokengraph-tmp");
  const pathValue = process.env.PATH ?? process.env.Path ?? dirname9(process.execPath);
  const environment = process.platform === "win32" ? {
    PATH: pathValue,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
    COMSPEC: process.env.COMSPEC ?? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory
  } : {
    PATH: pathValue,
    HOME: resolve12(worktree, ".tokengraph-home"),
    TMPDIR: temporaryDirectory,
    LANG: "C.UTF-8"
  };
  return environment;
}
function permissionFilesystem(gitCommonDirectory2, dependencySource, mcpRuntimePaths) {
  const workspaceRules = tomlInlineTable([
    [".", "write"],
    [".git", "read"],
    [".tokengraph-controller", "read"]
  ]);
  const rules = [
    `${tomlString(":root")}=${tomlString("deny")}`,
    `${tomlString(":minimal")}=${tomlString("read")}`,
    `${tomlString(":workspace_roots")}=${workspaceRules}`,
    `${tomlString(gitCommonDirectory2)}=${tomlString("read")}`,
    ...dependencySource ? [`${tomlString(dependencySource)}=${tomlString("read")}`] : [],
    ...[...new Set(mcpRuntimePaths)].map((path) => `${tomlString(path)}=${tomlString("read")}`)
  ];
  return `{${rules.join(",")}}`;
}
function samePath(left, right) {
  const normalizedLeft = resolve12(left);
  const normalizedRight = resolve12(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}
function approvedVerifierPath(root, candidate) {
  return beneath(resolve12(root, APPROVED_VERIFIER_DIRECTORY), candidate) || samePath(resolve12(root, APPROVED_VERIFIER_FILE), candidate);
}
async function verifierSource(root, verifierScript, verifierCommit) {
  const requested = resolve12(root, verifierScript);
  if (!beneath(root, requested)) throw new Error("Acceptance verifier escaped the supplied evaluation root.");
  if (!approvedVerifierPath(root, requested)) throw new Error("Acceptance verifier must use an approved verifier location.");
  const exactVerifierCommit = await git2(root, ["rev-parse", `${verifierCommit}^{commit}`]);
  if (exactVerifierCommit.toLowerCase() !== verifierCommit.toLowerCase()) throw new Error("Protocol verifier commit is not exact.");
  const verifierGitPath = relative11(root, requested).split(sep3).join("/");
  const trackedVerifier = await runProcess("git", ["cat-file", "-e", `${exactVerifierCommit}:${verifierGitPath}`], root, 3e4);
  if (trackedVerifier.spawnFailed || trackedVerifier.exitCode !== 0) throw new Error("Acceptance verifier is not tracked by the attested verifier commit.");
  const verifierType = await runProcess("git", ["cat-file", "-t", `${exactVerifierCommit}:${verifierGitPath}`], root, 3e4);
  if (verifierType.spawnFailed || verifierType.exitCode !== 0 || verifierType.stdout.trim() !== "blob") throw new Error("Acceptance verifier must be an attested regular-file blob.");
  const verifierSize = await runProcess("git", ["cat-file", "-s", `${exactVerifierCommit}:${verifierGitPath}`], root, 3e4);
  const size = Number.parseInt(verifierSize.stdout.trim(), 10);
  if (verifierSize.spawnFailed || verifierSize.exitCode !== 0 || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024) throw new Error("Acceptance verifier must be a bounded regular-file blob.");
  const verifierBlob = await runProcess("git", ["cat-file", "-p", `${exactVerifierCommit}:${verifierGitPath}`], root, 3e4);
  if (verifierBlob.spawnFailed || verifierBlob.exitCode !== 0) throw new Error("Acceptance verifier blob could not be read from its attested commit.");
  const content = Buffer.from(verifierBlob.stdout, "utf8");
  if (content.byteLength !== size) throw new Error("Acceptance verifier blob size did not match its attested metadata.");
  return { path: requested, content, commandHash: sha2562(content) };
}
async function installVerifier(worktree, verifier) {
  const directory = resolve12(worktree, ".tokengraph-controller");
  const target = resolve12(directory, "acceptance.mjs");
  await assertNoSymbolicLinkComponents(target);
  await mkdir5(directory, { recursive: true });
  await assertNoSymbolicLinkComponents(target);
  try {
    const handle = await open8(target, "wx", 256);
    try {
      await handle.writeFile(verifier.content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Acceptance verifier target already exists.");
    throw error;
  }
  if (sha2562(await readFile11(target)) !== verifier.commandHash) throw new Error("Copied acceptance verifier hash does not match its validated source.");
  await chmod6(target, 292);
}
function acceptancePrompt(prompt) {
  return `${prompt}

After completing all edits and checks, run exactly this as the final mutation-capable command: ${ACCEPTANCE_COMMAND}
Do not run any command, MCP tool, or file mutation after it. A final prose response is allowed.
`;
}
function resolveMcp(root, mcp) {
  return {
    command: process.execPath,
    args: mcp.args.map((arg) => arg.endsWith(".js") && !isAbsolute10(arg) ? resolve12(root, arg) : arg),
    ...mcp.env ? { env: mcp.env } : {}
  };
}
function measureRouting(task, indexState) {
  const startedAt = performance.now();
  const decision = adviseRouting({ task: task.prompt, routingMode: "shadow", indexAvailable: indexState === "warm" });
  return { decision, latencyMs: performance.now() - startedAt };
}
function routingObservation(task, measured, parsed) {
  const actual = parsed.routing ?? measured.decision;
  const decision = actual.useTokenGraph ? "activate" : "bypass";
  if (decision === "activate" && (!parsed.routing || parsed.activationLatencyMs === void 0 || parsed.activationLatencyMs <= measured.latencyMs)) {
    throw new Error("ON run did not emit monotonic TokenGraph activation evidence.");
  }
  return {
    mode: "shadow",
    decision,
    stage: actual.stage,
    reason: actual.reason,
    expectedOverheadTokens: actual.expectedOverheadTokens,
    expectedBenefit: actual.expectedBenefit,
    expectedRouting: task.expectedRouting,
    routingLatencyMs: measured.latencyMs,
    ...decision === "activate" ? { activationLatencyMs: parsed.activationLatencyMs } : {},
    falseBypass: task.expectedRouting === "activate" && decision === "bypass",
    falseActivation: task.expectedRouting === "bypass" && decision === "activate"
  };
}
function reviewedTrace(run, task, parsed, hostSucceeded, commandHash, measuredRouting) {
  if (!parsed.usage) throw new Error("Cannot emit a reviewed trace without exact host usage.");
  const acceptancePassed = parsed.acceptance?.status === "passed" && parsed.acceptance.commandHash === commandHash;
  const successful = hostSucceeded && parsed.finalStatus === "completed" && acceptancePassed;
  return {
    taskId: run.taskId,
    category: run.category,
    condition: run.condition,
    repeat: run.repeat,
    conditionOrder: run.conditionOrder,
    usageSource: "host",
    acceptance: { status: acceptancePassed ? "passed" : "failed", commandHash },
    tokens: parsed.usage.totalTokens,
    executionInclusiveTokens: parsed.usage.totalTokens,
    inputTokens: parsed.usage.inputTokens,
    cachedInputTokens: parsed.usage.cachedInputTokens,
    outputTokens: parsed.usage.outputTokens,
    reasoningOutputTokens: parsed.usage.reasoningOutputTokens,
    toolCalls: parsed.toolCalls,
    fallbackRawReads: parsed.fallbackRawReads,
    quality: successful ? 1 : 0,
    timedOut: false,
    failed: !successful,
    resourceUnits: parsed.toolCalls,
    ...run.condition === "on" && measuredRouting ? { routing: routingObservation(task, measuredRouting, parsed) } : {}
  };
}
function emptyProcessResult() {
  return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false, lineElapsedMs: [], durationMs: 0, spawnFailed: false };
}
async function cleanupWorktree(root, worktreeRoot, worktree) {
  if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe worktree cleanup.");
  try {
    await git2(root, ["worktree", "remove", "--force", worktree]);
  } catch {
    if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe worktree cleanup.");
    await rm5(worktree, { recursive: true, force: true });
    await git2(root, ["worktree", "prune"]);
    return;
  }
  try {
    await access2(worktree);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!beneath(worktreeRoot, worktree)) throw new Error("Refusing unsafe residual cleanup.");
  await rm5(worktree, { recursive: true, force: true });
}
async function durableRunArtifacts(rawPath, normalizedPath, worktree, run, identity2) {
  try {
    const raw = await readFile11(rawPath, "utf8");
    const normalized = record(JSON.parse(await readFile11(normalizedPath, "utf8")));
    const marker = record(JSON.parse(await readFile11(resolve12(worktree, ".tokengraph-controller", "run.json"), "utf8")));
    return normalized?.schemaVersion === 2 && normalized.durable === true && marker?.schemaVersion === 1 && typeof normalized.executionId === "string" && normalized.executionId.length > 0 && marker.executionId === normalized.executionId && normalized.evaluationId === identity2.evaluationId && marker.evaluationId === identity2.evaluationId && normalized.repositoryCommit === identity2.repositoryCommit && marker.repositoryCommit === identity2.repositoryCommit && normalized.rawSha256 === sha2562(raw) && normalized.taskId === run.taskId && marker.taskId === run.taskId && normalized.repeat === run.repeat && marker.repeat === run.repeat && normalized.condition === run.condition && marker.condition === run.condition;
  } catch {
    return false;
  }
}
async function recoverStaleWorktree(root, worktreeRoot, worktree, rawPath, normalizedPath, run, identity2) {
  try {
    await access2(worktree);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!await durableRunArtifacts(rawPath, normalizedPath, worktree, run, identity2)) {
    throw new Error(`Refusing to remove non-durable stale worktree for ${run.taskId} repeat ${run.repeat} ${run.condition}.`);
  }
  await cleanupWorktree(root, worktreeRoot, worktree);
}
async function runPairedHostEvaluation(options) {
  const root = resolve12(options.root);
  const controllerRoot = resolve12(options.controllerRoot ?? options.root);
  const protocol = assertProtocol(options.protocol);
  const commit = await git2(root, ["rev-parse", `${protocol.repositoryCommit}^{commit}`]);
  if (!commit.toLowerCase().startsWith(protocol.repositoryCommit.toLowerCase())) throw new Error("Protocol repository commit is not exact.");
  const plan = planPairedHostRuns(protocol.tasks, protocol.protocol.runsPerTask, protocol.seed);
  const hostExecutable = options.hostExecutable ?? "codex";
  const hostArgumentsPrefix = options.hostArgumentsPrefix ?? [];
  const hostEnvironment = isolatedHostEnvironment();
  const pluginCommit = await git2(controllerRoot, ["rev-parse", `${protocol.plugin.commit}^{commit}`]);
  if (pluginCommit.toLowerCase() !== protocol.plugin.commit.toLowerCase()) throw new Error("Protocol plugin commit is not exact.");
  const verifier = await verifierSource(controllerRoot, protocol.acceptance.verifierScript, protocol.acceptance.verifierCommit);
  const version = await runProcess(hostExecutable, [...hostArgumentsPrefix, "--version"], root, 1e4, void 0, hostEnvironment);
  if (version.spawnFailed || version.exitCode !== 0 || !/^codex-cli\s+\S+/i.test(version.stdout.trim())) throw new Error("Codex host version could not be verified.");
  const hostVersion = version.stdout.trim();
  if (options.dryRun) return { manifest: null, plan, hostVersion };
  if (!options.outputManifest) throw new Error("An output manifest path is required for a live host evaluation.");
  const outputManifest = isAbsolute10(options.outputManifest) ? resolve12(options.outputManifest) : resolve12(controllerRoot, options.outputManifest);
  if (!beneath(controllerRoot, outputManifest)) throw new Error("Reviewed manifest must remain beneath the controller root.");
  await assertNoSymbolicLinkComponents(outputManifest);
  await ensureLocalRunExclusion(root);
  const evaluationRoot = resolve12(root, ".tokengraph", "runs", "paired-host", protocol.evaluationId);
  const worktreeRoot = resolve12(evaluationRoot, "worktrees");
  const rawRoot = resolve12(evaluationRoot, "raw");
  const normalizedRoot = resolve12(evaluationRoot, "normalized");
  if (!beneath(root, evaluationRoot) || !beneath(evaluationRoot, worktreeRoot)) throw new Error("Paired host storage escaped its verified root.");
  await mkdir5(worktreeRoot, { recursive: true });
  await mkdir5(rawRoot, { recursive: true });
  await mkdir5(normalizedRoot, { recursive: true });
  const traces = [];
  const gitCommonValue = await git2(root, ["rev-parse", "--git-common-dir"]);
  const gitCommonDirectory2 = isAbsolute10(gitCommonValue) ? resolve12(gitCommonValue) : resolve12(root, gitCommonValue);
  const dependencySource = protocol.dependencySource ? resolve12(root, protocol.dependencySource) : void 0;
  const resolvedMcp = resolveMcp(controllerRoot, protocol.tokenGraphMcp);
  const mcpRuntimePaths = resolvedMcp.args.filter(isAbsolute10);
  for (const runtimePath of mcpRuntimePaths) {
    if (!beneath(controllerRoot, runtimePath)) throw new Error("TokenGraph MCP runtime must remain beneath the controller root.");
    const runtimeGitPath = relative11(controllerRoot, runtimePath).split(sep3).join("/");
    const trackedRuntime = await runProcess("git", ["cat-file", "-e", `${pluginCommit}:${runtimeGitPath}`], controllerRoot, 3e4);
    if (trackedRuntime.spawnFailed || trackedRuntime.exitCode !== 0) throw new Error("TokenGraph MCP runtime is not tracked by the attested plugin commit.");
    const runtimeDiff = await runProcess("git", ["diff", "--quiet", pluginCommit, "--", runtimeGitPath], controllerRoot, 3e4);
    if (runtimeDiff.spawnFailed || runtimeDiff.exitCode !== 0) throw new Error("TokenGraph MCP runtime does not match the attested plugin commit.");
  }
  for (const run of plan) {
    const task = protocol.tasks.find((candidate) => candidate.taskId === run.taskId);
    const runName = `${run.taskId}-repeat-${run.repeat}-${run.condition}`;
    const worktree = resolve12(worktreeRoot, runName);
    const rawPath = resolve12(rawRoot, `${runName}.jsonl`);
    const normalizedPath = resolve12(normalizedRoot, `${runName}.json`);
    if (!beneath(worktreeRoot, worktree)) throw new Error("Generated worktree escaped its verified root.");
    const runIdentity = { evaluationId: protocol.evaluationId, repositoryCommit: commit };
    await recoverStaleWorktree(root, worktreeRoot, worktree, rawPath, normalizedPath, run, runIdentity);
    try {
      await git2(root, ["worktree", "add", "--detach", worktree, commit]);
    } catch {
      const normalized = {
        schemaVersion: 2,
        durable: true,
        taskId: run.taskId,
        repeat: run.repeat,
        condition: run.condition,
        host: { exitCode: null, timedOut: false, outputLimitExceeded: false, durationMs: 0, finalStatus: "failed", failureClass: "worktree-create-failed" },
        acceptance: { status: "failed", commandHash: verifier.commandHash }
      };
      await writeTextAtomic(rawPath, "", { telemetry: { root, storageClass: "runs" } });
      await writeJsonAtomic(normalizedPath, normalized, { telemetry: { root, storageClass: "runs" } });
      throw new Error(`${runName} worktree creation failed.`);
    }
    let durable = false;
    const executionId = randomUUID6();
    try {
      let phaseFailure;
      try {
        await writeJsonAtomic(resolve12(worktree, ".tokengraph-controller", "run.json"), {
          schemaVersion: 1,
          ...runIdentity,
          executionId,
          taskId: run.taskId,
          repeat: run.repeat,
          condition: run.condition
        }, { telemetry: { root, storageClass: "runs" } });
      } catch {
        phaseFailure = "evidence-provisioning-failed";
      }
      if (!phaseFailure && protocol.dependencySource && dependencySource) {
        const dependencyTarget = resolve12(worktree, protocol.dependencySource);
        try {
          if (!beneath(root, dependencySource) || !beneath(worktree, dependencyTarget)) throw new Error("Dependency provisioning escaped its verified root.");
          await access2(dependencySource);
          await mkdir5(dirname9(dependencyTarget), { recursive: true });
          await symlink(dependencySource, dependencyTarget, process.platform === "win32" ? "junction" : "dir");
        } catch {
          phaseFailure = "dependency-provisioning-failed";
        }
      }
      if (!phaseFailure) {
        try {
          await installVerifier(worktree, verifier);
          await mkdir5(resolve12(worktree, ".tokengraph-tmp"), { recursive: true });
          if (process.platform !== "win32") await mkdir5(resolve12(worktree, ".tokengraph-home"), { recursive: true });
        } catch {
          phaseFailure = "acceptance-provisioning-failed";
        }
      }
      let host = emptyProcessResult();
      let parsed;
      let parseFailure;
      const measuredRouting = run.condition === "on" ? measureRouting(task, protocol.indexState) : void 0;
      const args = [
        ...hostArgumentsPrefix,
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--model",
        protocol.model.identifier,
        "--cd",
        worktree,
        "--config",
        `model_reasoning_effort=${tomlString(protocol.reasoningLevel)}`,
        "--config",
        `approval_policy=${tomlString(protocol.approvalPolicy)}`,
        "--config",
        `windows.sandbox=${tomlString(protocol.windowsSandbox)}`,
        "--config",
        `default_permissions=${tomlString("tokengraph-eval")}`,
        "--config",
        `permissions.tokengraph-eval.filesystem=${permissionFilesystem(gitCommonDirectory2, dependencySource, mcpRuntimePaths)}`,
        "--config",
        "permissions.tokengraph-eval.network.enabled=false",
        "--config",
        `shell_environment_policy.inherit=${tomlString("none")}`,
        "--config",
        `shell_environment_policy.set=${tomlInlineTable(Object.entries(modelShellEnvironment(worktree)).sort(([left], [right]) => left.localeCompare(right)))}`
      ];
      if (run.condition === "on") {
        args.push("--config", `mcp_servers.tokengraph.command=${tomlString(resolvedMcp.command)}`);
        args.push("--config", `mcp_servers.tokengraph.args=${tomlArray(resolvedMcp.args)}`);
        const mcpEnvironment = { ...resolvedMcp.env ?? {}, TOKENGRAPH_WORKSPACE_ROOT: worktree };
        args.push("--config", `mcp_servers.tokengraph.env=${tomlInlineTable(Object.entries(mcpEnvironment).sort(([left], [right]) => left.localeCompare(right)))}`);
      }
      args.push("-");
      if (!phaseFailure) {
        host = await runProcess(hostExecutable, args, worktree, options.timeoutMs ?? 30 * 6e4, acceptancePrompt(renderPrompt(protocol.promptTemplate.template, task)), hostEnvironment);
        try {
          parsed = parseCodexJsonl(host.stdout, {
            modelIdentifier: protocol.model.identifier,
            hostVersion,
            allowMissingUsageOnFailure: true,
            lineElapsedMs: host.lineElapsedMs,
            acceptanceCommand: ACCEPTANCE_COMMAND,
            acceptanceCommandHash: verifier.commandHash
          });
        } catch {
          parseFailure = "invalid-host-stream";
        }
      }
      let trace;
      let routingFailure;
      if (!phaseFailure && !host.spawnFailed && !host.timedOut && !host.outputLimitExceeded && parsed?.usage) {
        try {
          trace = reviewedTrace(run, task, parsed, host.exitCode === 0, verifier.commandHash, measuredRouting);
        } catch {
          routingFailure = "routing-evidence-invalid";
        }
      }
      const failureClass = phaseFailure ?? (host.spawnFailed ? "host-spawn-failed" : void 0) ?? (host.timedOut ? "host-timeout" : void 0) ?? (host.outputLimitExceeded ? "host-output-limit" : void 0) ?? parseFailure ?? routingFailure ?? parsed?.failureClass ?? (host.exitCode !== 0 ? "host-exit-nonzero" : void 0) ?? null;
      const normalized = {
        schemaVersion: 2,
        durable: true,
        ...runIdentity,
        executionId,
        rawSha256: sha2562(host.stdout),
        taskId: run.taskId,
        repeat: run.repeat,
        condition: run.condition,
        host: { exitCode: host.exitCode, timedOut: host.timedOut, outputLimitExceeded: host.outputLimitExceeded, durationMs: host.durationMs, finalStatus: parsed?.finalStatus ?? "failed", failureClass },
        acceptance: { status: parsed?.acceptance?.status ?? "failed", commandHash: verifier.commandHash }
      };
      await writeTextAtomic(rawPath, host.stdout, { telemetry: { root, storageClass: "runs" } });
      await writeJsonAtomic(normalizedPath, normalized, { telemetry: { root, storageClass: "runs" } });
      durable = await durableRunArtifacts(rawPath, normalizedPath, worktree, run, runIdentity);
      if (!durable) throw new Error(`${runName} evidence artifacts are not durable.`);
      if (phaseFailure === "evidence-provisioning-failed") throw new Error(`${runName} evidence provisioning failed.`);
      if (phaseFailure === "dependency-provisioning-failed") throw new Error(`${runName} dependency provisioning failed.`);
      if (phaseFailure === "acceptance-provisioning-failed") throw new Error(`${runName} acceptance verifier provisioning failed.`);
      if (host.spawnFailed || host.timedOut || host.outputLimitExceeded || !parsed?.usage) throw new Error(`${runName} did not produce a complete exact-usage host trace.`);
      if (routingFailure || !trace) throw new Error(`${runName} routing evidence is invalid.`);
      traces.push(trace);
    } finally {
      if (durable) await cleanupWorktree(root, worktreeRoot, worktree);
    }
  }
  const manifest = parseEvaluationManifest({
    schemaVersion: 3,
    evidenceSource: "real-host",
    reviewed: protocol.reviewed === true,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    seed: protocol.seed,
    model: protocol.model,
    reasoningLevel: protocol.reasoningLevel,
    host: { name: "codex", version: hostVersion },
    plugin: protocol.plugin,
    repositoryCommit: commit,
    promptTemplate: protocol.promptTemplate.identifier,
    promptTemplateHash: sha2562(protocol.promptTemplate.template),
    toolConfiguration: protocol.toolConfiguration,
    cacheState: protocol.cacheState,
    indexState: protocol.indexState,
    protocol: protocol.protocol,
    tasks: protocol.tasks.map(({ taskId, category, expectedQuality }) => ({ taskId, category, ...expectedQuality !== void 0 ? { expectedQuality } : {} })),
    traces
  });
  await mkdir5(dirname9(outputManifest), { recursive: true });
  await writeJsonAtomic(outputManifest, manifest, { telemetry: { root, storageClass: "durable" } });
  return { manifest, plan, hostVersion };
}

// src/cli.ts
init_repositoryIdentity();
init_legacyRuntimeActivation();
init_storage();
var LEGACY_RUNTIME_ROLLOUT = "Every TokenGraph v0.23.1 MCP and CLI process must be stopped before v2 activation and must not be restarted while v2 runs.";
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
function boundedCliErrorMessage(error) {
  const clean = (value) => (value instanceof Error ? value.message : String(value)).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 512);
  if (!(error instanceof AggregateError)) return clean(error);
  const causes = [...error.errors].slice(0, 8).map((cause, index) => `cause ${index + 1}: ${clean(cause)}`);
  return [clean(error), ...causes].join("\n");
}
function activateConfirmedInvocation(options, usage2) {
  if (!options.includes("--confirm-no-legacy-processes")) {
    throw new Error(`${usage2} This lock-taking command requires --confirm-no-legacy-processes. ${LEGACY_RUNTIME_ROLLOUT}`);
  }
  activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true });
}
async function main(argv) {
  let telemetryRoot;
  try {
    if (argv[0] === "doctor") {
      const options2 = argv.slice(1);
      const usage2 = "Usage: tokengraph doctor [--root <path>] [--json]";
      if (options2.length === 1 && options2[0] === "--help") {
        process.stdout.write(`${usage2}
`);
        return;
      }
      let rootOption;
      let json = false;
      for (let index = 0; index < options2.length; index += 1) {
        const option = options2[index];
        if (option === "--json") {
          if (json) throw new Error(usage2);
          json = true;
          continue;
        }
        if (option === "--root") {
          const candidate = options2[index + 1];
          if (rootOption !== void 0 || !candidate || candidate.startsWith("--")) throw new Error(usage2);
          rootOption = candidate;
          index += 1;
          continue;
        }
        throw new Error(usage2);
      }
      const root2 = await realpath4(rootOption ?? process.cwd());
      const pluginRoot = resolve13(dirname10(fileURLToPath2(import.meta.url)), "..");
      const report = await collectDoctorReport({ workspace: { status: "ready", source: "cli-root", root: root2 }, pluginRoot });
      process.stdout.write(json ? `${JSON.stringify(report)}
` : `${formatDoctorReport(report)}
`);
      return;
    }
    if (argv[0] === "evaluate-host") {
      const options2 = argv.slice(1);
      const usage2 = "Usage: tokengraph evaluate-host [--root <path>] [--controller-root <path>] --protocol <path> [--output-manifest <path>] [--codex <executable>] [--timeout-ms <n>] [--dry-run] [--confirm-no-legacy-processes]";
      if (options2.includes("--help")) {
        process.stdout.write(`${usage2}
`);
        return;
      }
      const root2 = optionValue(options2, "--root") ?? process.cwd();
      telemetryRoot = root2;
      const protocolPath = optionValue(options2, "--protocol");
      if (!protocolPath) throw new Error(usage2);
      const timeoutMs2 = Number(optionValue(options2, "--timeout-ms") ?? 30 * 6e4);
      if (!Number.isFinite(timeoutMs2) || timeoutMs2 < 1) throw new Error("evaluate-host --timeout-ms must be a positive number.");
      if (!options2.includes("--dry-run")) activateConfirmedInvocation(options2, usage2);
      const result = await runPairedHostEvaluation({
        root: root2,
        ...optionValue(options2, "--controller-root") ? { controllerRoot: optionValue(options2, "--controller-root") } : {},
        protocol: await loadPairedHostProtocol(protocolPath),
        ...optionValue(options2, "--output-manifest") ? { outputManifest: optionValue(options2, "--output-manifest") } : {},
        ...optionValue(options2, "--codex") ? { hostExecutable: optionValue(options2, "--codex") } : {},
        timeoutMs: timeoutMs2,
        dryRun: options2.includes("--dry-run")
      });
      process.stdout.write(`${JSON.stringify(options2.includes("--dry-run") ? { dryRun: true, hostVersion: result.hostVersion, runs: result.plan } : { manifest: result.manifest, hostVersion: result.hostVersion })}
`);
      return;
    }
    if (argv[0] === "evaluate-routing") {
      const options2 = argv.slice(1);
      activateConfirmedInvocation(options2, "Usage: tokengraph evaluate-routing [--root <path>] --manifest <path> --confirm-no-legacy-processes");
      const root2 = optionValue(options2, "--root") ?? process.cwd();
      telemetryRoot = root2;
      const manifestPath = optionValue(options2, "--manifest");
      if (!manifestPath) throw new Error("Usage: tokengraph evaluate-routing [--root <path>] --manifest <path>");
      const report = evaluateManifest(await loadEvaluationManifest(manifestPath));
      const promotion = await persistPromotionReport(root2, report);
      process.stdout.write(`${JSON.stringify({ ...report, promotion })}
`);
      if (!report.enforcementEnabled) process.exitCode = 1;
      return;
    }
    if (argv[0] === "purge") {
      const options2 = argv.slice(1);
      activateConfirmedInvocation(options2, "Usage: tokengraph purge [--root <path>] --class runs|cache|outcomes|derived --confirm-no-legacy-processes");
      const root2 = optionValue(options2, "--root") ?? process.cwd();
      telemetryRoot = root2;
      const storageClass = optionValue(options2, "--class");
      if (!storageClass || !["runs", "cache", "outcomes", "derived"].includes(storageClass)) {
        throw new Error("Usage: tokengraph purge [--root <path>] --class runs|cache|outcomes|derived");
      }
      process.stdout.write(`${JSON.stringify(await purgeStorageClass(root2, storageClass, {
        confirmedNoLegacyTokenGraphProcesses: true
      }))}
`);
      return;
    }
    if (argv[0] !== "run") throw new Error(`${LEGACY_RUNTIME_ROLLOUT} Usage: tokengraph doctor [--root <path>] [--json]; tokengraph run [--root <path>] [--task-id <uuid>] [--timeout-ms <n>] [--max-bytes <n>] [--test <name>] [--file <path>] [--error-class <name>] --confirm-no-legacy-processes -- <command> [args...]; tokengraph purge [--root <path>] --class runs|cache|outcomes|derived --confirm-no-legacy-processes; tokengraph evaluate-routing [--root <path>] --manifest <path> --confirm-no-legacy-processes; or tokengraph evaluate-host --protocol <path> [--dry-run].`);
    const separator = argv.indexOf("--");
    if (separator < 0 || separator === argv.length - 1) throw new Error("tokengraph run requires `-- <command> [args...]`.");
    const commandArgs = argv.slice(separator + 1);
    const options = argv.slice(1, separator);
    activateConfirmedInvocation(options, "Usage: tokengraph run [options] --confirm-no-legacy-processes -- <command> [args...]");
    const root = optionValue(options, "--root") ?? process.cwd();
    telemetryRoot = root;
    const taskId = optionValue(options, "--task-id");
    const config = await loadTokenGraphConfig(root);
    const timeoutMs = Number(optionValue(options, "--timeout-ms") ?? config.runner.timeoutMs);
    const maxBytes = Number(optionValue(options, "--max-bytes") ?? config.runner.maxBytes);
    const metadata = {
      ...optionValue(options, "--test") ? { test: optionValue(options, "--test") } : {},
      ...optionValue(options, "--file") ? { file: optionValue(options, "--file") } : {},
      ...optionValue(options, "--error-class") ? { errorClass: optionValue(options, "--error-class") } : {}
    };
    const taskIdentity = taskId ? (await requireOpenTaskForOutcome(root, taskId), await getRepositoryIdentity(root)) : void 0;
    const retentionCutoff = () => new Date(Date.now() - config.storage.runRetentionDays * 24 * 60 * 60 * 1e3);
    await purgeRuns(root, retentionCutoff());
    const run = await executeRun({ root, command: commandArgs[0], args: commandArgs.slice(1), timeoutMs, maxBytes, ...Object.keys(metadata).length ? { metadata } : {} });
    await assertStorageWriteAllowed(root, "runs", Buffer.byteLength(`${JSON.stringify(run, null, 2)}
`, "utf8"), config.storage);
    await saveRun(root, run);
    if (taskId && taskIdentity) {
      try {
        await recordTaskOutcome(root, taskId, taskOutcomeFromRun(run, taskId, taskIdentity));
      } catch (error) {
        process.stderr.write(`Run ${run.runId} was saved but was not linked to task ${taskId}: ${error instanceof Error ? error.message : String(error)}
`);
      }
    }
    await purgeRuns(root, retentionCutoff());
    process.stdout.write(`${JSON.stringify({ ...summarizeRun(run), stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated })}
`);
    if (run.status !== "completed") process.exitCode = run.status === "timed-out" ? 124 : 1;
  } finally {
    if (telemetryRoot) {
      try {
        await flushWriteTelemetry(telemetryRoot);
      } catch {
        process.stderr.write("TokenGraph warning: write-telemetry-flush-failed\n");
      }
    }
  }
}
var cliKeepAlive = setInterval(() => void 0, 1e3);
void main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${boundedCliErrorMessage(error)}
`);
  process.exitCode = 2;
}).finally(() => {
  clearInterval(cliKeepAlive);
});
