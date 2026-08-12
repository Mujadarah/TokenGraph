#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { formatTaskReportFooter } from "./core/taskEstimator.js";
import {
  compareHostWorkspaceStatSnapshots,
  attestHostWorkspace,
  loadHostWorkspaceAttestation,
  removeHostWorkspaceAttestation,
  type HostWorkspaceStatSnapshot
} from "./core/hostWorkspace.js";
import { inspectTaskLedgerReadOnly } from "./core/taskLedger.js";

const POINTER_SCHEMA_ID = "tokengraph-hook-session" as const;
const POINTER_SCHEMA_VERSION = 2 as const;
const POINTER_MAX_BYTES = 16 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const POINTER_RETENTION_NS = 30n * 24n * 60n * 60n * 1_000_000_000n;
const FUTURE_TOLERANCE_NS = 5n * 60n * 1_000_000_000n;
const INPUT_MAX_BYTES = 1024 * 1024;
const DECISION_MAX_CHARACTERS = 4 * 1024;
const POINTER_REPLACE_ATTEMPTS = 16;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMP_PATTERN = /^\.tg-pointer-[0-9a-f]{64}-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const EVENT_PAIRS: ReadonlyMap<string, string> = new Map([
  ["session-start", "SessionStart"], ["user-prompt-submit", "UserPromptSubmit"],
  ["session-end", "SessionEnd"], ["post-tool-use", "PostToolUse"], ["stop", "Stop"]
] as const);
const TASK_AWARE_TOOLS = new Set([
  "tokengraph_prepare_context", "tokengraph_query_context", "tokengraph_compress",
  "tokengraph_recall", "tokengraph_analyze", "tokengraph_propose_knowledge", "tokengraph_task_report"
]);

interface SessionPointerV2 {
  schemaId: typeof POINTER_SCHEMA_ID;
  schemaVersion: typeof POINTER_SCHEMA_VERSION;
  sessionHash: string;
  taskId: string;
  turnId: string;
  updatedAt: string;
}

type PointerInspection =
  | { status: "valid"; pointer: Readonly<SessionPointerV2>; entry: FileIdentity }
  | { status: "missing" | "invalid" | "unsupported" | "expired" | "mismatched" | "unstable"; entry?: FileIdentity };
type HookOutput = Record<string, unknown>;

type FileIdentity = HostWorkspaceStatSnapshot;
// Host plugin-data directory for session pointers, not workspace .tokengraph state.
interface HookStorage { pluginRoot: string; pluginIdentity: FileIdentity; dataRoot: string; dataIdentity: FileIdentity }
interface SessionStorage extends HookStorage { sessions: string; sessionsIdentity: FileIdentity }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function fileIdentity(stats: BigIntStats): FileIdentity {
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

function sameObject(left: FileIdentity, right: FileIdentity): boolean { return compareHostWorkspaceStatSnapshots(left, right, "directory"); }
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return compareHostWorkspaceStatSnapshots(left, right, "file");
}
function sameRenamedFile(left: FileIdentity, right: FileIdentity): boolean {
  return compareHostWorkspaceStatSnapshots(left, right, "rename");
}

async function ordinaryDirectory(path: string): Promise<FileIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe-directory");
  return fileIdentity(stats);
}

function warning(message: string): HookOutput { return { systemMessage: message.slice(0, 512) }; }

function containsConfirmationLikeField(input: Record<string, unknown>): boolean {
  const pending: unknown[] = [input];
  for (let index = 0; index < pending.length; index += 1) {
    const value = pending[index];
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (/confirm.*legacy|legacy.*confirm/i.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

async function resolvePair(rootKey: string, dataKey: string): Promise<HookStorage | undefined> {
  const rootValue = process.env[rootKey];
  const dataValue = process.env[dataKey];
  if (rootValue === undefined && dataValue === undefined) return undefined;
  if (!isIdentifier(rootValue) || !isIdentifier(dataValue) || !isAbsolute(rootValue) || !isAbsolute(dataValue)) throw new Error("invalid-host-storage");
  await Promise.all([ordinaryDirectory(rootValue), ordinaryDirectory(dataValue)]);
  const [pluginRoot, dataRoot] = await Promise.all([realpath(rootValue), realpath(dataValue)]);
  const [pluginStats, dataStats] = await Promise.all([ordinaryDirectory(pluginRoot), ordinaryDirectory(dataRoot)]);
  return { pluginRoot, pluginIdentity: pluginStats, dataRoot, dataIdentity: dataStats };
}

async function resolveHookStorage(): Promise<HookStorage> {
  const [codex, claude] = await Promise.all([resolvePair("PLUGIN_ROOT", "PLUGIN_DATA"), resolvePair("CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA")]);
  if (!codex && !claude) throw new Error("missing-host-storage");
  if (codex && claude && (codex.pluginRoot !== claude.pluginRoot || !sameObject(codex.pluginIdentity, claude.pluginIdentity) ||
      codex.dataRoot !== claude.dataRoot || !sameObject(codex.dataIdentity, claude.dataIdentity))) {
    throw new Error("conflicting-host-storage");
  }
  return codex ?? claude!;
}

async function validateHookStorage(storage: HookStorage): Promise<void> {
  const [pluginRoot, dataRoot] = await Promise.all([
    ordinaryDirectory(storage.pluginRoot), ordinaryDirectory(storage.dataRoot)
  ]);
  if (!sameObject(storage.pluginIdentity, pluginRoot) || !sameObject(storage.dataIdentity, dataRoot)) {
    throw new Error("substituted-host-storage");
  }
}

function overlaps(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  const a = normalize(left);
  const b = normalize(right);
  const aToB = relative(a, b);
  const bToA = relative(b, a);
  return a === b || (!aToB.startsWith("..") && !isAbsolute(aToB)) || (!bToA.startsWith("..") && !isAbsolute(bToA));
}

async function validateNonOverlap(storage: HookStorage, workspaceRoot: string): Promise<void> {
  if (overlaps(storage.dataRoot, workspaceRoot)) throw new Error("overlapping-host-storage");
}

async function bindSessions(storage: HookStorage, create: boolean): Promise<SessionStorage | undefined> {
  const dataBefore = await ordinaryDirectory(storage.dataRoot);
  if (!sameObject(storage.dataIdentity, dataBefore)) throw new Error("substituted-data-root");
  const sessions = join(storage.dataRoot, "sessions");
  try {
    const sessionsIdentity = await ordinaryDirectory(sessions);
    const dataAfter = await ordinaryDirectory(storage.dataRoot);
    if (!sameObject(dataBefore, dataAfter)) throw new Error("substituted-data-root");
    return { ...storage, sessions, sessionsIdentity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return undefined;
    try { await mkdir(sessions, { mode: 0o700 }); } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
    }
    const [sessionsIdentity, dataAfter] = await Promise.all([ordinaryDirectory(sessions), ordinaryDirectory(storage.dataRoot)]);
    if (!sameObject(dataBefore, dataAfter)) throw new Error("substituted-data-root");
    return { ...storage, sessions, sessionsIdentity };
  }
}

async function validateParents(storage: SessionStorage): Promise<void> {
  const [data, sessions] = await Promise.all([ordinaryDirectory(storage.dataRoot), ordinaryDirectory(storage.sessions)]);
  if (!sameObject(storage.dataIdentity, data) || !sameObject(storage.sessionsIdentity, sessions)) throw new Error("substituted-pointer-parent");
}

function pointerPath(storage: SessionStorage, sessionHash: string): string {
  if (!HASH_PATTERN.test(sessionHash)) throw new Error("invalid-session-hash");
  return join(storage.sessions, `${sessionHash}.json`);
}

function decodePointer(
  value: unknown,
  expectedHash: string,
  now: Date
):
  | { status: "valid"; pointer: Readonly<SessionPointerV2> }
  | { status: "invalid" | "unsupported" | "expired" | "mismatched" | "unstable" } {
  if (!isRecord(value)) return { status: "invalid" };
  if (value.schemaId === POINTER_SCHEMA_ID && typeof value.schemaVersion === "number" && value.schemaVersion !== POINTER_SCHEMA_VERSION) return { status: "unsupported" };
  const expected = ["schemaId", "schemaVersion", "sessionHash", "taskId", "turnId", "updatedAt"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return { status: "invalid" };
  if (value.schemaId !== POINTER_SCHEMA_ID || value.schemaVersion !== POINTER_SCHEMA_VERSION || typeof value.sessionHash !== "string" || !HASH_PATTERN.test(value.sessionHash) ||
      typeof value.taskId !== "string" || !UUID_PATTERN.test(value.taskId) || !isIdentifier(value.turnId) || typeof value.updatedAt !== "string") return { status: "invalid" };
  if (value.sessionHash !== expectedHash) return { status: "mismatched" };
  const updatedAt = Date.parse(value.updatedAt);
  if (!Number.isFinite(updatedAt) || new Date(updatedAt).toISOString() !== value.updatedAt) return { status: "invalid" };
  const updatedAtNs = BigInt(updatedAt) * NANOSECONDS_PER_MILLISECOND;
  const nowNs = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND;
  if (updatedAtNs < nowNs - POINTER_RETENTION_NS || updatedAtNs > nowNs + FUTURE_TOLERANCE_NS) return { status: "expired" };
  return { status: "valid", pointer: Object.freeze({
    schemaId: POINTER_SCHEMA_ID, schemaVersion: POINTER_SCHEMA_VERSION, sessionHash: expectedHash,
    taskId: value.taskId, turnId: value.turnId, updatedAt: value.updatedAt
  }) };
}

async function readPointer(storage: SessionStorage, expectedHash: string, now = new Date()): Promise<PointerInspection> {
  let started = false;
  try {
    await validateParents(storage);
    const path = pointerPath(storage, expectedHash);
    const entryStats = await lstat(path, { bigint: true });
    started = true;
    if (!entryStats.isFile() || entryStats.isSymbolicLink() || entryStats.nlink !== 1n) return { status: "unstable" };
    const entryBefore = fileIdentity(entryStats);
    if (entryBefore.size < 0n || entryBefore.size > BigInt(POINTER_MAX_BYTES)) return { status: "invalid", entry: entryBefore };
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    let text: string;
    try {
      const openedStats = await handle.stat({ bigint: true });
      const opened = fileIdentity(openedStats);
      if (!openedStats.isFile() || openedStats.nlink !== 1n || !sameFile(entryBefore, opened)) return { status: "unstable" };
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, POINTER_MAX_BYTES + 1 - bytesRead));
        const result = await handle.read(chunk, 0, chunk.length, null);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
        if (bytesRead > POINTER_MAX_BYTES) return { status: "invalid", entry: entryBefore };
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      const [handleAfter, entryAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
      if (!entryAfter.isFile() || entryAfter.isSymbolicLink() || entryAfter.nlink !== 1n || !sameFile(opened, fileIdentity(handleAfter)) ||
          !sameFile(entryBefore, fileIdentity(entryAfter)) || BigInt(bytesRead) !== handleAfter.size) return { status: "unstable" };
      text = Buffer.concat(chunks, bytesRead).toString("utf8");
    } finally { await handle.close(); }
    await validateParents(storage);
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { return { status: "invalid", entry: entryBefore }; }
    return { ...decodePointer(parsed, expectedHash, now), entry: entryBefore } as PointerInspection;
  } catch (error) {
    // Only a genuine initial absence is missing; a disappearance seen after the read began is unstable.
    if (!started && (error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unstable" };
  }
}

async function syncDirectory(path: string): Promise<void> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try { await handle.sync(); } catch (error) {
    if (!(["EINVAL", "ENOTSUP", "EBADF", "EPERM"] as string[]).includes(String((error as NodeJS.ErrnoException).code))) throw error;
  } finally { await handle.close(); }
}

async function unlinkExactEntry(storage: SessionStorage, path: string, expected: FileIdentity): Promise<void> {
  await validateParents(storage);
  const current = await lstat(path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameFile(expected, fileIdentity(current))) {
    throw new Error("unstable-pointer-removal");
  }
  await validateParents(storage);
  await unlink(path);
  await validateParents(storage);
}

// Removes only the entry this process exclusively created, proven by its creation object identity.
async function unlinkCreatedTemporary(storage: SessionStorage, path: string, created: FileIdentity): Promise<void> {
  await validateParents(storage);
  const current = await lstat(path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameObject(created, fileIdentity(current))) {
    throw new Error("unstable-pointer-removal");
  }
  await validateParents(storage);
  await unlink(path);
  await validateParents(storage);
}

async function isCompletedCooperativeReplacement(storage: SessionStorage, sessionHash: string): Promise<boolean> {
  for (let attempt = 0; attempt < POINTER_REPLACE_ATTEMPTS; attempt += 1) {
    const current = await readPointer(storage, sessionHash);
    if (current.status === "valid") return true;
    if (current.status !== "unstable" || attempt + 1 >= POINTER_REPLACE_ATTEMPTS) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
  }
  return false;
}

async function replacePointer(storage: SessionStorage, pointer: SessionPointerV2): Promise<void> {
  for (let attempt = 0; attempt < POINTER_REPLACE_ATTEMPTS; attempt += 1) {
    await validateParents(storage);
    const existing = await readPointer(storage, pointer.sessionHash);
    if (existing.status === "unstable" && await isCompletedCooperativeReplacement(storage, pointer.sessionHash)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
      continue;
    }
    if (!["missing", "valid", "expired"].includes(existing.status)) throw new Error("unsafe-pointer-target");
    const temp = join(storage.sessions, `.tg-pointer-${pointer.sessionHash}-${process.pid}-${randomUUID()}.tmp`);
    const bytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8");
    if (bytes.length > POINTER_MAX_BYTES) throw new Error("invalid-pointer-size");
    let createdIdentity: FileIdentity | undefined;
    let temporaryIdentity: FileIdentity | undefined;
    let published = false;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        // The exclusively created entry is owned from this point, so a later failure can still clean it up.
        createdIdentity = fileIdentity(await handle.stat({ bigint: true }));
        await handle.writeFile(bytes);
        await handle.sync();
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile() || stats.nlink !== 1n) throw new Error("unstable-pointer-temporary");
        temporaryIdentity = fileIdentity(stats);
      } finally { await handle.close(); }
      const tempStats = await lstat(temp, { bigint: true });
      if (!sameFile(temporaryIdentity, fileIdentity(tempStats)) || tempStats.nlink !== 1n) throw new Error("unstable-pointer-temporary");
      await validateParents(storage);
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
        await link(temp, targetPath);
        const [linkedTemporary, linkedTarget] = await Promise.all([
          lstat(temp, { bigint: true }), lstat(targetPath, { bigint: true })
        ]);
        const linkedIdentity = { ...temporaryIdentity, nlink: 2n };
        if (!linkedTemporary.isFile() || linkedTemporary.isSymbolicLink() || linkedTemporary.nlink !== 2n ||
            !linkedTarget.isFile() || linkedTarget.isSymbolicLink() || linkedTarget.nlink !== 2n ||
            !sameRenamedFile(linkedIdentity, fileIdentity(linkedTemporary)) || !sameFile(fileIdentity(linkedTemporary), fileIdentity(linkedTarget))) {
          throw new Error("unstable-pointer-replacement");
        }
        await validateParents(storage);
        await unlink(temp);
      } else {
        await rename(temp, targetPath);
      }
      published = true;
      const target = await lstat(targetPath, { bigint: true });
      const targetIdentity = fileIdentity(target);
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n ||
          (temporaryIdentity.dev === targetIdentity.dev && temporaryIdentity.ino === targetIdentity.ino
            ? !sameRenamedFile(temporaryIdentity, targetIdentity)
            : !await isCompletedCooperativeReplacement(storage, pointer.sessionHash))) {
        throw new Error("unstable-pointer-replacement");
      }
      await syncDirectory(storage.sessions);
      await validateParents(storage);
      return;
    } catch (error) {
      if (!published && createdIdentity) {
        try { await unlinkCreatedTemporary(storage, temp, createdIdentity); } catch { /* Preserve ambiguous temporary evidence. */ }
      }
      if ((["EACCES", "EBUSY", "EEXIST", "EPERM"] as string[]).includes(String((error as NodeJS.ErrnoException).code)) &&
          attempt + 1 < POINTER_REPLACE_ATTEMPTS) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5 * (attempt + 1), 40)));
        continue;
      }
      throw error;
    }
  }
  throw new Error("pointer-contention");
}

async function removePointer(storage: SessionStorage, sessionHash: string): Promise<boolean> {
  const loaded = await readPointer(storage, sessionHash);
  if (loaded.status === "missing") return false;
  if ((loaded.status !== "valid" && loaded.status !== "expired") || !loaded.entry) throw new Error("unsafe-pointer-removal");
  await unlinkExactEntry(storage, pointerPath(storage, sessionHash), loaded.entry);
  return true;
}

async function prunePointers(storage: SessionStorage, now = new Date()): Promise<void> {
  await validateParents(storage);
  const names = (await readdir(storage.sessions)).sort().filter((name) =>
    (name.endsWith(".json") && HASH_PATTERN.test(name.slice(0, -5))) || TEMP_PATTERN.test(name)
  ).slice(0, 64);
  await validateParents(storage);
  for (const name of names) {
    if (name.endsWith(".json")) {
      try {
        const sessionHash = name.slice(0, -5);
        const loaded = await readPointer(storage, sessionHash, now);
        if (loaded.status === "expired" && loaded.entry) await removePointer(storage, sessionHash);
      } catch { /* Advisory pruning preserves concurrently changed state. */ }
      continue;
    }
    const path = join(storage.sessions, name);
    try {
      await validateParents(storage);
      const stats = await lstat(path, { bigint: true });
      const nowNs = BigInt(now.getTime()) * NANOSECONDS_PER_MILLISECOND;
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) continue;
      // A future-dated temporary is never removed, and only entries older than the retention window are.
      if (stats.mtimeNs > nowNs + FUTURE_TOLERANCE_NS || stats.mtimeNs > nowNs - POINTER_RETENTION_NS) continue;
      await unlinkExactEntry(storage, path, fileIdentity(stats));
    } catch { /* Advisory pruning preserves ambiguous state. */ }
  }
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.split("__").at(-1);
  return candidate && /^tokengraph_[a-z0-9_]+$/.test(candidate) && TASK_AWARE_TOOLS.has(candidate) ? candidate : undefined;
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]];
  for (let index = 0; index < pending.length; index += 1) {
    const [a, b] = pending[index]!;
    if (Object.is(a, b)) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let item = 0; item < a.length; item += 1) pending.push([a[item], b[item]]);
      continue;
    }
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, keyIndex) => key !== bKeys[keyIndex])) return false;
    for (const key of aKeys) pending.push([a[key], b[key]]);
  }
  return true;
}

function errorShaped(response: Record<string, unknown>, payload: Record<string, unknown> | undefined): boolean {
  if (Object.hasOwn(response, "error") || Object.hasOwn(response, "errors") || response.success === false || response.ok === false ||
      ["error", "failed", "failure"].includes(String(response.status).toLowerCase())) return true;
  if (payload && (Object.hasOwn(payload, "error") || Object.hasOwn(payload, "errors") || payload.success === false || payload.ok === false ||
      ["error", "failed", "failure"].includes(String(payload.status).toLowerCase()))) return true;
  return Array.isArray(response.content) && response.content.some((item) => isRecord(item) && item.type === "error");
}

function successfulResponse(response: unknown): { successful: boolean; payload?: Record<string, unknown> } {
  if (!isRecord(response)) return { successful: false };
  for (const alias of ["isError", "is_error"] as const) {
    if (Object.hasOwn(response, alias) && (typeof response[alias] !== "boolean" || response[alias] !== false)) return { successful: false };
  }
  const hasCamel = Object.hasOwn(response, "structuredContent");
  const hasSnake = Object.hasOwn(response, "structured_content");
  if ((hasCamel && !isRecord(response.structuredContent)) || (hasSnake && !isRecord(response.structured_content))) return { successful: false };
  const camel = hasCamel ? response.structuredContent as Record<string, unknown> : undefined;
  const snake = hasSnake ? response.structured_content as Record<string, unknown> : undefined;
  if (camel && snake && !sameStructuredValue(camel, snake)) return { successful: false };
  const payload = camel ?? snake;
  if (errorShaped(response, payload)) return { successful: false };
  return payload ? { successful: true, payload } : { successful: true };
}

async function explicitRootsMatch(input: Record<string, unknown>, payload: Record<string, unknown> | undefined, root: string): Promise<boolean> {
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;
  const toolResponse = isRecord(input.tool_response) ? input.tool_response : undefined;
  for (const candidate of [input.cwd, toolInput?.root, toolResponse?.root, payload?.root]) {
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || !isAbsolute(candidate)) return false;
    try { if (await realpath(candidate) !== root) return false; } catch { return false; }
  }
  return true;
}

function selectedTurn(input: Record<string, unknown>): string | undefined {
  for (const key of ["turn_id", "prompt_id", "tool_use_id"] as const) {
    if (input[key] !== undefined) return isIdentifier(input[key]) ? input[key] : undefined;
  }
  return undefined;
}

async function attestSession(input: Record<string, unknown>, storage: HookStorage): Promise<HookOutput> {
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return warning("TokenGraph received invalid host workspace attestation input; setup was skipped.");
  try {
    await validateHookStorage(storage);
    const root = await realpath(input.cwd);
    await validateNonOverlap(storage, root);
    await attestHostWorkspace(storage.pluginRoot, input.session_id as string, root);
    return {};
  } catch { return warning("TokenGraph could not establish a safe host workspace attestation; setup was skipped."); }
}

async function postToolUse(input: Record<string, unknown>, storage: HookStorage): Promise<HookOutput> {
  if (!normalizeToolName(input.tool_name)) return {};
  const turnId = selectedTurn(input);
  if (!turnId) return warning("TokenGraph received invalid lifecycle turn metadata; tracking was skipped.");
  try { await validateHookStorage(storage); } catch { return warning("TokenGraph host storage is unstable; tracking was skipped."); }
  const attestation = await loadHostWorkspaceAttestation(storage.pluginRoot, input.session_id as string);
  if (attestation.status !== "valid") return warning(`TokenGraph host workspace attestation is ${attestation.status}; tracking was skipped.`);
  try { await validateNonOverlap(storage, attestation.root); } catch { return warning("TokenGraph host storage overlaps the workspace; tracking was skipped."); }
  const currentHash = hash(input.session_id as string);
  const response = successfulResponse(input.tool_response);
  if (!response.successful) return {};
  const payload = response.payload;
  if (!await explicitRootsMatch(input, payload, attestation.root)) return warning("TokenGraph lifecycle root did not match the host attestation; tracking was skipped.");
  let taskId: string | undefined;
  let sessions: SessionStorage | undefined;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;
  const hasInputTaskId = toolInput !== undefined && Object.hasOwn(toolInput, "taskId");
  if (hasInputTaskId && (typeof toolInput.taskId !== "string" || !UUID_PATTERN.test(toolInput.taskId))) return {};
  const inputTaskId = hasInputTaskId ? toolInput.taskId as string : undefined;
  if (payload && Object.hasOwn(payload, "taskId")) {
    if (typeof payload.taskId !== "string" || !UUID_PATTERN.test(payload.taskId) || (inputTaskId && inputTaskId !== payload.taskId)) return {};
    taskId = payload.taskId;
  } else if (inputTaskId) {
    try { sessions = await bindSessions(storage, false); } catch { return warning("TokenGraph session storage is unstable; tracking was skipped."); }
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
    await replacePointer(sessions, { schemaId: POINTER_SCHEMA_ID, schemaVersion: POINTER_SCHEMA_VERSION, sessionHash: currentHash, taskId, turnId, updatedAt: new Date().toISOString() });
    await prunePointers(sessions);
    return {};
  } catch { return warning("TokenGraph lifecycle pointer could not be safely updated; tracking was skipped."); }
}

async function stop(input: Record<string, unknown>, storage: HookStorage): Promise<HookOutput> {
  try { await validateHookStorage(storage); } catch { return warning("TokenGraph host storage is unstable; lifecycle enforcement was skipped."); }
  const attestation = await loadHostWorkspaceAttestation(storage.pluginRoot, input.session_id as string);
  if (attestation.status !== "valid") return warning(`TokenGraph host workspace attestation is ${attestation.status}; lifecycle enforcement was skipped.`);
  try { await validateNonOverlap(storage, attestation.root); } catch { return warning("TokenGraph host storage overlaps the workspace; lifecycle enforcement was skipped."); }
  if (!await explicitRootsMatch(input, undefined, attestation.root)) return warning("TokenGraph lifecycle root did not match the host attestation; lifecycle enforcement was skipped.");
  let sessions: SessionStorage | undefined;
  try { sessions = await bindSessions(storage, false); } catch { return warning("TokenGraph session storage is unstable; lifecycle enforcement was skipped."); }
  if (!sessions) return warning("TokenGraph session pointer is missing; lifecycle enforcement was skipped.");
  const loaded = await readPointer(sessions, hash(input.session_id as string));
  if (loaded.status !== "valid") return warning(`TokenGraph session pointer is ${loaded.status}; lifecycle enforcement was skipped.`);
  const inspected = await inspectTaskLedgerReadOnly(attestation.root, loaded.pointer.taskId);
  if (inspected.status !== "valid") return warning(`TokenGraph task ledger is ${inspected.status}; lifecycle enforcement was skipped.`);
  const ledger = inspected.ledger;
  if (ledger.status === "paused") return {};
  if (ledger.status === "open" && ledger.lastDisposition === undefined) {
    if (input.stop_hook_active === true) return warning("TokenGraph task is still open without a pause-or-complete report; allowing stop to prevent a hook retry loop.");
    const pauseCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: attestation.root, disposition: "pause" })})`;
    const completeCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: attestation.root, disposition: "complete" })})`;
    return { decision: "block", reason: `Call exactly one of these exact calls, choosing pause if work is unfinished or complete if it is finished: ${pauseCall} OR ${completeCall}. Then report the returned status. Do not claim completion for an interrupt or API failure.` };
  }
  if (ledger.status === "completed" && ledger.completedReport) {
    const footer = formatTaskReportFooter(ledger.completedReport);
    const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    if (message.includes(footer)) return {};
    if (input.stop_hook_active === true) return warning(`TokenGraph completion footer is still missing. Append exactly: ${footer}`);
    return { decision: "block", reason: `Append this exact canonical TokenGraph footer to the final response: ${footer}` };
  }
  return {};
}

async function endSession(input: Record<string, unknown>, storage: HookStorage): Promise<HookOutput> {
  try { await validateHookStorage(storage); } catch { return warning("TokenGraph host storage is unstable; lifecycle cleanup was skipped."); }
  const attestation = await loadHostWorkspaceAttestation(storage.pluginRoot, input.session_id as string);
  if (attestation.status === "expired") return removeSessionState(input, storage);
  if (attestation.status !== "valid") return warning(`TokenGraph host workspace attestation is ${attestation.status}; lifecycle cleanup was skipped.`);
  try { await validateNonOverlap(storage, attestation.root); } catch { return warning("TokenGraph host storage overlaps the workspace; lifecycle cleanup was skipped."); }
  if (!await explicitRootsMatch(input, undefined, attestation.root)) return warning("TokenGraph lifecycle root did not match the host attestation; lifecycle cleanup was skipped.");
  return removeSessionState(input, storage);
}

async function removeSessionState(input: Record<string, unknown>, storage: HookStorage): Promise<HookOutput> {
  let warningNeeded = false;
  try {
    const sessions = await bindSessions(storage, false);
    if (sessions) await removePointer(sessions, hash(input.session_id as string));
  } catch { warningNeeded = true; }
  try { await removeHostWorkspaceAttestation(storage.pluginRoot, input.session_id as string); } catch { warningNeeded = true; }
  return warningNeeded ? warning("TokenGraph could not safely remove all expired lifecycle state.") : {};
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > INPUT_MAX_BYTES) throw new Error("input-too-large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

async function main(): Promise<void> {
  let output: HookOutput;
  try {
    if (process.argv.length !== 3) throw new Error("invalid-arguments");
    const event = process.argv[2]!;
    const expectedEvent = EVENT_PAIRS.get(event);
    const input = await readStdin();
    if (!expectedEvent || !isRecord(input) || input.hook_event_name !== expectedEvent ||
        !isIdentifier(input.session_id) || containsConfirmationLikeField(input)) throw new Error("invalid-input");
    const storage = await resolveHookStorage();
    output = event === "session-start" || event === "user-prompt-submit" ? await attestSession(input, storage)
      : event === "session-end" ? await endSession(input, storage)
      : event === "post-tool-use" ? await postToolUse(input, storage)
      : await stop(input, storage);
  } catch { output = warning("TokenGraph hook state could not be safely processed; lifecycle enforcement was skipped."); }
  const bounded = typeof output.reason === "string" ? { ...output, reason: output.reason.slice(0, DECISION_MAX_CHARACTERS) } : output;
  process.stdout.write(`${JSON.stringify(bounded)}\n`);
}

await main();
