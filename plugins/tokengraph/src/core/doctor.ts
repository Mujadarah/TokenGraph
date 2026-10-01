import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { DEFAULT_TOKEN_GRAPH_CONFIG, inspectTokenGraphConfig } from "./config.js";
import { DiagnosticBoundaryError, DiagnosticReader } from "./diagnosticRead.js";
import { scanProjectSignature } from "./fileScanner.js";
import { DEFAULT_FILE_LOCK_POLICY, parseFileLockLease } from "./fileLockLease.js";
import { getLegacyRuntimeActivationStatus } from "./legacyRuntimeActivation.js";
import { LOCK_DOMAINS, NATIVE_LOCK_ANCHOR_NAME, NATIVE_LOCK_JOURNAL_NAME, NATIVE_LOCK_JOURNAL_TEMP_NAME, resolveLockDomainRootReadOnly, type LockDomain } from "./lockDomain.js";
import { PINNED_GRAMMARS, TREE_SITTER_RUNTIME } from "./polyglot.js";
import { generationValidationFailure, indexManifestPath, indexPath, isProjectIndex, parseManifest, stateDir } from "./persistence.js";
import { projectIndexFingerprint } from "./projectIndexer.js";
import { getRepositoryIdentityReadOnly } from "./repositoryIdentity.js";
import { normalizeWriteTelemetry, writeTelemetryPath } from "./storage.js";
import { storageClassUsageReadOnly, type StorageClassUsage } from "./storagePolicy.js";
import { decodeCurrentTaskLedger, MAX_READ_ONLY_LEDGER_BYTES, TASK_LEDGER_RETENTION_DAYS } from "./taskLedger.js";
import type { ProjectIndex, RepositoryIdentity, StorageWritePolicy, TokenGraphConfig } from "./types.js";
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
  leases: { active: number; stale: number; malformed: number; unavailableDomains: LockDomain[] };
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
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024;
const LOCK_INFRASTRUCTURE_NAMES = new Set([
  NATIVE_LOCK_ANCHOR_NAME, NATIVE_LOCK_JOURNAL_NAME, NATIVE_LOCK_JOURNAL_TEMP_NAME
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

function unavailableVersions(): DoctorReport["versions"] {
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

function unavailableParser(): DoctorReport["parser"] {
  return {
    runtime: TREE_SITTER_RUNTIME,
    grammars: Object.entries(PINNED_GRAMMARS).map(([language, grammar]) => ({
      language: language as keyof typeof PINNED_GRAMMARS,
      version: grammar.version,
      present: false
    }))
  };
}

function within(root: string, candidate: string): boolean {
  const nested = relative(resolve(root), resolve(candidate));
  return nested === "" || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith("../") && !nested.startsWith("..\\"));
}

async function readJson(reader: DiagnosticReader, path: string, maximumBytes: number): Promise<{ state: "missing" | "present" | "corrupt"; value?: JsonObject }> {
  try {
    const content = await reader.text(path, maximumBytes);
    if (content === undefined) return { state: "missing" };
    const parsed = JSON.parse(content) as unknown;
    return isObject(parsed) ? { state: "present", value: parsed } : { state: "corrupt" };
  } catch (error) {
    if (error instanceof SyntaxError) return { state: "corrupt" };
    throw error;
  }
}

async function readVersion(reader: DiagnosticReader, path: string): Promise<string | null> {
  const result = await readJson(reader, path, 1024 * 1024);
  return result.state === "present" && typeof result.value?.version === "string" ? result.value.version : null;
}

async function collectVersions(pluginRoot: string, authorizedWorkspace?: string): Promise<DoctorReport["versions"]> {
  const root = resolve(pluginRoot);
  const reader = new DiagnosticReader(root);
  const [packageVersion, codexManifest, claudeManifest] = await Promise.all([
    readVersion(reader, join(root, "package.json")),
    readVersion(reader, join(root, ".codex-plugin", "plugin.json")),
    readVersion(reader, join(root, ".claude-plugin", "plugin.json"))
  ]);
  const sourceLayout = (await reader.inspect(join(root, "src")))?.isDirectory() === true;
  let generatedRelease: DoctorReport["versions"]["generatedRelease"] = null;
  if (sourceLayout && authorizedWorkspace) {
    const releaseRoot = resolve(root, "..", "..", "release", "tokengraph");
    const nested = relative(resolve(authorizedWorkspace), releaseRoot);
    if (!isAbsolute(nested) && nested !== ".." && !nested.startsWith("..\\") && !nested.startsWith("../")) {
      const releaseReader = new DiagnosticReader(authorizedWorkspace);
      const [releasePackage, releaseCodex, releaseClaude] = await Promise.all([
        readVersion(releaseReader, join(releaseRoot, "package.json")),
        readVersion(releaseReader, join(releaseRoot, ".codex-plugin", "plugin.json")),
        readVersion(releaseReader, join(releaseRoot, ".claude-plugin", "plugin.json"))
      ]);
      generatedRelease = { package: releasePackage, codexManifest: releaseCodex, claudeManifest: releaseClaude };
    }
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
  const reader = new DiagnosticReader(pluginRoot);
  const assetRoot = join(resolve(pluginRoot), "assets", "grammars");
  const grammars = await Promise.all(Object.entries(PINNED_GRAMMARS).map(async ([language, grammar]) => {
    try {
      const content = await reader.bytes(join(assetRoot, grammar.asset), 32 * 1024 * 1024);
      if (content === undefined) return { language: language as keyof typeof PINNED_GRAMMARS, version: grammar.version, present: false };
      return {
        language: language as keyof typeof PINNED_GRAMMARS,
        version: grammar.version,
        present: content.length > 0,
        ...(content.length ? { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") } : {})
      };
    } catch (error) {
      if (error instanceof DiagnosticBoundaryError) throw error;
      return { language: language as keyof typeof PINNED_GRAMMARS, version: grammar.version, present: false };
    }
  }));
  return { runtime: TREE_SITTER_RUNTIME, grammars };
}

async function collectLeases(root: string, now: Date): Promise<DoctorReport["leases"]> {
  const result: DoctorReport["leases"] = { active: 0, stale: 0, malformed: 0, unavailableDomains: [] };
  const reader = new DiagnosticReader(root);
  for (const domain of LOCK_DOMAINS) {
    if (domain === "git-info") {
      const dotGit = await reader.inspect(join(root, ".git"));
      if (!dotGit) continue;
      // A linked-worktree marker may authorize Git, but it does not authorize
      // Doctor to inspect a common directory outside this trusted workspace.
      if (!dotGit.isDirectory()) { result.unavailableDomains.push(domain); continue; }
    }
    const directory = await resolveLockDomainRootReadOnly(root, domain);
    const entries = await reader.directory(directory) ?? [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (LOCK_INFRASTRUCTURE_NAMES.has(entry.name)) continue;
      if (entry.name.toLowerCase().endsWith(".lock")) {
        if (!entry.isDirectory()) {
          result.malformed += 1;
          continue;
        }
        const text = await reader.text(join(path, "lease.json"), 4 * 1024);
        const lease = text === undefined ? undefined : parseFileLockLease(text);
        if (!lease) result.malformed += 1;
        else if (now.getTime() - Date.parse(lease.heartbeatAt) > DEFAULT_FILE_LOCK_POLICY.staleMs) result.stale += 1;
        else result.active += 1;
      }
    }
  }
  return result;
}

async function collectLedgers(root: string, now: Date): Promise<DoctorReport["ledgers"]> {
  const result = { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 };
  const reader = new DiagnosticReader(root);
  const entries = await reader.directory(join(stateDir(root), "tasks")) ?? [];
  const cutoff = now.getTime() - TASK_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (entry.name === "completed-outcomes.json") continue;
    if (LOCK_INFRASTRUCTURE_NAMES.has(entry.name) || entry.name.toLowerCase().endsWith(".lock")) continue;
    const taskId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    if (entry.isSymbolicLink() || !entry.isFile() || !UUID_PATTERN.test(taskId)) {
      result.malformed += 1;
      continue;
    }
    const inspected = await readJson(reader, join(stateDir(root), "tasks", entry.name), MAX_READ_ONLY_LEDGER_BYTES);
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

interface DoctorConfig { config: TokenGraphConfig; state: DoctorReport["storage"]["configState"] }

async function collectConfig(root: string): Promise<DoctorConfig> {
  const read = await readJson(new DiagnosticReader(root), join(stateDir(root), "config.json"), 1024 * 1024);
  if (read.state === "missing") return { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "default" };
  if (read.state === "corrupt") return { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "invalid" };
  const decoded = inspectTokenGraphConfig(read.value);
  return { config: decoded.config, state: decoded.valid ? "valid" : "invalid" };
}

async function collectStorage(root: string, configured: DoctorConfig, failures: string[]): Promise<DoctorReport["storage"]> {
  const usage = await storageClassUsageReadOnly(root);
  let telemetry = { schemaVersion: 1 as const, days: [] } as ReturnType<typeof normalizeWriteTelemetry>;
  try {
    const text = await new DiagnosticReader(root).text(writeTelemetryPath(root), 256 * 1024);
    if (text !== undefined) telemetry = normalizeWriteTelemetry(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof DiagnosticBoundaryError) throw error;
    failures.push("write-telemetry-unavailable");
  }
  const storage = configured.config.storage;
  const quotas = {
    maxBytes: storage.maxBytes, runsMaxBytes: storage.runsMaxBytes, cacheMaxBytes: storage.cacheMaxBytes,
    vaultMaxBytes: storage.vaultMaxBytes, durableMaxBytes: storage.durableMaxBytes
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
      if (aggregate.physicalBytes !== undefined) {
        physicalBytes += aggregate.physicalBytes;
      } else physicalAvailable = false;
    }
  }
  if (![operations, logicalBytes, physicalBytes].every(Number.isSafeInteger)) throw new Error("TokenGraph diagnostic aggregate exceeds the safe integer range.");
  return {
    usage,
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
    quotaPressure: usage.total.bytes > quotas.maxBytes || usage.runs.bytes > quotas.runsMaxBytes ||
      usage.cache.bytes > quotas.cacheMaxBytes || usage.vault.bytes > quotas.vaultMaxBytes ||
      usage.durable.bytes > quotas.durableMaxBytes
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

async function indexedFilesMatchContent(reader: DiagnosticReader, root: string, index: ProjectIndex, requireMetadata: boolean): Promise<boolean> {
  const paths = index.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) return false;
  if (requireMetadata) {
    if (!index.scanMetadata?.files || !Array.isArray(index.scanMetadata.exclusions)) return false;
    if (JSON.stringify([...paths].sort()) !== JSON.stringify(Object.keys(index.scanMetadata.files).sort())) return false;
  }
  for (const file of index.files) {
    if (!isSafeRelativeFile(root, file.path) || !SHA256_PATTERN.test(file.contentHash)) return false;
    if (requireMetadata && index.scanMetadata?.files[file.path]?.contentHash !== file.contentHash) return false;
    const content = await reader.text(resolve(root, file.path), MAX_JSON_BYTES);
    if (content === undefined || createHash("sha256").update(content.replace(/\r\n?/g, "\n")).digest("hex") !== file.contentHash) return false;
  }
  return true;
}

function scannerBudget(config: TokenGraphConfig) {
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

function corruptIndex(schemaVersion: number | null, generation: string | null): DoctorReport["index"] {
  return { presence: "corrupt", state: "corrupt", schemaVersion, generation, rootValid: null, identityValid: null, metadataContentConsistent: null };
}

async function collectIndex(root: string, config: TokenGraphConfig, failures: string[]): Promise<DoctorReport["index"]> {
  const reader = new DiagnosticReader(root);
  const manifestText = await reader.text(indexManifestPath(root), MAX_MANIFEST_BYTES);
  let parsed: unknown;
  let generation: string | null = null;
  if (manifestText !== undefined) {
    let manifest;
    try { manifest = parseManifest(JSON.parse(manifestText) as unknown); }
    catch { return corruptIndex(null, null); }
    if (!manifest) return corruptIndex(null, null);
    generation = manifest.generationId;
    const generationContent = await reader.text(join(stateDir(root), manifest.generationFile), MAX_JSON_BYTES);
    if (generationContent === undefined || createHash("sha256").update(generationContent).digest("hex") !== manifest.contentHash) {
      return corruptIndex(null, generation);
    }
    try { parsed = JSON.parse(generationContent) as unknown; }
    catch { return corruptIndex(null, generation); }
  } else {
    const legacyText = await reader.text(indexPath(root), MAX_JSON_BYTES);
    if (legacyText === undefined) return { presence: "missing", state: "missing", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null };
    try { parsed = JSON.parse(legacyText) as unknown; }
    catch { return corruptIndex(null, null); }
  }

  const schemaVersion = isObject(parsed) && typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null;
  let index: ProjectIndex;
  try {
    if (!isProjectIndex(parsed)) return corruptIndex(schemaVersion, generation);
    index = parsed;
  } catch {
    failures.push("index-schema-unsupported");
    return corruptIndex(schemaVersion, generation);
  }
  if ((manifestText !== undefined && index.schemaVersion !== 5) || (manifestText === undefined && index.schemaVersion !== 4) ||
      (generation !== null && index.generation?.id !== generation)) {
    return corruptIndex(typeof index.schemaVersion === "number" ? index.schemaVersion : null, generation);
  }

  const rootValid = resolve(index.root) === resolve(root);
  const currentIdentity = await getRepositoryIdentityReadOnly(root);
  const identityValid = sameIdentity(index.repositoryIdentity, currentIdentity);
  let metadataContentConsistent = false;
  try {
    metadataContentConsistent = index.schemaVersion === 5
      ? generationValidationFailure(root, index, index.repositoryIdentity) === undefined && await indexedFilesMatchContent(reader, root, index, true)
      : await indexedFilesMatchContent(reader, root, index, false) && index.fingerprint === projectIndexFingerprint(index);
  } catch (error) {
    if (error instanceof DiagnosticBoundaryError) throw error;
    metadataContentConsistent = false;
  }
  let state: DoctorReport["index"]["state"] = !rootValid || identityValid === false || !metadataContentConsistent ? "stale" : "unknown";
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
    leases: { active: 0, stale: 0, malformed: 0, unavailableDomains: [] },
    ledgers: { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 },
    storage: defaultStorage(),
    index: { presence: "missing", state: "unknown", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null },
    recommendations: [recommendation]
  };
}

export async function collectDoctorReport(options: CollectDoctorReportOptions): Promise<DoctorReport> {
  const attestation = options.attestation ?? "unavailable";
  const failures: string[] = [];
  const authorizedWorkspace = options.workspace.status === "ready" && within(options.workspace.root, options.pluginRoot)
    ? options.workspace.root
    : undefined;
  let versions = unavailableVersions();
  let parser = unavailableParser();
  try { versions = await collectVersions(options.pluginRoot, authorizedWorkspace); }
  catch { failures.push("version-unavailable"); }
  try { parser = await collectParser(options.pluginRoot); }
  catch { failures.push("parser-assets-unavailable"); }
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
  const workspace = { status: "ready" as const, source: readyWorkspace.source };
  const emptyLeases: DoctorReport["leases"] = { active: 0, stale: 0, malformed: 0, unavailableDomains: [] };
  const emptyLedgers: DoctorReport["ledgers"] = { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 };
  const emptyIndex: DoctorReport["index"] = { presence: "missing", state: "unknown", schemaVersion: null, generation: null, rootValid: null, identityValid: null, metadataContentConsistent: null };
  let leases = emptyLeases;
  let ledgers = emptyLedgers;
  let storage = defaultStorage();
  let index = emptyIndex;
  const now = options.now ?? new Date();
  try {
    const boundary = new DiagnosticReader(readyWorkspace.root);
    await boundary.inspect(readyWorkspace.root);
    await boundary.inspect(stateDir(readyWorkspace.root));
  } catch (error) {
    if (!(error instanceof DiagnosticBoundaryError)) failures.push("workspace-state-unavailable");
    return blockedReport(workspace, versions, parser, attestation, "state-boundary-violation");
  }

  let configured: DoctorConfig = { config: DEFAULT_TOKEN_GRAPH_CONFIG, state: "default" };
  const collect = async <T>(operation: () => Promise<T>, fallback: T, code: string): Promise<T> => {
    try { return await operation(); }
    catch (error) {
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
    ...(versions.agreement === "unavailable" ? ["version-unavailable"] : []),
    ...(versions.agreement === "mismatch" ? ["version-mismatch"] : []),
    ...(parser.grammars.some((grammar) => !grammar.present) ? ["parser-assets-missing"] : []),
    ...(leases.unavailableDomains.length ? ["lease-domain-unavailable"] : []),
    ...(leases.stale ? ["stale-lease"] : []),
    ...(leases.malformed ? ["malformed-lease"] : []),
    ...(ledgers.orphanCandidates ? ["orphan-ledger"] : []),
    ...(ledgers.malformed ? ["malformed-ledger"] : []),
    ...(storage.configState === "invalid" ? ["config-invalid"] : []),
    ...(storage.quotaPressure ? ["storage-quota-pressure"] : []),
    ...(index.presence === "missing" ? ["index-missing"] : []),
    ...(index.presence === "corrupt" ? ["index-corrupt"] : []),
    ...(index.presence === "present" && index.state === "stale" ? ["index-inconsistent"] : []),
    ...(index.presence === "present" && index.state === "unknown" ? ["index-freshness-unknown"] : []),
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

export function formatDoctorReport(report: DoctorReport): string {
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
