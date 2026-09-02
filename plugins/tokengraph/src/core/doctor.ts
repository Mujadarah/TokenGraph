import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { DEFAULT_TOKEN_GRAPH_CONFIG } from "./config.js";
import { scanProjectSignature } from "./fileScanner.js";
import { getLegacyRuntimeActivationStatus } from "./legacyRuntimeActivation.js";
import { PINNED_GRAMMARS, TREE_SITTER_RUNTIME } from "./polyglot.js";
import { indexManifestPath, indexPath, stateDir } from "./persistence.js";
import { projectIndexFingerprint, validatedContentSetHash } from "./projectIndexer.js";
import { getRepositoryIdentityReadOnly } from "./repositoryIdentity.js";
import { assertNoSymbolicLinkComponents, readStableAtomicTarget, readWriteTelemetry } from "./storage.js";
import { storageClassUsage, type StorageClassUsage } from "./storagePolicy.js";
import { inspectTaskLedgerReadOnly, TASK_LEDGER_RETENTION_DAYS } from "./taskLedger.js";
import type { ProjectIndex, RepositoryIdentity, StorageWritePolicy } from "./types.js";
import { TOKEN_GRAPH_RUNTIME_VERSION } from "./version.js";

export type DoctorStatus = "healthy" | "degraded" | "blocked";
export type DoctorAttestationStatus = "valid" | "missing" | "invalid" | "unsupported" | "expired" | "mismatched" | "detached" | "unstable" | "unavailable";
export type DoctorWorkspace =
  | { status: "ready"; source: string; root: string }
  | { status: "blocked"; source: string; blockingReason: string };

export interface DoctorReport {
  schemaVersion: 1;
  status: DoctorStatus;
  workspace: { status: "ready" | "blocked"; source: string; blockingReason?: string };
  stateAccess: "safe" | "blocked";
  versions: {
    runtime: string;
    node: string;
    package: string | null;
    codexManifest: string | null;
    claudeManifest: string | null;
    generatedRelease: { package: string | null; codexManifest: string | null; claudeManifest: string | null } | null;
    agreement: "match" | "mismatch" | "unavailable";
  };
  lifecycle: { attestation: DoctorAttestationStatus; nativeLockActivation: "activated" | "unactivated" };
  parser: {
    runtime: typeof TREE_SITTER_RUNTIME;
    grammars: Array<{ language: keyof typeof PINNED_GRAMMARS; version: string; present: boolean; bytes?: number; sha256?: string }>;
  };
  leases: { active: number; stale: number; malformed: number };
  ledgers: { open: number; paused: number; completed: number; orphanCandidates: number; malformed: number };
  storage: {
    usage: StorageClassUsage;
    quotas: { maxBytes: number; runsMaxBytes: number; cacheMaxBytes: number; vaultMaxBytes: number; durableMaxBytes: number };
    writePolicy: StorageWritePolicy;
    recentWrites: { operations: number; logicalBytes: number; physicalBytes: number | null; sampledPeakRssBytes: number; available: boolean };
    quotaPressure: boolean;
    configState: "default" | "valid" | "invalid";
  };
  index: {
    presence: "missing" | "present" | "corrupt";
    state: "missing" | "fresh" | "stale" | "corrupt" | "unknown";
    schemaVersion: number | null;
    generation: string | null;
    rootValid: boolean | null;
    identityValid: boolean | null;
    metadataContentConsistent: boolean | null;
  };
  recommendations: string[];
}

export interface CollectDoctorReportOptions {
  workspace: DoctorWorkspace;
  pluginRoot: string;
  attestation?: DoctorAttestationStatus;
  now?: Date;
}

type JsonObject = Record<string, unknown>;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_PATTERN = /^\.index-generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const FILE_LOCK_STALE_MS = 30_000;
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024;
const LOCK_WALK_LIMIT = 10_000;
const LOCK_INFRASTRUCTURE_NAMES = new Set([
  ".tokengraph-native-anchor-v2.lock",
  ".tokengraph-native-journal-v2.lock",
  ".tokengraph-native-journal-v2.tmp"
]);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyUsage(): StorageClassUsage {
  const empty = () => ({ bytes: 0, files: 0 });
  return { total: empty(), runs: empty(), cache: empty(), vault: empty(), durable: empty() };
}

function defaultStorage(): DoctorReport["storage"] {
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

async function readJson(path: string, maximumBytes: number): Promise<{ state: "missing" | "present" | "corrupt"; value?: JsonObject }> {
  try {
    const content = await readStableAtomicTarget(path, maximumBytes);
    if (content === undefined) return { state: "missing" };
    const parsed = JSON.parse(content) as unknown;
    return isObject(parsed) ? { state: "present", value: parsed } : { state: "corrupt" };
  } catch (error) {
    if (error instanceof SyntaxError) return { state: "corrupt" };
    throw error;
  }
}

async function readVersion(path: string): Promise<string | null> {
  const result = await readJson(path, 1024 * 1024);
  return result.state === "present" && typeof result.value?.version === "string" ? result.value.version : null;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readStableBuffer(path: string, maximumBytes: number): Promise<Buffer | undefined> {
  await assertNoSymbolicLinkComponents(path);
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(maximumBytes)) {
    throw new Error("TokenGraph doctor asset is not a bounded single-link regular file.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile();
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
        !sameFileIdentity(before, opened) || !sameFileIdentity(before, after)) {
      throw new Error("TokenGraph doctor asset changed while it was being read.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function collectVersions(pluginRoot: string): Promise<DoctorReport["versions"]> {
  const root = resolve(pluginRoot);
  const [packageVersion, codexManifest, claudeManifest] = await Promise.all([
    readVersion(join(root, "package.json")),
    readVersion(join(root, ".codex-plugin", "plugin.json")),
    readVersion(join(root, ".claude-plugin", "plugin.json"))
  ]);
  const sourceLayout = await lstat(join(root, "src")).then((entry) => entry.isDirectory() && !entry.isSymbolicLink()).catch(() => false);
  let generatedRelease: DoctorReport["versions"]["generatedRelease"] = null;
  if (sourceLayout) {
    const releaseRoot = resolve(root, "..", "..", "release", "tokengraph");
    const [releasePackage, releaseCodex, releaseClaude] = await Promise.all([
      readVersion(join(releaseRoot, "package.json")),
      readVersion(join(releaseRoot, ".codex-plugin", "plugin.json")),
      readVersion(join(releaseRoot, ".claude-plugin", "plugin.json"))
    ]);
    generatedRelease = { package: releasePackage, codexManifest: releaseCodex, claudeManifest: releaseClaude };
  }
  const requiredVersions = [
    TOKEN_GRAPH_RUNTIME_VERSION,
    packageVersion,
    codexManifest,
    claudeManifest,
    ...(generatedRelease ? [generatedRelease.package, generatedRelease.codexManifest, generatedRelease.claudeManifest] : [])
  ];
  const known = requiredVersions.filter((value): value is string => typeof value === "string");
  const agreement = packageVersion === null && codexManifest === null && claudeManifest === null
    ? "unavailable" as const
    : requiredVersions.some((value) => value === null)
      ? "mismatch" as const
      : new Set(known).size === 1 ? "match" as const : "mismatch" as const;
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

async function collectParser(pluginRoot: string): Promise<DoctorReport["parser"]> {
  const assetRoot = join(resolve(pluginRoot), "assets", "grammars");
  const grammars = await Promise.all(Object.entries(PINNED_GRAMMARS).map(async ([language, grammar]) => {
    try {
      const content = await readStableBuffer(join(assetRoot, grammar.asset), 32 * 1024 * 1024);
      if (content === undefined) return { language: language as keyof typeof PINNED_GRAMMARS, version: grammar.version, present: false };
      return {
        language: language as keyof typeof PINNED_GRAMMARS,
        version: grammar.version,
        present: content.length > 0,
        ...(content.length ? { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") } : {})
      };
    } catch {
      return { language: language as keyof typeof PINNED_GRAMMARS, version: grammar.version, present: false };
    }
  }));
  return { runtime: TREE_SITTER_RUNTIME, grammars };
}

function isLease(value: JsonObject): value is JsonObject & { pid: number; startedAt: string; heartbeatAt: string } {
  return value.schemaVersion === 1 && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 &&
    typeof value.nonce === "string" && UUID_PATTERN.test(value.nonce) &&
    typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)) &&
    typeof value.heartbeatAt === "string" && Number.isFinite(Date.parse(value.heartbeatAt)) &&
    Date.parse(value.heartbeatAt) >= Date.parse(value.startedAt);
}

async function collectLeases(root: string, now: Date): Promise<DoctorReport["leases"]> {
  const result = { active: 0, stale: 0, malformed: 0 };
  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > LOCK_WALK_LIMIT) throw new Error("TokenGraph doctor lock inspection exceeded its bounded entry limit.");
      if (entry.isSymbolicLink()) throw new Error("TokenGraph doctor refuses symbolic links in state.");
      const path = join(directory, entry.name);
      if (LOCK_INFRASTRUCTURE_NAMES.has(entry.name)) continue;
      if (entry.name.toLowerCase().endsWith(".lock")) {
        if (!entry.isDirectory()) {
          result.malformed += 1;
          continue;
        }
        const lease = await readJson(join(path, "lease.json"), 4 * 1024);
        if (lease.state !== "present" || !isLease(lease.value!)) result.malformed += 1;
        else if (now.getTime() - Date.parse(lease.value!.heartbeatAt as string) > FILE_LOCK_STALE_MS) result.stale += 1;
        else result.active += 1;
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(stateDir(root));
  return result;
}

async function collectLedgers(root: string, now: Date): Promise<DoctorReport["ledgers"]> {
  const result = { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 };
  let entries: Dirent[];
  try {
    entries = await readdir(join(stateDir(root), "tasks"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  const cutoff = now.getTime() - TASK_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (entry.name === "completed-outcomes.json") continue;
    const taskId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    if (entry.isSymbolicLink() || !entry.isFile() || !UUID_PATTERN.test(taskId)) {
      result.malformed += 1;
      continue;
    }
    const inspected = await inspectTaskLedgerReadOnly(resolve(root), taskId);
    if (inspected.status !== "valid") {
      result.malformed += 1;
      continue;
    }
    const ledger = inspected.ledger;
    if (ledger.status === "open") {
      result.open += 1;
      if (ledger.events.length === 0 && Date.parse(ledger.updatedAt) < cutoff) result.orphanCandidates += 1;
    } else if (ledger.status === "paused") result.paused += 1;
    else if (ledger.status === "completed") result.completed += 1;
  }
  return result;
}

type DoctorStorageConfig = Pick<DoctorReport["storage"], "quotas" | "writePolicy" | "configState">;

function configuredStorage(value: JsonObject | undefined, state: "missing" | "present" | "corrupt"): DoctorStorageConfig {
  if (state === "missing") {
    const defaults = defaultStorage();
    return { quotas: defaults.quotas, writePolicy: defaults.writePolicy, configState: "default" };
  }
  if (!value) {
    const defaults = defaultStorage();
    return { quotas: defaults.quotas, writePolicy: defaults.writePolicy, configState: "invalid" };
  }
  const config = isObject(value.config) ? value.config : undefined;
  const storage = config && isObject(config.storage) ? config.storage : undefined;
  const defaults = DEFAULT_TOKEN_GRAPH_CONFIG.storage;
  const integer = (key: keyof typeof defaults) => typeof storage?.[key] === "number" && Number.isSafeInteger(storage[key]) && Number(storage[key]) >= 0
    ? Number(storage[key])
    : defaults[key] as number;
  const writePolicy = storage?.writePolicy === "minimal" || storage?.writePolicy === "balanced" || storage?.writePolicy === "durable"
    ? storage.writePolicy
    : defaults.writePolicy;
  const numericKeys = ["maxBytes", "runsMaxBytes", "cacheMaxBytes", "vaultMaxBytes", "durableMaxBytes", "runRetentionDays", "cacheRetentionDays"] as const;
  const valid = value.schemaVersion === 4 && Boolean(config) && Boolean(storage) && storage?.writePolicy === writePolicy &&
    numericKeys.every((key) => typeof storage?.[key] === "number" && Number.isSafeInteger(storage[key]) && Number(storage[key]) >= 0);
  return {
    quotas: {
      maxBytes: integer("maxBytes"),
      runsMaxBytes: integer("runsMaxBytes"),
      cacheMaxBytes: integer("cacheMaxBytes"),
      vaultMaxBytes: integer("vaultMaxBytes"),
      durableMaxBytes: integer("durableMaxBytes")
    },
    writePolicy,
    configState: valid ? "valid" : "invalid"
  };
}

async function collectStorage(root: string): Promise<DoctorReport["storage"]> {
  const [usage, config, telemetry] = await Promise.all([
    storageClassUsage(root),
    readJson(join(stateDir(root), "config.json"), 1024 * 1024),
    readWriteTelemetry(root)
  ]);
  const configured = configuredStorage(config.value, config.state);
  let operations = 0;
  let logicalBytes = 0;
  let physicalBytes = 0;
  let physicalAvailable = false;
  let sampledPeakRssBytes = 0;
  for (const day of telemetry.days) {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, day.sampledPeakRssBytes);
    for (const aggregate of Object.values(day.classes)) {
      if (!aggregate) continue;
      operations += aggregate.operationCount;
      logicalBytes += aggregate.logicalBytes;
      if (aggregate.physicalBytes !== undefined) {
        physicalAvailable = true;
        physicalBytes += aggregate.physicalBytes;
      }
    }
  }
  return {
    usage,
    quotas: configured.quotas,
    writePolicy: configured.writePolicy,
    configState: configured.configState,
    recentWrites: {
      operations,
      logicalBytes,
      physicalBytes: physicalAvailable ? physicalBytes : null,
      sampledPeakRssBytes,
      available: telemetry.days.length > 0
    },
    quotaPressure: usage.total.bytes > configured.quotas.maxBytes || usage.runs.bytes > configured.quotas.runsMaxBytes ||
      usage.cache.bytes > configured.quotas.cacheMaxBytes || usage.vault.bytes > configured.quotas.vaultMaxBytes ||
      usage.durable.bytes > configured.quotas.durableMaxBytes
  };
}

function isSafeRelativeFile(root: string, path: unknown): path is string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  const nested = relative(resolve(root), resolve(root, path));
  return Boolean(nested) && !nested.startsWith("..") && !isAbsolute(nested);
}

function sameIdentity(left: RepositoryIdentity | undefined, right: RepositoryIdentity | undefined): boolean | null {
  if (!left || !right) return null;
  return left.repositoryId === right.repositoryId && left.repositoryFingerprint === right.repositoryFingerprint &&
    left.workspaceId === right.workspaceId && left.worktreeId === right.worktreeId && left.branch === right.branch &&
    left.headCommit === right.headCommit && left.remoteIdentity === right.remoteIdentity;
}

function isInspectableIndex(value: JsonObject): value is JsonObject & ProjectIndex {
  const sql = value.sql;
  return (value.schemaVersion === 4 || value.schemaVersion === 5) && typeof value.root === "string" &&
    typeof value.scannedAt === "string" && typeof value.fingerprint === "string" &&
    Array.isArray(value.files) && Array.isArray(value.symbols) && Array.isArray(value.imports) &&
    Array.isArray(value.exclusions) && Array.isArray(value.frameworks) && isObject(sql) &&
    ["tables", "relations", "policies", "indexes", "triggers", "functions", "views", "constraints", "enums", "extensions", "grants", "materializedViews", "history"]
      .every((key) => Array.isArray(sql[key]));
}

async function metadataMatchesContent(root: string, index: ProjectIndex): Promise<boolean> {
  if (!index.scanMetadata?.files || !Array.isArray(index.scanMetadata.exclusions)) return false;
  const metadata = index.scanMetadata.files;
  const files = index.files;
  const paths = files.map((file) => file.path).sort();
  const metadataPaths = Object.keys(metadata).sort();
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify(metadataPaths)) return false;
  for (const file of files) {
    if (!isSafeRelativeFile(root, file.path) || !SHA256_PATTERN.test(file.contentHash) || metadata[file.path]?.contentHash !== file.contentHash) return false;
    const content = await readStableAtomicTarget(resolve(root, file.path));
    if (content === undefined || createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex") !== file.contentHash) return false;
  }
  return true;
}

async function indexedFilesMatchContent(root: string, index: ProjectIndex): Promise<boolean> {
  const paths = index.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) return false;
  for (const file of index.files) {
    if (!isSafeRelativeFile(root, file.path) || !SHA256_PATTERN.test(file.contentHash)) return false;
    const content = await readStableAtomicTarget(resolve(root, file.path));
    if (content === undefined || createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex") !== file.contentHash) return false;
  }
  return true;
}

function generationMetadataValid(index: ProjectIndex): boolean {
  const generation = index.generation;
  const scanMetadata = index.scanMetadata;
  if (!generation || !scanMetadata?.files || !Array.isArray(scanMetadata.exclusions) || typeof index.scanSignature !== "string" || !SHA256_PATTERN.test(index.scanSignature)) return false;
  if (!GENERATION_PATTERN.test(`.index-generation-${generation.id}.json`) || generation.createdAt !== index.scannedAt ||
      generation.sourceScanSignature !== index.scanSignature || !SHA256_PATTERN.test(generation.sourceScanSignature)) return false;
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const scannerTerminal = scanMetadata.exclusions
    .filter((entry) => !indexedPaths.has(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  const indexedTerminal = index.exclusions
    .filter((entry) => !indexedPaths.has(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  return JSON.stringify(scannerTerminal) === JSON.stringify(indexedTerminal) &&
    generation.intendedFileCount === Object.keys(scanMetadata.files).length + new Set(indexedTerminal.map((entry) => entry.path)).size &&
    generation.terminalExclusionsHash === createHash("sha256").update(JSON.stringify(scannerTerminal)).digest("hex") &&
    generation.validatedContentSetHash === validatedContentSetHash(scanMetadata, index.exclusions);
}

async function collectIndex(root: string): Promise<DoctorReport["index"]> {
  const manifestRead = await readJson(indexManifestPath(root), MAX_MANIFEST_BYTES);
  let parsed: JsonObject | undefined;
  let generation: string | null = null;
  if (manifestRead.state === "corrupt") return { presence: "corrupt", state: "corrupt", schemaVersion: null, generation, rootValid: null, identityValid: null, metadataContentConsistent: null };
  if (manifestRead.state === "present") {
    const manifest = manifestRead.value!;
    const generationFile = manifest.generationFile;
    const match = typeof generationFile === "string" ? GENERATION_PATTERN.exec(generationFile) : null;
    if (Object.keys(manifest).length !== 3 || !match || basename(generationFile as string) !== generationFile || manifest.generationId !== match[1] ||
        typeof manifest.contentHash !== "string" || !SHA256_PATTERN.test(manifest.contentHash)) {
      return { presence: "corrupt", state: "corrupt", schemaVersion: null, generation, rootValid: null, identityValid: null, metadataContentConsistent: null };
    }
    const generationContent = await readStableAtomicTarget(join(stateDir(root), generationFile as string), MAX_JSON_BYTES);
    if (generationContent === undefined || createHash("sha256").update(generationContent).digest("hex") !== manifest.contentHash) {
      return { presence: "corrupt", state: "corrupt", schemaVersion: null, generation: match[1], rootValid: null, identityValid: null, metadataContentConsistent: null };
    }
    try {
      const value = JSON.parse(generationContent) as unknown;
      parsed = isObject(value) ? value : undefined;
    } catch {
      parsed = undefined;
    }
    generation = match[1];
    if (!parsed || parsed.schemaVersion !== 5 || !isObject(parsed.generation) || parsed.generation.id !== generation) {
      return { presence: "corrupt", state: "corrupt", schemaVersion: typeof parsed?.schemaVersion === "number" ? parsed.schemaVersion : null, generation, rootValid: null, identityValid: null, metadataContentConsistent: null };
    }
  } else {
    const legacy = await readJson(indexPath(root), MAX_JSON_BYTES);
    if (legacy.state === "missing") return { presence: "missing", state: "missing", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null };
    if (legacy.state === "corrupt") return { presence: "corrupt", state: "corrupt", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null };
    parsed = legacy.value;
  }
  if (!parsed || !isInspectableIndex(parsed)) {
    return { presence: "corrupt", state: "corrupt", schemaVersion: typeof parsed?.schemaVersion === "number" ? parsed.schemaVersion : null, generation, rootValid: null, identityValid: null, metadataContentConsistent: null };
  }
  const index = parsed as unknown as ProjectIndex;
  const rootValid = resolve(index.root) === resolve(root);
  const currentIdentity = await getRepositoryIdentityReadOnly(root);
  const identityValid = sameIdentity(index.repositoryIdentity, currentIdentity);
  let metadataContentConsistent = false;
  try {
    metadataContentConsistent = index.schemaVersion === 5
      ? await metadataMatchesContent(root, index) && generationMetadataValid(index) && index.fingerprint === projectIndexFingerprint(index)
      : index.schemaVersion === 4 && await indexedFilesMatchContent(root, index) && index.fingerprint === projectIndexFingerprint(index);
  } catch {
    metadataContentConsistent = false;
  }
  let state: DoctorReport["index"]["state"] = rootValid && identityValid === true && metadataContentConsistent ? "unknown" : "stale";
  if (state === "unknown" && typeof index.scanSignature === "string") {
    try {
      state = await scanProjectSignature(root) === index.scanSignature ? "fresh" : "stale";
    } catch {
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

function blockedReport(
  workspace: DoctorReport["workspace"],
  versions: DoctorReport["versions"],
  parser: DoctorReport["parser"],
  attestation: DoctorAttestationStatus,
  recommendation: string
): DoctorReport {
  return {
    schemaVersion: 1,
    status: "blocked",
    workspace,
    stateAccess: "blocked",
    versions,
    lifecycle: { attestation, nativeLockActivation: getLegacyRuntimeActivationStatus().activated ? "activated" : "unactivated" },
    parser,
    leases: { active: 0, stale: 0, malformed: 0 },
    ledgers: { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 },
    storage: defaultStorage(),
    index: { presence: "missing", state: "unknown", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null },
    recommendations: [recommendation]
  };
}

export async function collectDoctorReport(options: CollectDoctorReportOptions): Promise<DoctorReport> {
  const attestation = options.attestation ?? "unavailable";
  const [versions, parser] = await Promise.all([collectVersions(options.pluginRoot), collectParser(options.pluginRoot)]);
  if (options.workspace.status === "blocked") {
    return blockedReport(
      { status: "blocked", source: options.workspace.source, blockingReason: options.workspace.blockingReason },
      versions,
      parser,
      attestation,
      options.workspace.blockingReason
    );
  }
  const workspace = { status: "ready" as const, source: options.workspace.source };
  let leases: DoctorReport["leases"];
  let ledgers: DoctorReport["ledgers"];
  let storage: DoctorReport["storage"];
  let index: DoctorReport["index"];
  const now = options.now ?? new Date();
  try {
    [leases, ledgers, storage, index] = await Promise.all([
      collectLeases(options.workspace.root, now),
      collectLedgers(options.workspace.root, now),
      collectStorage(options.workspace.root),
      collectIndex(options.workspace.root)
    ]);
  } catch {
    return blockedReport(workspace, versions, parser, attestation, "state-boundary-violation");
  }
  const recommendations = [
    ...(versions.agreement === "mismatch" ? ["version-mismatch"] : []),
    ...(parser.grammars.some((grammar) => !grammar.present) ? ["parser-assets-missing"] : []),
    ...(leases.stale ? ["stale-lease"] : []),
    ...(leases.malformed ? ["malformed-lease"] : []),
    ...(ledgers.orphanCandidates ? ["orphan-ledger"] : []),
    ...(ledgers.malformed ? ["malformed-ledger"] : []),
    ...(storage.configState === "invalid" ? ["config-invalid"] : []),
    ...(storage.quotaPressure ? ["storage-quota-pressure"] : []),
    ...(index.presence === "corrupt" ? ["index-corrupt"] : []),
    ...(index.presence === "present" && index.state === "stale" ? ["index-inconsistent"] : []),
    ...(index.presence === "present" && index.state === "unknown" ? ["index-freshness-unknown"] : [])
  ];
  return {
    schemaVersion: 1,
    status: recommendations.length ? "degraded" : "healthy",
    workspace,
    stateAccess: "safe",
    versions,
    lifecycle: { attestation, nativeLockActivation: getLegacyRuntimeActivationStatus().activated ? "activated" : "unactivated" },
    parser,
    leases,
    ledgers,
    storage,
    index,
    recommendations
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  return [
    `TokenGraph doctor: ${report.status}`,
    `workspace: ${report.workspace.status} (${report.workspace.source})`,
    `state access: ${report.stateAccess}`,
    `versions: ${report.versions.agreement}`,
    `parser: ${report.parser.grammars.filter((grammar) => grammar.present).length}/${report.parser.grammars.length} grammar assets present`,
    `leases: ${report.leases.active} active, ${report.leases.stale} stale, ${report.leases.malformed} malformed`,
    `ledgers: ${report.ledgers.open} open, ${report.ledgers.paused} paused, ${report.ledgers.completed} completed, ${report.ledgers.orphanCandidates} orphan candidates`,
    `storage: ${report.storage.usage.total.bytes}/${report.storage.quotas.maxBytes} bytes (${report.storage.writePolicy})`,
    `index: ${report.index.state}`,
    `recommendations: ${report.recommendations.length ? report.recommendations.join(", ") : "none"}`
  ].join("\n");
}
