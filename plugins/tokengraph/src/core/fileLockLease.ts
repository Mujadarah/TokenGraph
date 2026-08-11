import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import {
  type LegacyRuntimeShutdownCapability,
  isLegacyRuntimeShutdownCapability,
  requireLegacyRuntimeShutdownCapability
} from "./legacyRuntimeActivation.js";
import {
  type CanonicalPersistenceLock,
  isCanonicalPersistenceLock,
  relativeLegacyName
} from "./lockDomain.js";
import {
  type NativeLockAddon,
  type NativeLockHandle,
  NativeLockError
} from "./nativeLockAddon.js";
import { getNativeLockAddon } from "./nativeLockProvider.js";

export interface FileLockLeaseV1 {
  schemaVersion: 1;
  pid: number;
  nonce: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface PendingBarrierV2 {
  readonly operation: "create";
}

export interface PendingLeaseWriteV2 {
  readonly operation: "create" | "replace";
  readonly fromIdentity?: string;
  readonly payloadSha256: string;
  readonly temporaryIdentity?: string;
}

export interface JournalPredecessorV2 {
  readonly generation: number;
  readonly identity: string;
}

export interface IdleLockRecoveryJournalV2 {
  readonly schemaVersion: 2;
  readonly generation: number;
  readonly phase: "idle";
  readonly predecessor?: JournalPredecessorV2;
}

export interface ActiveLockRecoveryJournalV2 {
  readonly schemaVersion: 2;
  readonly generation: number;
  readonly predecessor: JournalPredecessorV2;
  readonly relativeLegacyName: string;
  readonly keyHash: string;
  readonly pid: number;
  readonly nonce: string;
  readonly phase: "intent" | "barrier-created" | "lease-created" | "cleanup";
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly barrierIdentity?: string;
  readonly leaseIdentity?: string;
  readonly pendingBarrier?: PendingBarrierV2;
  readonly pendingLeaseWrite?: PendingLeaseWriteV2;
}

export type LockRecoveryJournalV2 = IdleLockRecoveryJournalV2 | ActiveLockRecoveryJournalV2;

export interface FileLockPolicy {
  readonly attempts: number;
  readonly waitMs: number;
  readonly staleMs: number;
  readonly heartbeatMs: number;
}

export interface FileLockOptions {
  readonly signal?: AbortSignal;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface FileSnapshot {
  readonly identity: string;
  readonly nlink: number;
  readonly mode: number;
  readonly text: string;
}

export interface DirectorySnapshot {
  readonly identity: string;
  readonly mode: number;
  readonly entries: readonly string[];
}

export interface FileLockIo {
  ensureDirectory(path: string): Promise<void>;
  readFile(path: string, maximumBytes: number): Promise<FileSnapshot | undefined>;
  inspectDirectory(path: string): Promise<DirectorySnapshot | undefined>;
  createDirectory(path: string): Promise<DirectorySnapshot>;
  createFileDurable(path: string, text: string): Promise<FileSnapshot>;
  replaceFileFromTemporary(
    temporaryPath: string,
    targetPath: string,
    temporaryIdentity: string,
    expectedTargetIdentity?: string
  ): Promise<FileSnapshot>;
  flushParentDirectory(path: string): Promise<void>;
  removeFile(path: string, expectedIdentity: string): Promise<void>;
  removeDirectory(path: string, expectedIdentity: string): Promise<void>;
}

export interface HeartbeatSchedule {
  stop(): Promise<void>;
}

export interface FileLockRuntime {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  now(): number;
  randomUUID(): string;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
  processLiveness(pid: number): ProcessLiveness | Promise<ProcessLiveness>;
  loadAddon(): Promise<NativeLockAddon>;
  scheduleHeartbeat(milliseconds: number, callback: () => Promise<void>): HeartbeatSchedule;
  readonly io: FileLockIo;
}

export type FileLockErrorCode =
  | "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED"
  | "INVALID_PERSISTENCE_LOCK"
  | "LEGACY_LOCK_BLOCKED"
  | "UNSAFE_LOCK_DIRECTORY"
  | "LOCK_JOURNAL_UNSAFE"
  | "LOCK_LEASE_OCCUPIED"
  | "LOCK_TIMEOUT"
  | "LOCK_ABORTED";

const ERROR_MESSAGES: Readonly<Record<FileLockErrorCode, string>> = Object.freeze({
  LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED: "Legacy TokenGraph runtime shutdown has not been confirmed.",
  INVALID_PERSISTENCE_LOCK: "The persistence lock was not created by the authorized registry.",
  LEGACY_LOCK_BLOCKED: "A legacy or unexplained persistence lock blocks this operation.",
  UNSAFE_LOCK_DIRECTORY: "The persistence lock directory is unsafe or has changed identity.",
  LOCK_JOURNAL_UNSAFE: "The native lock recovery journal is unsafe or ambiguous.",
  LOCK_LEASE_OCCUPIED: "The persistence lease is occupied or cannot be recovered safely.",
  LOCK_TIMEOUT: "Timed out waiting for the native persistence lock.",
  LOCK_ABORTED: "Waiting for the native persistence lock was aborted."
});

export class FileLockError extends Error {
  readonly code: FileLockErrorCode;

  constructor(code: FileLockErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "FileLockError";
    this.code = code;
  }
}

export const DEFAULT_FILE_LOCK_POLICY: Readonly<FileLockPolicy> = Object.freeze({
  attempts: 200,
  waitMs: 10,
  staleMs: 30_000,
  heartbeatMs: 9_000
});

const JOURNAL_MAX_BYTES = 8 * 1024;
const LEASE_MAX_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NATIVE_ANCHOR = ".tokengraph-native-anchor-v2.lock";
const NATIVE_JOURNAL = ".tokengraph-native-journal-v2.lock";
const WRITE_TEMPORARY_SUFFIX = ".tokengraph-write-v2.tmp";

interface ExactPathQueueNode {
  operation?: () => Promise<unknown>;
  runtime?: FileLockRuntime;
  signal?: AbortSignal;
  resolve?: (value: unknown) => void;
  reject?: (reason?: unknown) => void;
  controller?: AbortController;
  abortListener?: () => void;
  started: boolean;
  canceled: boolean;
}

interface ExactPathQueue {
  active: ExactPathQueueNode;
  readonly waiting: ExactPathQueueNode[];
}

const sameProcessQueues = new Map<string, ExactPathQueue>();

function fail(code: FileLockErrorCode): never {
  throw new FileLockError(code);
}

function errno(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as NodeJS.ErrnoException).code === "string"
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

function isTransientWindowsDiagnostic(error: unknown, runtime: FileLockRuntime): boolean {
  return runtime.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(errno(error));
}

function validatePolicy(policy: FileLockPolicy): void {
  if (!Number.isSafeInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 10_000 ||
    !Number.isSafeInteger(policy.waitMs) || policy.waitMs < 0 || policy.waitMs > 60_000 ||
    !Number.isSafeInteger(policy.staleMs) || policy.staleMs < 3 || policy.staleMs > 86_400_000 ||
    !Number.isSafeInteger(policy.heartbeatMs) || policy.heartbeatMs < 1 ||
    policy.heartbeatMs * 3 >= policy.staleMs) {
    throw new TypeError("Invalid file lock policy.");
  }
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) fail("LOCK_ABORTED");
}

function iso(milliseconds: number): string {
  const value = new Date(milliseconds).toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new RangeError("Invalid lock clock.");
  return value;
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(record).sort();
  const allowed = [...required, ...optional];
  if (!required.every((key) => actual.includes(key)) || actual.some((key) => !allowed.includes(key))) return false;
  return true;
}

function parseLease(text: string): FileLockLeaseV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (`${JSON.stringify(parsed)}\n` !== text) return undefined;
  if (!isPlainRecord(parsed) || !exactKeys(parsed,
    ["schemaVersion", "pid", "nonce", "startedAt", "heartbeatAt"])) return undefined;
  if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 ||
    typeof parsed.nonce !== "string" || !UUID_PATTERN.test(parsed.nonce) ||
    !validIso(parsed.startedAt) || !validIso(parsed.heartbeatAt) ||
    Date.parse(parsed.heartbeatAt) < Date.parse(parsed.startedAt)) return undefined;
  return parsed as unknown as FileLockLeaseV1;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function parsePredecessor(value: unknown): JournalPredecessorV2 | undefined {
  if (!isPlainRecord(value) || !exactKeys(value, ["generation", "identity"]) ||
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || !validIdentity(value.identity)) {
    return undefined;
  }
  return value as unknown as JournalPredecessorV2;
}

function parsePendingLeaseWrite(value: unknown): PendingLeaseWriteV2 | undefined {
  if (!isPlainRecord(value) || !exactKeys(value, ["operation", "payloadSha256"],
    ["fromIdentity", "temporaryIdentity"]) ||
    !["create", "replace"].includes(String(value.operation)) ||
    typeof value.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.payloadSha256) ||
    (value.temporaryIdentity !== undefined && !validIdentity(value.temporaryIdentity))) return undefined;
  if (value.operation === "create" && value.fromIdentity !== undefined) return undefined;
  if (value.operation === "replace" && !validIdentity(value.fromIdentity)) return undefined;
  return value as unknown as PendingLeaseWriteV2;
}

function parseLockRecoveryJournal(text: string): LockRecoveryJournalV2 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (`${JSON.stringify(parsed)}\n` !== text || !isPlainRecord(parsed) || parsed.schemaVersion !== 2 ||
    !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 0) return undefined;

  if (parsed.phase === "idle") {
    if (!exactKeys(parsed, ["schemaVersion", "generation", "phase"], ["predecessor"])) return undefined;
    if (parsed.generation === 0) {
      if (parsed.predecessor !== undefined) return undefined;
    } else {
      const predecessor = parsePredecessor(parsed.predecessor);
      if (predecessor === undefined || predecessor.generation !== Number(parsed.generation) - 1) return undefined;
    }
    return parsed as unknown as IdleLockRecoveryJournalV2;
  }

  if (!["intent", "barrier-created", "lease-created", "cleanup"].includes(String(parsed.phase)) ||
    !exactKeys(parsed,
      ["schemaVersion", "generation", "predecessor", "relativeLegacyName", "keyHash", "pid", "nonce", "phase",
        "startedAt", "heartbeatAt"],
      ["barrierIdentity", "leaseIdentity", "pendingBarrier", "pendingLeaseWrite"])) return undefined;
  const predecessor = parsePredecessor(parsed.predecessor);
  if (Number(parsed.generation) === 0 || predecessor === undefined ||
    predecessor.generation !== Number(parsed.generation) - 1 ||
    typeof parsed.relativeLegacyName !== "string" || typeof parsed.keyHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.keyHash) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 ||
    typeof parsed.nonce !== "string" || !UUID_PATTERN.test(parsed.nonce) ||
    !validIso(parsed.startedAt) || !validIso(parsed.heartbeatAt) ||
    Date.parse(parsed.heartbeatAt) < Date.parse(parsed.startedAt) ||
    (parsed.barrierIdentity !== undefined && !validIdentity(parsed.barrierIdentity)) ||
    (parsed.leaseIdentity !== undefined && !validIdentity(parsed.leaseIdentity))) return undefined;

  const pendingBarrier = parsed.pendingBarrier;
  if (pendingBarrier !== undefined && (!isPlainRecord(pendingBarrier) ||
    !exactKeys(pendingBarrier, ["operation"]) || pendingBarrier.operation !== "create")) return undefined;
  const pendingLeaseWrite = parsed.pendingLeaseWrite === undefined
    ? undefined : parsePendingLeaseWrite(parsed.pendingLeaseWrite);
  if (parsed.pendingLeaseWrite !== undefined && pendingLeaseWrite === undefined) return undefined;
  if (pendingBarrier !== undefined && pendingLeaseWrite !== undefined) return undefined;

  if (parsed.phase === "intent") {
    if (parsed.barrierIdentity !== undefined || parsed.leaseIdentity !== undefined ||
      pendingBarrier === undefined || pendingLeaseWrite !== undefined) return undefined;
  } else if (parsed.phase === "barrier-created") {
    if (!validIdentity(parsed.barrierIdentity) || parsed.leaseIdentity !== undefined || pendingBarrier !== undefined ||
      (pendingLeaseWrite !== undefined && pendingLeaseWrite.operation !== "create")) return undefined;
  } else if (parsed.phase === "lease-created") {
    if (!validIdentity(parsed.barrierIdentity) || !validIdentity(parsed.leaseIdentity) || pendingBarrier !== undefined ||
      (pendingLeaseWrite !== undefined && (pendingLeaseWrite.operation !== "replace" ||
        pendingLeaseWrite.fromIdentity !== parsed.leaseIdentity))) return undefined;
  } else if (!validIdentity(parsed.barrierIdentity) || pendingBarrier !== undefined || pendingLeaseWrite !== undefined) {
    return undefined;
  }
  return parsed as unknown as ActiveLockRecoveryJournalV2;
}

export function parseLockRecoveryJournalForTesting(text: string): LockRecoveryJournalV2 | undefined {
  return parseLockRecoveryJournal(text);
}

function activeJournal(record: LockRecoveryJournalV2): record is ActiveLockRecoveryJournalV2 {
  return record.phase !== "idle";
}

function sameActiveOwner(before: ActiveLockRecoveryJournalV2, after: ActiveLockRecoveryJournalV2): boolean {
  return before.relativeLegacyName === after.relativeLegacyName && before.keyHash === after.keyHash &&
    before.pid === after.pid && before.nonce === after.nonce && before.startedAt === after.startedAt &&
    Date.parse(after.heartbeatAt) >= Date.parse(before.heartbeatAt);
}

function withoutGeneration(record: LockRecoveryJournalV2): Record<string, unknown> {
  const copy = { ...record } as Record<string, unknown>;
  delete copy.generation;
  delete copy.predecessor;
  return copy;
}

function sameRecordState(before: LockRecoveryJournalV2, after: LockRecoveryJournalV2): boolean {
  return JSON.stringify(withoutGeneration(before)) === JSON.stringify(withoutGeneration(after));
}

function validLockRecoveryTransition(
  before: LockRecoveryJournalV2,
  after: LockRecoveryJournalV2,
  beforeIdentity: string
): boolean {
  if (after.generation !== before.generation + 1 || after.predecessor?.generation !== before.generation ||
    after.predecessor.identity !== beforeIdentity) return false;
  if (before.phase === "idle") {
    return after.phase === "intent" && after.startedAt === after.heartbeatAt;
  }
  if (activeJournal(after) && !sameActiveOwner(before, after)) return false;
  if (before.barrierIdentity !== undefined && activeJournal(after) &&
    after.barrierIdentity !== before.barrierIdentity) return false;

  if (before.phase === "intent") {
    return after.phase === "idle" || (after.phase === "barrier-created" && after.pendingLeaseWrite === undefined);
  }
  if (before.phase === "barrier-created") {
    const pending = before.pendingLeaseWrite;
    if (pending === undefined) {
      return (after.phase === "barrier-created" && after.pendingLeaseWrite?.operation === "create" &&
        after.pendingLeaseWrite.temporaryIdentity === undefined) ||
        (after.phase === "cleanup" && after.barrierIdentity === before.barrierIdentity && after.leaseIdentity === undefined);
    }
    if (after.phase === "barrier-created" && after.pendingLeaseWrite === undefined) return true;
    if (pending.temporaryIdentity === undefined) {
      return after.phase === "barrier-created" && after.pendingLeaseWrite?.operation === "create" &&
        after.pendingLeaseWrite.payloadSha256 === pending.payloadSha256 &&
        after.pendingLeaseWrite.temporaryIdentity !== undefined;
    }
    return after.phase === "lease-created" && after.pendingLeaseWrite === undefined &&
      after.leaseIdentity === pending.temporaryIdentity;
  }
  if (before.phase === "lease-created") {
    const pending = before.pendingLeaseWrite;
    if (pending === undefined) {
      return (after.phase === "lease-created" && after.pendingLeaseWrite?.operation === "replace" &&
        after.pendingLeaseWrite.fromIdentity === before.leaseIdentity &&
        after.pendingLeaseWrite.temporaryIdentity === undefined) ||
        (after.phase === "cleanup" && after.barrierIdentity === before.barrierIdentity &&
          after.leaseIdentity === before.leaseIdentity);
    }
    if (after.phase === "lease-created" && after.pendingLeaseWrite === undefined) {
      const rollback = sameRecordState(before, {
        ...after,
        pendingLeaseWrite: before.pendingLeaseWrite
      } as LockRecoveryJournalV2);
      return rollback || (pending.temporaryIdentity !== undefined && after.leaseIdentity === pending.temporaryIdentity);
    }
    return pending.temporaryIdentity === undefined && after.phase === "lease-created" &&
      after.pendingLeaseWrite?.operation === "replace" && after.pendingLeaseWrite.fromIdentity === pending.fromIdentity &&
      after.pendingLeaseWrite.payloadSha256 === pending.payloadSha256 &&
      after.pendingLeaseWrite.temporaryIdentity !== undefined;
  }
  if (before.leaseIdentity !== undefined) {
    return after.phase === "cleanup" && after.barrierIdentity === before.barrierIdentity && after.leaseIdentity === undefined;
  }
  return after.phase === "idle";
}

export function validateLockRecoveryTransitionForTesting(
  before: unknown,
  after: unknown,
  beforeIdentity: string
): boolean {
  const parsedBefore = parseLockRecoveryJournal(`${JSON.stringify(before)}\n`);
  const parsedAfter = parseLockRecoveryJournal(`${JSON.stringify(after)}\n`);
  return parsedBefore !== undefined && parsedAfter !== undefined && validIdentity(beforeIdentity) &&
    validLockRecoveryTransition(parsedBefore, parsedAfter, beforeIdentity);
}

function keyHash(relativeName: string): string {
  return createHash("sha256").update(relativeName, "utf8").digest("hex");
}

function stableSnapshot(first: FileSnapshot, second: FileSnapshot): boolean {
  return first.identity === second.identity && first.nlink === second.nlink && first.text === second.text;
}

function stale(heartbeatAt: string, runtime: FileLockRuntime, policy: FileLockPolicy): boolean {
  const heartbeat = Date.parse(heartbeatAt);
  return heartbeat <= runtime.now() && runtime.now() - heartbeat > policy.staleMs;
}

async function retryDiagnostic<T>(
  runtime: FileLockRuntime,
  policy: FileLockPolicy,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
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

async function readStableFile(
  path: string,
  maximumBytes: number,
  runtime: FileLockRuntime,
  policy: FileLockPolicy,
  signal?: AbortSignal,
  unstableCode: FileLockErrorCode = "LOCK_LEASE_OCCUPIED"
): Promise<[FileSnapshot, FileSnapshot] | undefined> {
  const first = await retryDiagnostic(runtime, policy, signal, () => runtime.io.readFile(path, maximumBytes));
  if (first === undefined) return undefined;
  await runtime.wait(policy.waitMs, signal);
  const second = await retryDiagnostic(runtime, policy, signal, () => runtime.io.readFile(path, maximumBytes));
  if (second === undefined || !stableSnapshot(first, second)) fail(unstableCode);
  return [first, second];
}

async function confirmedDead(
  pid: number,
  heartbeatAt: string,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<boolean> {
  if (!stale(heartbeatAt, runtime, policy)) return false;
  return await runtime.processLiveness(pid) === "dead";
}

function pathForJournal(lock: CanonicalPersistenceLock, journal: ActiveLockRecoveryJournalV2): string {
  const candidate = resolve(lock.domainRoot, journal.relativeLegacyName);
  const dataName = journal.relativeLegacyName.endsWith(".lock")
    ? journal.relativeLegacyName.slice(0, -".lock".length)
    : "";
  if (relative(lock.domainRoot, candidate) !== journal.relativeLegacyName || dirname(candidate) !== lock.domainRoot ||
    journal.relativeLegacyName.includes("/") || journal.relativeLegacyName.includes("\\") ||
    journal.relativeLegacyName === NATIVE_ANCHOR || journal.relativeLegacyName === NATIVE_JOURNAL ||
    dataName.length === 0 || dataName === "." || dataName === ".." ||
    /[<>:"|?*\u0000-\u001f]/u.test(dataName) || /[. ]$/u.test(dataName) ||
    Buffer.byteLength(dataName, "utf8") > 240 ||
    keyHash(journal.relativeLegacyName) !== journal.keyHash) {
    fail("LOCK_JOURNAL_UNSAFE");
  }
  return candidate;
}

function validateDirectory(
  snapshot: DirectorySnapshot,
  runtime: FileLockRuntime,
  expectedIdentity?: string
): void {
  if (expectedIdentity !== undefined && snapshot.identity !== expectedIdentity) fail("UNSAFE_LOCK_DIRECTORY");
  if (snapshot.identity.length === 0 || (runtime.platform !== "win32" && (snapshot.mode & 0o077) !== 0)) {
    fail("UNSAFE_LOCK_DIRECTORY");
  }
}

async function validateRecoverableLease(
  leasePath: string,
  expectedNonce: string,
  expectedOwner: Pick<ActiveLockRecoveryJournalV2, "pid" | "startedAt">,
  expectedIdentity: string | undefined,
  runtime: FileLockRuntime,
  policy: FileLockPolicy,
  signal?: AbortSignal
): Promise<{ lease: FileLockLeaseV1; snapshot: FileSnapshot }> {
  const pair = await readStableFile(leasePath, LEASE_MAX_BYTES, runtime, policy, signal);
  if (pair === undefined || pair[1].nlink !== 1 || (expectedIdentity !== undefined && pair[1].identity !== expectedIdentity)) {
    fail("LOCK_LEASE_OCCUPIED");
  }
  const lease = parseLease(pair[1].text);
  if (lease === undefined || lease.nonce !== expectedNonce || lease.pid !== expectedOwner.pid ||
    lease.startedAt !== expectedOwner.startedAt ||
    !await confirmedDead(lease.pid, lease.heartbeatAt, runtime, policy)) {
    fail("LOCK_LEASE_OCCUPIED");
  }
  return { lease, snapshot: pair[1] };
}

interface JournalStateV2 {
  record: LockRecoveryJournalV2;
  snapshot: FileSnapshot;
}

function journalText(record: LockRecoveryJournalV2): string {
  return `${JSON.stringify(record)}\n`;
}

function journalTemporaryPath(path: string): string {
  return `${path}${WRITE_TEMPORARY_SUFFIX}`;
}

function leasePayloadHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nextJournalRecord<T extends Omit<LockRecoveryJournalV2, "generation" | "predecessor">>(
  state: JournalStateV2,
  value: T
): LockRecoveryJournalV2 {
  return {
    ...value,
    generation: state.record.generation + 1,
    predecessor: { generation: state.record.generation, identity: state.snapshot.identity }
  } as LockRecoveryJournalV2;
}

async function classifyDomainRoot(
  lock: CanonicalPersistenceLock,
  record: LockRecoveryJournalV2 | undefined,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<void> {
  const root = await retryDiagnostic(runtime, policy, undefined, () => runtime.io.inspectDirectory(lock.domainRoot));
  if (root === undefined) fail("UNSAFE_LOCK_DIRECTORY");
  validateDirectory(root, runtime);
  const allowedBarrier = record !== undefined && activeJournal(record) ? record.relativeLegacyName : undefined;
  for (const entry of root.entries) {
    if (entry === NATIVE_ANCHOR || entry === NATIVE_JOURNAL ||
      entry === `${NATIVE_JOURNAL}${WRITE_TEMPORARY_SUFFIX}` || entry === allowedBarrier) continue;
    if (entry.startsWith(".tokengraph-native-") || entry.endsWith(WRITE_TEMPORARY_SUFFIX)) {
      fail("LOCK_JOURNAL_UNSAFE");
    }
    if (entry.endsWith(".lock")) {
      fail(entry === lock.compatibilityPath.slice(lock.domainRoot.length + 1)
        ? "LEGACY_LOCK_BLOCKED" : "LOCK_JOURNAL_UNSAFE");
    }
  }
}

async function stableProtocolFile(
  path: string,
  maximumBytes: number,
  runtime: FileLockRuntime,
  policy: FileLockPolicy,
  code: FileLockErrorCode = "LOCK_JOURNAL_UNSAFE"
): Promise<FileSnapshot | undefined> {
  const pair = await readStableFile(path, maximumBytes, runtime, policy, undefined, code);
  if (pair === undefined) return undefined;
  if (pair[1].nlink !== 1 || pair[1].identity.length === 0 ||
    (runtime.platform !== "win32" && (pair[1].mode & 0o077) !== 0)) fail(code);
  return pair[1];
}

async function replaceAuthorizedTemporary(
  temporaryPath: string,
  targetPath: string,
  temporary: FileSnapshot,
  expectedTargetIdentity: string | undefined,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<FileSnapshot> {
  return retryDiagnostic(runtime, policy, undefined, () => runtime.io.replaceFileFromTemporary(
    temporaryPath, targetPath, temporary.identity, expectedTargetIdentity
  ));
}

async function bootstrapJournalV2(
  lock: CanonicalPersistenceLock,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2> {
  await classifyDomainRoot(lock, undefined, runtime, policy);
  const temporaryPath = journalTemporaryPath(lock.journalPath);
  let temporary = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (temporary !== undefined) {
    const parsed = parseLockRecoveryJournal(temporary.text);
    if (parsed === undefined) {
      await retryDiagnostic(runtime, policy, undefined, () => runtime.io.removeFile(temporaryPath, temporary!.identity));
      temporary = undefined;
    } else if (parsed.phase !== "idle" || parsed.generation !== 0) {
      fail("LOCK_JOURNAL_UNSAFE");
    }
  }
  if (temporary === undefined) {
    const generationZero: IdleLockRecoveryJournalV2 = { schemaVersion: 2, generation: 0, phase: "idle" };
    temporary = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.createFileDurable(temporaryPath, journalText(generationZero)));
  }
  const snapshot = await replaceAuthorizedTemporary(
    temporaryPath, lock.journalPath, temporary, undefined, runtime, policy
  );
  const record = parseLockRecoveryJournal(snapshot.text);
  if (record?.phase !== "idle" || record.generation !== 0) fail("LOCK_JOURNAL_UNSAFE");
  return { record, snapshot };
}

async function recoverJournalSuccessorV2(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2> {
  await classifyDomainRoot(lock, state.record, runtime, policy);
  const temporaryPath = journalTemporaryPath(lock.journalPath);
  const temporary = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (temporary === undefined) return state;
  const successor = parseLockRecoveryJournal(temporary.text);
  if (successor === undefined) {
    await retryDiagnostic(runtime, policy, undefined, () => runtime.io.removeFile(temporaryPath, temporary.identity));
    return state;
  }
  if (!validLockRecoveryTransition(state.record, successor, state.snapshot.identity)) fail("LOCK_JOURNAL_UNSAFE");
  await validateRecoveredSuccessorPreconditions(lock, state, successor, runtime, policy);
  const snapshot = await replaceAuthorizedTemporary(
    temporaryPath, lock.journalPath, temporary, state.snapshot.identity, runtime, policy
  );
  return { record: successor, snapshot };
}

async function readJournalStateV2(
  lock: CanonicalPersistenceLock,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2> {
  const pair = await readStableFile(lock.journalPath, JOURNAL_MAX_BYTES, runtime, policy, undefined, "LOCK_JOURNAL_UNSAFE");
  if (pair === undefined) return bootstrapJournalV2(lock, runtime, policy);
  const snapshot = pair[1];
  if (snapshot.nlink !== 1 || (runtime.platform !== "win32" && (snapshot.mode & 0o077) !== 0)) {
    fail("LOCK_JOURNAL_UNSAFE");
  }
  const record = parseLockRecoveryJournal(snapshot.text);
  if (record === undefined) fail("LOCK_JOURNAL_UNSAFE");
  if (activeJournal(record)) pathForJournal(lock, record);
  return recoverJournalSuccessorV2(lock, { record, snapshot }, runtime, policy);
}

async function commitJournalV2(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2,
  successor: LockRecoveryJournalV2,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2> {
  if (!validLockRecoveryTransition(state.record, successor, state.snapshot.identity)) fail("LOCK_JOURNAL_UNSAFE");
  if (activeJournal(successor)) pathForJournal(lock, successor);
  await classifyDomainRoot(lock, state.record, runtime, policy);
  const temporaryPath = journalTemporaryPath(lock.journalPath);
  let temporary = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (temporary !== undefined) {
    const parsed = parseLockRecoveryJournal(temporary.text);
    if (parsed === undefined) {
      await retryDiagnostic(runtime, policy, undefined, () => runtime.io.removeFile(temporaryPath, temporary!.identity));
      temporary = undefined;
    } else if (JSON.stringify(parsed) !== JSON.stringify(successor) ||
      !validLockRecoveryTransition(state.record, parsed, state.snapshot.identity)) {
      fail("LOCK_JOURNAL_UNSAFE");
    }
  }
  if (temporary === undefined) {
    temporary = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.createFileDurable(temporaryPath, journalText(successor)));
  }
  const reread = await stableProtocolFile(temporaryPath, JOURNAL_MAX_BYTES, runtime, policy);
  if (reread?.identity !== temporary.identity || reread.text !== journalText(successor)) fail("LOCK_JOURNAL_UNSAFE");
  let snapshot: FileSnapshot;
  try {
    snapshot = await replaceAuthorizedTemporary(
      temporaryPath, lock.journalPath, reread, state.snapshot.identity, runtime, policy
    );
  } catch (error) {
    const committed = await stableProtocolFile(lock.journalPath, JOURNAL_MAX_BYTES, runtime, policy);
    if (committed?.identity !== reread.identity || committed.text !== journalText(successor)) throw error;
    await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.flushParentDirectory(lock.journalPath));
    snapshot = committed;
  }
  return { record: successor, snapshot };
}

function activeWithoutPending(record: ActiveLockRecoveryJournalV2): ActiveLockRecoveryJournalV2 {
  const copy = { ...record };
  delete copy.pendingBarrier;
  delete copy.pendingLeaseWrite;
  return copy;
}

function leasePayloadForJournal(
  text: string,
  record: ActiveLockRecoveryJournalV2,
  operation: "create" | "replace"
): FileLockLeaseV1 {
  const lease = parseLease(text);
  if (lease === undefined || lease.pid !== record.pid || lease.nonce !== record.nonce ||
    lease.startedAt !== record.startedAt || Date.parse(lease.heartbeatAt) < Date.parse(record.heartbeatAt) ||
    (operation === "create" && lease.heartbeatAt !== record.heartbeatAt)) {
    fail("LOCK_LEASE_OCCUPIED");
  }
  return lease;
}

function currentLeaseForJournal(
  snapshot: FileSnapshot | undefined,
  record: ActiveLockRecoveryJournalV2
): FileLockLeaseV1 {
  if (snapshot === undefined || snapshot.identity !== record.leaseIdentity) fail("LOCK_LEASE_OCCUPIED");
  const lease = parseLease(snapshot.text);
  if (lease === undefined || lease.pid !== record.pid || lease.nonce !== record.nonce ||
    lease.startedAt !== record.startedAt || lease.heartbeatAt !== record.heartbeatAt) {
    fail("LOCK_LEASE_OCCUPIED");
  }
  return lease;
}

async function inspectBarrierClosed(
  lock: CanonicalPersistenceLock,
  record: ActiveLockRecoveryJournalV2,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<DirectorySnapshot | undefined> {
  const barrier = await retryDiagnostic(runtime, policy, undefined,
    () => runtime.io.inspectDirectory(lock.compatibilityPath));
  if (barrier === undefined) return undefined;
  validateDirectory(barrier, runtime, record.barrierIdentity);
  const allowed = new Set<string>();
  if (record.leaseIdentity !== undefined || record.pendingLeaseWrite !== undefined) allowed.add("lease.json");
  if (record.pendingLeaseWrite !== undefined) allowed.add(`lease.json${WRITE_TEMPORARY_SUFFIX}`);
  if (barrier.entries.some((entry) => !allowed.has(entry))) fail("LOCK_JOURNAL_UNSAFE");
  return barrier;
}

async function validateRecoveredSuccessorPreconditions(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2,
  successor: LockRecoveryJournalV2,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<void> {
  const before = state.record;
  if (before.phase === "idle") {
    if (!activeJournal(successor)) fail("LOCK_JOURNAL_UNSAFE");
    const barrierPath = pathForJournal(lock, successor);
    const barrier = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.inspectDirectory(barrierPath));
    if (barrier !== undefined) fail("LOCK_JOURNAL_UNSAFE");
    return;
  }

  const barrierPath = pathForJournal(lock, before);
  const recoveryLock = barrierPath === lock.compatibilityPath ? lock : { ...lock, compatibilityPath: barrierPath };
  if (activeJournal(successor) && pathForJournal(lock, successor) !== barrierPath) fail("LOCK_JOURNAL_UNSAFE");
  if (before.phase === "intent") {
    const barrier = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.inspectDirectory(barrierPath));
    if (successor.phase === "idle") {
      if (barrier !== undefined) fail("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (barrier === undefined) fail("LOCK_JOURNAL_UNSAFE");
    validateDirectory(barrier, runtime, successor.barrierIdentity);
    if (barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
    return;
  }

  const barrier = await inspectBarrierClosed(recoveryLock, before, runtime, policy);
  const leasePath = join(barrierPath, "lease.json");
  const temporaryPath = journalTemporaryPath(leasePath);
  const target = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
  const temporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);

  if (before.phase === "barrier-created") {
    if (barrier === undefined) fail("LOCK_JOURNAL_UNSAFE");
    const pending = before.pendingLeaseWrite;
    if (pending === undefined) {
      if (target !== undefined || temporary !== undefined || barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (successor.phase === "barrier-created" && successor.pendingLeaseWrite?.temporaryIdentity !== undefined) {
      if (target !== undefined || temporary?.identity !== successor.pendingLeaseWrite.temporaryIdentity ||
        leasePayloadHash(temporary.text) !== pending.payloadSha256) fail("LOCK_JOURNAL_UNSAFE");
      leasePayloadForJournal(temporary.text, before, "create");
      return;
    }
    if (successor.phase === "barrier-created") {
      if (target !== undefined || temporary !== undefined) fail("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (successor.phase === "lease-created") {
      if (temporary !== undefined || target === undefined || target.identity !== pending.temporaryIdentity ||
        leasePayloadHash(target.text) !== pending.payloadSha256) fail("LOCK_JOURNAL_UNSAFE");
      const lease = leasePayloadForJournal(target.text, before, "create");
      if (successor.heartbeatAt !== lease.heartbeatAt) fail("LOCK_JOURNAL_UNSAFE");
      return;
    }
    fail("LOCK_JOURNAL_UNSAFE");
  }

  if (before.phase === "lease-created") {
    const pending = before.pendingLeaseWrite;
    if (pending === undefined) {
      currentLeaseForJournal(target, before);
      if (temporary !== undefined) fail("LOCK_JOURNAL_UNSAFE");
      return;
    }
    if (successor.phase === "lease-created" && successor.pendingLeaseWrite?.temporaryIdentity !== undefined) {
      currentLeaseForJournal(target, before);
      if (temporary?.identity !== successor.pendingLeaseWrite.temporaryIdentity ||
        leasePayloadHash(temporary.text) !== pending.payloadSha256) fail("LOCK_JOURNAL_UNSAFE");
      leasePayloadForJournal(temporary.text, before, "replace");
      return;
    }
    if (successor.phase === "lease-created" && successor.pendingLeaseWrite === undefined) {
      if (successor.leaseIdentity === before.leaseIdentity) {
        currentLeaseForJournal(target, before);
        if (temporary !== undefined) fail("LOCK_JOURNAL_UNSAFE");
        return;
      }
      if (temporary !== undefined || target === undefined || target.identity !== pending.temporaryIdentity ||
        leasePayloadHash(target.text) !== pending.payloadSha256) fail("LOCK_JOURNAL_UNSAFE");
      const lease = leasePayloadForJournal(target.text, before, "replace");
      if (successor.heartbeatAt !== lease.heartbeatAt) fail("LOCK_JOURNAL_UNSAFE");
      return;
    }
    fail("LOCK_JOURNAL_UNSAFE");
  }

  if (before.leaseIdentity !== undefined) {
    if (target !== undefined || temporary !== undefined || barrier?.entries.length !== 0) {
      fail("LOCK_JOURNAL_UNSAFE");
    }
    return;
  }
  if (barrier !== undefined) fail("LOCK_JOURNAL_UNSAFE");
}

async function resolvePendingLeaseV2(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2 & { record: ActiveLockRecoveryJournalV2 },
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2 & { record: ActiveLockRecoveryJournalV2 }> {
  const pending = state.record.pendingLeaseWrite;
  if (pending === undefined) return state;
  await inspectBarrierClosed(lock, state.record, runtime, policy);
  const leasePath = join(lock.compatibilityPath, "lease.json");
  const temporaryPath = journalTemporaryPath(leasePath);
  const target = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
  let temporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);

  if (pending.temporaryIdentity === undefined) {
    if (pending.operation === "create") {
      if (target !== undefined) fail("LOCK_JOURNAL_UNSAFE");
    } else {
      currentLeaseForJournal(target, state.record);
    }
    if (temporary !== undefined) {
      await retryDiagnostic(runtime, policy, undefined, () => runtime.io.removeFile(temporaryPath, temporary!.identity));
      temporary = undefined;
    }
    const successor = nextJournalRecord(state, activeWithoutPending(state.record));
    return await commitJournalV2(lock, state, successor, runtime, policy) as JournalStateV2 & {
      record: ActiveLockRecoveryJournalV2;
    };
  }

  let committedLease: FileLockLeaseV1;
  if (temporary !== undefined) {
    if (temporary.identity !== pending.temporaryIdentity || leasePayloadHash(temporary.text) !== pending.payloadSha256) {
      fail("LOCK_JOURNAL_UNSAFE");
    }
    committedLease = leasePayloadForJournal(temporary.text, state.record, pending.operation);
    const targetAllowed = pending.operation === "create" ? target === undefined : target?.identity === pending.fromIdentity;
    if (!targetAllowed) fail("LOCK_JOURNAL_UNSAFE");
    await inspectBarrierClosed(lock, state.record, runtime, policy);
    await replaceAuthorizedTemporary(
      temporaryPath, leasePath, temporary, pending.operation === "create" ? undefined : pending.fromIdentity,
      runtime, policy
    );
  } else {
    const alreadyCommitted = target?.identity === pending.temporaryIdentity &&
      leasePayloadHash(target.text) === pending.payloadSha256;
    if (!alreadyCommitted) {
      if (pending.operation === "create") {
        if (target !== undefined) fail("LOCK_JOURNAL_UNSAFE");
      } else {
        currentLeaseForJournal(target, state.record);
      }
      const rollback = nextJournalRecord(state, activeWithoutPending(state.record));
      return await commitJournalV2(lock, state, rollback, runtime, policy) as JournalStateV2 & {
        record: ActiveLockRecoveryJournalV2;
      };
    }
    committedLease = leasePayloadForJournal(target!.text, state.record, pending.operation);
  }

  const successorBase = activeWithoutPending(state.record);
  const successor = nextJournalRecord(state, {
    ...successorBase,
    phase: "lease-created",
    leaseIdentity: pending.temporaryIdentity,
    heartbeatAt: committedLease.heartbeatAt
  });
  return await commitJournalV2(lock, state, successor, runtime, policy) as JournalStateV2 & {
    record: ActiveLockRecoveryJournalV2;
  };
}

async function commitBarrierOnlyCleanupV2(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2 & { record: ActiveLockRecoveryJournalV2 },
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2 & { record: ActiveLockRecoveryJournalV2 }> {
  const { leaseIdentity: _leaseIdentity, ...barrierOnly } = activeWithoutPending(state.record);
  const successor = nextJournalRecord(state, {
    ...barrierOnly, phase: "cleanup"
  });
  return await commitJournalV2(lock, state, successor, runtime, policy) as JournalStateV2 & {
    record: ActiveLockRecoveryJournalV2;
  };
}

async function finishBarrierCleanupV2(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2 & { record: ActiveLockRecoveryJournalV2 },
  runtime: FileLockRuntime,
  policy: FileLockPolicy,
  handle?: NativeLockHandle
): Promise<JournalStateV2> {
  const barrier = await inspectBarrierClosed(lock, state.record, runtime, policy);
  if (barrier !== undefined && barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
  handle?.releaseCompatibilityDirectory();
  if (barrier !== undefined) {
    await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.removeDirectory(lock.compatibilityPath, state.record.barrierIdentity!));
  }
  const successor = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
  return commitJournalV2(lock, state, successor, runtime, policy);
}

async function recoverActiveJournalV2(
  lock: CanonicalPersistenceLock,
  initial: JournalStateV2 & { record: ActiveLockRecoveryJournalV2 },
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2> {
  let state = initial;
  if (!await confirmedDead(state.record.pid, state.record.heartbeatAt, runtime, policy)) fail("LOCK_JOURNAL_UNSAFE");
  const recordedBarrierPath = pathForJournal(lock, state.record);
  const recoveryLock = recordedBarrierPath === lock.compatibilityPath ? lock : {
    ...lock,
    compatibilityPath: recordedBarrierPath
  };

  if (state.record.phase === "intent") {
    const barrier = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.inspectDirectory(recoveryLock.compatibilityPath));
    if (barrier === undefined) {
      const idle = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
      return commitJournalV2(lock, state, idle, runtime, policy);
    }
    validateDirectory(barrier, runtime);
    if (barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
    const adopted = nextJournalRecord(state, {
      ...activeWithoutPending(state.record), phase: "barrier-created", barrierIdentity: barrier.identity
    });
    state = await commitJournalV2(recoveryLock, state, adopted, runtime, policy) as typeof state;
  }

  if (state.record.pendingLeaseWrite !== undefined) {
    state = await resolvePendingLeaseV2(recoveryLock, state, runtime, policy);
  }

  if (state.record.phase === "barrier-created") {
    const barrier = await inspectBarrierClosed(recoveryLock, state.record, runtime, policy);
    if (barrier === undefined || barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(recoveryLock, state, runtime, policy) as typeof state;
  } else if (state.record.phase === "lease-created") {
    const leasePath = join(recoveryLock.compatibilityPath, "lease.json");
    const recovered = await validateRecoverableLease(
      leasePath, state.record.nonce, state.record, state.record.leaseIdentity, runtime, policy
    );
    const cleanup = nextJournalRecord(state, {
      ...activeWithoutPending(state.record), phase: "cleanup", leaseIdentity: recovered.snapshot.identity
    });
    state = await commitJournalV2(recoveryLock, state, cleanup, runtime, policy) as typeof state;
  }

  if (state.record.phase === "cleanup" && state.record.leaseIdentity !== undefined) {
    const barrier = await inspectBarrierClosed(recoveryLock, state.record, runtime, policy);
    if (barrier === undefined) fail("LOCK_JOURNAL_UNSAFE");
    const leasePath = join(recoveryLock.compatibilityPath, "lease.json");
    const lease = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
    if (lease !== undefined) {
      const parsed = parseLease(lease.text);
      if (lease.identity !== state.record.leaseIdentity || parsed?.nonce !== state.record.nonce) {
        fail("LOCK_LEASE_OCCUPIED");
      }
      await retryDiagnostic(runtime, policy, undefined, () => runtime.io.removeFile(leasePath, lease.identity));
    }
    const empty = await inspectBarrierClosed(recoveryLock, state.record, runtime, policy);
    if (empty === undefined || empty.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(recoveryLock, state, runtime, policy) as typeof state;
  }
  if (state.record.phase === "cleanup") return finishBarrierCleanupV2(recoveryLock, state, runtime, policy);
  fail("LOCK_JOURNAL_UNSAFE");
}

async function reconcileJournalV2(
  lock: CanonicalPersistenceLock,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2 & { record: IdleLockRecoveryJournalV2 }> {
  let state = await readJournalStateV2(lock, runtime, policy);
  if (state.record.phase !== "idle") state = await recoverActiveJournalV2(lock, state as JournalStateV2 & {
    record: ActiveLockRecoveryJournalV2;
  }, runtime, policy);
  if (state.record.phase !== "idle") fail("LOCK_JOURNAL_UNSAFE");
  await classifyDomainRoot(lock, state.record, runtime, policy);
  return state as JournalStateV2 & { record: IdleLockRecoveryJournalV2 };
}

async function acquireNative(
  lock: CanonicalPersistenceLock,
  runtime: FileLockRuntime,
  policy: FileLockPolicy,
  signal?: AbortSignal
): Promise<NativeLockHandle> {
  const addon = await runtime.loadAddon();
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    abortIfRequested(signal);
    try {
      return addon.tryAcquireAnchor(lock.anchorPath);
    } catch (error) {
      const busy = error instanceof NativeLockError ? error.code === "LOCK_BUSY" :
        typeof error === "object" && error !== null && (error as { code?: unknown }).code === "LOCK_BUSY";
      if (!busy) throw error;
      if (attempt + 1 >= policy.attempts) fail("LOCK_TIMEOUT");
      await runtime.wait(policy.waitMs, signal).catch((waitError) => {
        if (signal?.aborted || errno(waitError) === "ABORT_ERR") fail("LOCK_ABORTED");
        throw waitError;
      });
    }
  }
  fail("LOCK_TIMEOUT");
}

interface OwnedStateV2 {
  journal: JournalStateV2 & { record: ActiveLockRecoveryJournalV2 };
  compatibilityProtected: boolean;
  pendingBarrierIdentity?: string;
}

async function writeLeaseTransactionV2(
  lock: CanonicalPersistenceLock,
  state: JournalStateV2 & { record: ActiveLockRecoveryJournalV2 },
  text: string,
  operation: "create" | "replace",
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<JournalStateV2 & { record: ActiveLockRecoveryJournalV2 }> {
  const lease = leasePayloadForJournal(text, state.record, operation);
  const leasePath = join(lock.compatibilityPath, "lease.json");
  const temporaryPath = journalTemporaryPath(leasePath);
  const fromIdentity = operation === "replace" ? state.record.leaseIdentity : undefined;
  await inspectBarrierClosed(lock, state.record, runtime, policy);
  const preflightTarget = await stableProtocolFile(
    leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED"
  );
  if (operation === "create") {
    if (preflightTarget !== undefined) fail("LOCK_LEASE_OCCUPIED");
  } else {
    currentLeaseForJournal(preflightTarget, state.record);
  }
  const preflightTemporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (preflightTemporary !== undefined) fail("LOCK_JOURNAL_UNSAFE");
  const pending: PendingLeaseWriteV2 = {
    operation,
    ...(fromIdentity === undefined ? {} : { fromIdentity }),
    payloadSha256: leasePayloadHash(text)
  };
  const pendingRecord = nextJournalRecord(state, { ...activeWithoutPending(state.record), pendingLeaseWrite: pending });
  let current = await commitJournalV2(lock, state, pendingRecord, runtime, policy) as JournalStateV2 & {
    record: ActiveLockRecoveryJournalV2;
  };
  await inspectBarrierClosed(lock, current.record, runtime, policy);
  const existingTarget = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
  if (operation === "create" ? existingTarget !== undefined : existingTarget?.identity !== fromIdentity) {
    fail("LOCK_LEASE_OCCUPIED");
  }
  const existingTemporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (existingTemporary !== undefined) fail("LOCK_JOURNAL_UNSAFE");
  const temporary = await retryDiagnostic(runtime, policy, undefined,
    () => runtime.io.createFileDurable(temporaryPath, text));
  const stableTemporary = await stableProtocolFile(temporaryPath, LEASE_MAX_BYTES, runtime, policy);
  if (stableTemporary?.identity !== temporary.identity || stableTemporary.text !== text) fail("LOCK_JOURNAL_UNSAFE");
  const recordedPending: PendingLeaseWriteV2 = { ...pending, temporaryIdentity: temporary.identity };
  const recorded = nextJournalRecord(current, {
    ...activeWithoutPending(current.record), pendingLeaseWrite: recordedPending
  });
  current = await commitJournalV2(lock, current, recorded, runtime, policy) as typeof current;
  await inspectBarrierClosed(lock, current.record, runtime, policy);
  await replaceAuthorizedTemporary(
    temporaryPath, leasePath, stableTemporary, operation === "create" ? undefined : fromIdentity, runtime, policy
  );
  const finalized = nextJournalRecord(current, {
    ...activeWithoutPending(current.record), phase: "lease-created", leaseIdentity: temporary.identity,
    heartbeatAt: lease.heartbeatAt
  });
  return await commitJournalV2(lock, current, finalized, runtime, policy) as typeof current;
}

async function cleanupOwnedStateV2(
  lock: CanonicalPersistenceLock,
  owned: OwnedStateV2,
  handle: NativeLockHandle,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<void> {
  let state = owned.journal;
  if (state.record.pendingLeaseWrite !== undefined) {
    state = await resolvePendingLeaseV2(lock, state, runtime, policy);
    owned.journal = state;
  }
  if (state.record.phase === "intent") {
    const barrier = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.inspectDirectory(lock.compatibilityPath));
    if (barrier === undefined) {
      const idle = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
      await commitJournalV2(lock, state, idle, runtime, policy);
      return;
    }
    validateDirectory(barrier, runtime, owned.pendingBarrierIdentity);
    if (barrier.entries.length !== 0 || owned.pendingBarrierIdentity === undefined) fail("LOCK_JOURNAL_UNSAFE");
    const adopted = nextJournalRecord(state, {
      ...activeWithoutPending(state.record), phase: "barrier-created", barrierIdentity: barrier.identity
    });
    state = await commitJournalV2(lock, state, adopted, runtime, policy) as typeof state;
    owned.journal = state;
  }
  if (state.record.phase === "barrier-created") {
    const barrier = await inspectBarrierClosed(lock, state.record, runtime, policy);
    if (barrier === undefined || barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(lock, state, runtime, policy);
    owned.journal = state;
  } else if (state.record.phase === "lease-created") {
    const leasePath = join(lock.compatibilityPath, "lease.json");
    const lease = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
    const parsed = lease === undefined ? undefined : parseLease(lease.text);
    if (lease === undefined || lease.identity !== state.record.leaseIdentity || parsed?.nonce !== state.record.nonce) {
      fail("LOCK_LEASE_OCCUPIED");
    }
    const cleanup = nextJournalRecord(state, {
      ...activeWithoutPending(state.record), phase: "cleanup", leaseIdentity: lease.identity
    });
    state = await commitJournalV2(lock, state, cleanup, runtime, policy) as typeof state;
    owned.journal = state;
    await retryDiagnostic(runtime, policy, undefined, () => runtime.io.removeFile(leasePath, lease.identity));
    const empty = await inspectBarrierClosed(lock, state.record, runtime, policy);
    if (empty === undefined || empty.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
    state = await commitBarrierOnlyCleanupV2(lock, state, runtime, policy);
    owned.journal = state;
  }
  if (state.record.phase !== "cleanup" || state.record.leaseIdentity !== undefined) fail("LOCK_JOURNAL_UNSAFE");
  const barrier = await inspectBarrierClosed(lock, state.record, runtime, policy);
  if (barrier === undefined || barrier.entries.length !== 0) fail("LOCK_JOURNAL_UNSAFE");
  if (owned.compatibilityProtected) {
    handle.releaseCompatibilityDirectory();
    owned.compatibilityProtected = false;
  }
  await retryDiagnostic(runtime, policy, undefined,
    () => runtime.io.removeDirectory(lock.compatibilityPath, state.record.barrierIdentity!));
  const idle = nextJournalRecord(state, { schemaVersion: 2, phase: "idle" });
  await commitJournalV2(lock, state, idle, runtime, policy);
}

async function runOwnedV2<T>(
  lock: CanonicalPersistenceLock,
  operation: () => Promise<T>,
  options: FileLockOptions,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<T> {
  abortIfRequested(options.signal);
  await retryDiagnostic(runtime, policy, options.signal, () => runtime.io.ensureDirectory(lock.domainRoot));
  const handle = await acquireNative(lock, runtime, policy, options.signal);
  let owned: OwnedStateV2 | undefined;
  let heartbeat: HeartbeatSchedule | undefined;
  let lifecycle = Promise.resolve();
  let result!: T;
  let operationError: unknown;
  let operationFailed = false;
  let cleanupError: unknown;
  let cleanupFailed = false;

  const serialized = <V>(callback: () => Promise<V>): Promise<V> => {
    const current = lifecycle.then(callback, callback);
    lifecycle = current.then(() => undefined, () => undefined);
    return current;
  };

  try {
    const idleJournal = await reconcileJournalV2(lock, runtime, policy);
    const existing = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.inspectDirectory(lock.compatibilityPath));
    if (existing !== undefined) fail("LEGACY_LOCK_BLOCKED");
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
    let journal = await commitJournalV2(lock, idleJournal, intent, runtime, policy) as JournalStateV2 & {
      record: ActiveLockRecoveryJournalV2;
    };
    const currentOwned: OwnedStateV2 = { journal, compatibilityProtected: false };
    owned = currentOwned;
    const barrier = await retryDiagnostic(runtime, policy, undefined,
      () => runtime.io.createDirectory(lock.compatibilityPath));
    validateDirectory(barrier, runtime);
    currentOwned.pendingBarrierIdentity = barrier.identity;
    const barrierRecord = nextJournalRecord(journal, {
      ...activeWithoutPending(journal.record), phase: "barrier-created", barrierIdentity: barrier.identity
    });
    journal = await commitJournalV2(lock, journal, barrierRecord, runtime, policy) as typeof journal;
    currentOwned.journal = journal;
    currentOwned.pendingBarrierIdentity = undefined;
    handle.protectCompatibilityDirectory(lock.compatibilityPath);
    currentOwned.compatibilityProtected = true;
    const lease: FileLockLeaseV1 = {
      schemaVersion: 1,
      pid: runtime.pid,
      nonce,
      startedAt: journal.record.startedAt,
      heartbeatAt: journal.record.heartbeatAt
    };
    journal = await writeLeaseTransactionV2(
      lock, journal, `${JSON.stringify(lease)}\n`, "create", runtime, policy
    );
    currentOwned.journal = journal;
    const leasePath = join(lock.compatibilityPath, "lease.json");

    heartbeat = runtime.scheduleHeartbeat(policy.heartbeatMs, async () => serialized(async () => {
      if (owned === undefined || owned.journal.record.phase !== "lease-created") return;
      const current = await stableProtocolFile(leasePath, LEASE_MAX_BYTES, runtime, policy, "LOCK_LEASE_OCCUPIED");
      const currentLease = current === undefined ? undefined : parseLease(current.text);
      if (current === undefined || current.identity !== owned.journal.record.leaseIdentity ||
        currentLease === undefined || currentLease.nonce !== nonce) fail("LOCK_LEASE_OCCUPIED");
      const heartbeatAt = iso(Math.max(
        runtime.now(), Date.parse(currentLease.startedAt), Date.parse(currentLease.heartbeatAt)
      ));
      const replacement: FileLockLeaseV1 = { ...currentLease, heartbeatAt };
      owned.journal = await writeLeaseTransactionV2(
        lock, owned.journal, `${JSON.stringify(replacement)}\n`, "replace", runtime, policy
      );
    }));
    result = await operation();
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  try {
    if (heartbeat !== undefined) await heartbeat.stop();
    await lifecycle;
    if (owned !== undefined) {
      const refreshed = await readJournalStateV2(lock, runtime, policy);
      if (refreshed.record.phase === "idle") {
        owned = undefined;
      } else {
        owned.journal = refreshed as JournalStateV2 & { record: ActiveLockRecoveryJournalV2 };
        await cleanupOwnedStateV2(lock, owned, handle, runtime, policy);
      }
    }
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
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

function enqueueExactPath<T>(
  path: string,
  operation: () => Promise<T>,
  options: FileLockOptions,
  runtime: FileLockRuntime,
  policy: FileLockPolicy
): Promise<T> {
  let resolveCaller!: (value: T | PromiseLike<T>) => void;
  let rejectCaller!: (reason?: unknown) => void;
  const caller = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveCaller = resolvePromise;
    rejectCaller = rejectPromise;
  });
  const node: ExactPathQueueNode = {
    operation: operation as () => Promise<unknown>,
    runtime,
    signal: options.signal,
    resolve: resolveCaller as (value: unknown) => void,
    reject: rejectCaller,
    controller: new AbortController(),
    started: false,
    canceled: false
  };

  const detach = (): void => {
    if (node.abortListener !== undefined) node.signal?.removeEventListener("abort", node.abortListener);
    node.controller?.abort();
    node.operation = undefined;
    node.runtime = undefined;
    node.signal = undefined;
    node.resolve = undefined;
    node.reject = undefined;
    node.controller = undefined;
    node.abortListener = undefined;
  };

  const finish = (queue: ExactPathQueue): void => {
    while (queue.waiting.length > 0) {
      const next = queue.waiting.shift()!;
      if (next.canceled) continue;
      queue.active = next;
      start(queue, next);
      return;
    }
    if (sameProcessQueues.get(path) === queue) sameProcessQueues.delete(path);
  };

  const start = (queue: ExactPathQueue, current: ExactPathQueueNode): void => {
    current.started = true;
    if (current.abortListener !== undefined) current.signal?.removeEventListener("abort", current.abortListener);
    current.controller?.abort();
    current.abortListener = undefined;
    current.controller = undefined;
    current.signal = undefined;
    const currentOperation = current.operation!;
    const resolveCurrent = current.resolve!;
    const rejectCurrent = current.reject!;
    current.operation = undefined;
    current.runtime = undefined;
    current.resolve = undefined;
    current.reject = undefined;
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
  if (existing === undefined) {
    const queue: ExactPathQueue = { active: node, waiting: [] };
    sameProcessQueues.set(path, queue);
    start(queue, node);
    return caller;
  }

  const cancel = (code: "LOCK_ABORTED" | "LOCK_TIMEOUT"): void => {
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
    const controller = node.controller!;
    void runtime.wait(policy.attempts * policy.waitMs, controller.signal).then(
      () => cancel("LOCK_TIMEOUT"),
      () => { if (node.signal?.aborted) cancel("LOCK_ABORTED"); }
    );
  }
  return caller;
}

function validateInvocation(
  lock: CanonicalPersistenceLock,
  capability: LegacyRuntimeShutdownCapability | undefined,
  policy: FileLockPolicy
): void {
  if (!isLegacyRuntimeShutdownCapability(capability)) fail("LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED");
  if (!isCanonicalPersistenceLock(lock)) fail("INVALID_PERSISTENCE_LOCK");
  validatePolicy(policy);
}

export async function runWithFileLock<T>(
  lock: CanonicalPersistenceLock,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const capability = requireLegacyRuntimeShutdownCapability();
  validateInvocation(lock, capability, DEFAULT_FILE_LOCK_POLICY);
  return enqueueExactPath(lock.compatibilityPath,
    () => runOwnedV2(lock, operation, options, productionRuntime, DEFAULT_FILE_LOCK_POLICY),
    options, productionRuntime, DEFAULT_FILE_LOCK_POLICY);
}

export interface FileLockTestingSeam {
  readonly capability?: LegacyRuntimeShutdownCapability;
  readonly runtime?: FileLockRuntime;
  readonly policy?: FileLockPolicy;
}

export async function runWithFileLockForTesting<T>(
  lock: CanonicalPersistenceLock,
  operation: () => Promise<T>,
  options: FileLockOptions,
  seam: FileLockTestingSeam
): Promise<T> {
  const policy = seam.policy ?? DEFAULT_FILE_LOCK_POLICY;
  validateInvocation(lock, seam.capability, policy);
  if (seam.runtime === undefined) throw new TypeError("The test lock runtime is required.");
  return enqueueExactPath(lock.compatibilityPath,
    () => runOwnedV2(lock, operation, options, seam.runtime!, policy),
    options, seam.runtime, policy);
}

export function sameProcessLockQueueSizeForTesting(): number {
  return sameProcessQueues.size;
}

export function sameProcessLockQueueEntryCountForTesting(): number {
  let count = 0;
  for (const queue of sameProcessQueues.values()) count += 1 + queue.waiting.length;
  return count;
}

function identity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

function restrictive(stats: BigIntStats, directory: boolean): boolean {
  if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())) return false;
  if (!directory && stats.nlink !== 1n) return false;
  if (process.platform !== "win32") {
    if ((Number(stats.mode) & 0o077) !== 0) return false;
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== BigInt(uid)) return false;
  }
  return true;
}

async function flushDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "EPERM", "EACCES", "EBADF", "ENOTSUP"].includes(errno(error))) throw error;
  } finally {
    await handle?.close();
  }
}

async function productionReadFile(path: string, maximumBytes: number): Promise<FileSnapshot | undefined> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!restrictive(before, false) || before.size > BigInt(maximumBytes)) fail("LOCK_LEASE_OCCUPIED");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!restrictive(opened, false) || identity(opened) !== identity(before) || opened.size > BigInt(maximumBytes)) {
      fail("LOCK_LEASE_OCCUPIED");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (identity(after) !== identity(opened) || bytes.length > maximumBytes) fail("LOCK_LEASE_OCCUPIED");
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

async function productionInspectDirectory(path: string): Promise<DirectorySnapshot | undefined> {
  let stats: BigIntStats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!restrictive(stats, true)) {
    if (stats.isFile() && !stats.isSymbolicLink()) fail("LEGACY_LOCK_BLOCKED");
    fail("UNSAFE_LOCK_DIRECTORY");
  }
  const entries = (await readdir(path)).sort();
  const after = await lstat(path, { bigint: true });
  if (!restrictive(after, true) || identity(after) !== identity(stats)) fail("UNSAFE_LOCK_DIRECTORY");
  return { identity: identity(after), mode: Number(after.mode), entries };
}

async function productionCreateDirectory(path: string): Promise<DirectorySnapshot> {
  await mkdir(path, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
  await flushDirectory(dirname(path));
  const snapshot = await productionInspectDirectory(path);
  if (snapshot === undefined) fail("UNSAFE_LOCK_DIRECTORY");
  return snapshot;
}

async function productionCreateFileDurable(
  path: string,
  text: string,
  crashPoint?: "after-create" | "after-write" | "after-sync"
): Promise<FileSnapshot> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const simulateCrash = (point: "after-create" | "after-write" | "after-sync"): void => {
    if (crashPoint !== point) return;
    throw Object.assign(new Error("Simulated durable-write crash."), {
      code: "SIMULATED_DURABLE_WRITE_CRASH" as const
    });
  };
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  try {
    simulateCrash("after-create");
    await handle.writeFile(text, "utf8");
    simulateCrash("after-write");
    await handle.sync();
    simulateCrash("after-sync");
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
  await flushDirectory(dirname(path));
  const snapshot = await productionReadFile(path, LEASE_MAX_BYTES);
  if (snapshot === undefined) fail("LOCK_LEASE_OCCUPIED");
  return snapshot;
}

async function productionReplaceFileFromTemporary(
  temporaryPath: string,
  targetPath: string,
  temporaryIdentity: string,
  expectedTargetIdentity?: string,
  crashPoint?: "after-rename" | "after-directory-flush"
): Promise<FileSnapshot> {
  const temporary = await productionReadFile(temporaryPath, JOURNAL_MAX_BYTES);
  const target = await productionReadFile(targetPath, JOURNAL_MAX_BYTES);
  if (temporary?.identity !== temporaryIdentity || temporary.nlink !== 1 ||
    (expectedTargetIdentity === undefined ? target !== undefined : target?.identity !== expectedTargetIdentity)) {
    fail("LOCK_JOURNAL_UNSAFE");
  }
  await rename(temporaryPath, targetPath);
  if (crashPoint === "after-rename") {
    throw Object.assign(new Error("Simulated durable-write crash."), { code: "SIMULATED_DURABLE_WRITE_CRASH" as const });
  }
  if (process.platform !== "win32") await chmod(targetPath, 0o600);
  await flushDirectory(dirname(targetPath));
  if (crashPoint === "after-directory-flush") {
    throw Object.assign(new Error("Simulated durable-write crash."), { code: "SIMULATED_DURABLE_WRITE_CRASH" as const });
  }
  const replaced = await productionReadFile(targetPath, JOURNAL_MAX_BYTES);
  if (replaced?.identity !== temporaryIdentity) fail("LOCK_JOURNAL_UNSAFE");
  return replaced;
}

export function createProductionProtocolFileForTesting(
  path: string,
  text: string,
  crashPoint?: "after-create" | "after-write" | "after-sync"
): Promise<FileSnapshot> {
  return productionCreateFileDurable(path, text, crashPoint);
}

export function replaceProductionProtocolFileForTesting(
  temporaryPath: string,
  targetPath: string,
  temporaryIdentity: string,
  expectedTargetIdentity?: string,
  crashPoint?: "after-rename" | "after-directory-flush"
): Promise<FileSnapshot> {
  return productionReplaceFileFromTemporary(
    temporaryPath, targetPath, temporaryIdentity, expectedTargetIdentity, crashPoint
  );
}

const productionIo: FileLockIo = Object.freeze({
  async ensureDirectory(path: string): Promise<void> {
    const absolute = resolve(path);
    const parsed = parse(absolute);
    let current = parsed.root;
    for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
      current = join(current, segment);
      try {
        const component = await lstat(current, { bigint: true });
        if (component.isSymbolicLink() || !component.isDirectory()) fail("UNSAFE_LOCK_DIRECTORY");
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        await mkdir(current, { recursive: false, mode: 0o700 });
        if (process.platform !== "win32") await chmod(current, 0o700);
      }
    }
    const stats = await lstat(path, { bigint: true });
    if (!restrictive(stats, true)) fail("UNSAFE_LOCK_DIRECTORY");
    if (process.platform !== "win32") await chmod(path, 0o700);
  },
  readFile: productionReadFile,
  inspectDirectory: productionInspectDirectory,
  createDirectory: productionCreateDirectory,
  createFileDurable: productionCreateFileDurable,
  replaceFileFromTemporary: productionReplaceFileFromTemporary,
  async flushParentDirectory(path: string): Promise<void> {
    await flushDirectory(dirname(path));
  },
  async removeFile(path: string, expectedIdentity: string): Promise<void> {
    const snapshot = await productionReadFile(path, JOURNAL_MAX_BYTES);
    if (snapshot?.identity !== expectedIdentity) fail("LOCK_LEASE_OCCUPIED");
    await unlink(path);
    await flushDirectory(dirname(path));
  },
  async removeDirectory(path: string, expectedIdentity: string): Promise<void> {
    const snapshot = await productionInspectDirectory(path);
    if (snapshot === undefined || snapshot.identity !== expectedIdentity || snapshot.entries.length !== 0) {
      fail("UNSAFE_LOCK_DIRECTORY");
    }
    await rmdir(path);
    await flushDirectory(dirname(path));
  }
});

export function productionFileLockIoForTesting(): FileLockIo {
  return productionIo;
}

function productionWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new FileLockError("LOCK_ABORTED"));
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const abort = (): void => {
      clearTimeout(timer);
      reject(new FileLockError("LOCK_ABORTED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const productionRuntime: FileLockRuntime = Object.freeze({
  pid: process.pid,
  platform: process.platform,
  now: () => Date.now(),
  randomUUID,
  wait: productionWait,
  processLiveness(pid: number): ProcessLiveness {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      if (errno(error) === "ESRCH") return "dead";
      return "unknown";
    }
  },
  loadAddon: () => getNativeLockAddon(),
  scheduleHeartbeat(milliseconds: number, callback: () => Promise<void>): HeartbeatSchedule {
    let chain = Promise.resolve();
    let failure: unknown;
    let failed = false;
    const timer = setInterval(() => {
      chain = chain.then(callback).catch((error) => {
        if (!failed) failure = error;
        failed = true;
      });
    }, milliseconds);
    timer.unref?.();
    return Object.freeze({
      async stop(): Promise<void> {
        clearInterval(timer);
        await chain;
        if (failed) throw failure;
      }
    });
  },
  io: productionIo
});
