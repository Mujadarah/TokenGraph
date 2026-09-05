import { readFile } from "node:fs/promises";

import { configPath, stateDir } from "./persistence.js";
import { canonicalPersistenceLock } from "./lockDomain.js";
import { getLegacyRuntimeActivationStatus } from "./legacyRuntimeActivation.js";
import { quarantineCorruptJson, withFileLock, writeJsonAtomic, writeTextAtomic } from "./storage.js";
import type { RoutingMode, StorageWritePolicy, TokenGraphConfig, TokenGraphConfigUpdate, TokenSavingProfile } from "./types.js";

export const CURRENT_CONFIG_SCHEMA_VERSION = 4;

export const PROFILE_DEFAULTS = {
  conservative: {
    maxFiles: 10,
    maxSqlObjects: 10,
    maxMemories: 6,
    firstReads: 5,
    maxPlannedContextTokens: 12000,
    rawReadWarningThreshold: 12000
  },
  balanced: {
    maxFiles: 6,
    maxSqlObjects: 6,
    maxMemories: 4,
    firstReads: 3,
    maxPlannedContextTokens: 8000,
    rawReadWarningThreshold: 8000
  },
  aggressive: {
    maxFiles: 3,
    maxSqlObjects: 3,
    maxMemories: 2,
    firstReads: 2,
    maxPlannedContextTokens: 4000,
    rawReadWarningThreshold: 4000
  }
} satisfies Record<TokenSavingProfile, {
  maxFiles: number;
  maxSqlObjects: number;
  maxMemories: number;
  firstReads: number;
  maxPlannedContextTokens: number;
  rawReadWarningThreshold: number;
}>;

export const DEFAULT_TOKEN_GRAPH_CONFIG: TokenGraphConfig = {
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
    maxSymbols: 10_000,
    maxNodes: 250_000,
    perFileTimeoutMs: 2_000,
    wholeIndexTimeoutMs: 60_000,
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
  runner: { maxBytes: 64 * 1024, timeoutMs: 120_000, terminateGraceMs: 2_000 },
  memory: { projectBriefTargetTokens: 220, projectBriefMaxTokens: 600, maxRetrievalTokens: 1_200 },
  responseFormat: { default: "json" }
};

function isProfile(value: unknown): value is TokenSavingProfile {
  return value === "conservative" || value === "balanced" || value === "aggressive";
}

function isRoutingMode(value: unknown): value is RoutingMode {
  return value === "shadow" || value === "enforced" || value === "always-activate" || value === "always-advisory";
}

function isStorageWritePolicy(value: unknown): value is StorageWritePolicy {
  return value === "minimal" || value === "balanced" || value === "durable";
}

function sanitizeNumber(value: unknown, fallback: number, min = 0): number {
  return Number.isInteger(value) && (value as number) >= min ? (value as number) : fallback;
}

function legacyStorageClassCaps(maxBytes: number): Pick<TokenGraphConfig["storage"], "runsMaxBytes" | "cacheMaxBytes" | "vaultMaxBytes" | "durableMaxBytes"> {
  const runsMaxBytes = Math.floor(maxBytes * 0.25);
  const cacheMaxBytes = Math.floor(maxBytes * 0.5);
  const vaultMaxBytes = Math.floor(maxBytes * 0.125);
  return { runsMaxBytes, cacheMaxBytes, vaultMaxBytes, durableMaxBytes: maxBytes - runsMaxBytes - cacheMaxBytes - vaultMaxBytes };
}

function normalizeConfig(value: unknown, applyEnvironment = true): TokenGraphConfig {
  const candidate = value && typeof value === "object" ? (value as Partial<TokenGraphConfig>) : {};
  const nestedRouting = candidate.routing && typeof candidate.routing === "object" ? candidate.routing : {};
  const nestedParser = candidate.parser && typeof candidate.parser === "object" ? candidate.parser : {};
  const nestedStorage = candidate.storage && typeof candidate.storage === "object" ? candidate.storage : {};
  const nestedRunner = candidate.runner && typeof candidate.runner === "object" ? candidate.runner : {};
  const nestedMemory = candidate.memory && typeof candidate.memory === "object" ? candidate.memory : {};
  const nestedResponse = candidate.responseFormat && typeof candidate.responseFormat === "object" ? candidate.responseFormat : {};
  const storageMaxBytes = sanitizeNumber((nestedStorage as { maxBytes?: unknown }).maxBytes, DEFAULT_TOKEN_GRAPH_CONFIG.storage.maxBytes, 1);
  const legacyStorageCaps = legacyStorageClassCaps(storageMaxBytes);
  const routingMode = applyEnvironment && isRoutingMode(process.env.TOKENGRAPH_ROUTING_MODE)
    ? process.env.TOKENGRAPH_ROUTING_MODE
    : isRoutingMode(candidate.routingMode) ? candidate.routingMode : isRoutingMode((nestedRouting as { mode?: unknown }).mode) ? (nestedRouting as { mode: RoutingMode }).mode : DEFAULT_TOKEN_GRAPH_CONFIG.routingMode;
  const routingKillSwitch = typeof candidate.routingKillSwitch === "boolean" ? candidate.routingKillSwitch : typeof (nestedRouting as { killSwitch?: unknown }).killSwitch === "boolean" ? Boolean((nestedRouting as { killSwitch?: unknown }).killSwitch) : DEFAULT_TOKEN_GRAPH_CONFIG.routingKillSwitch;
  const integer = (object: object, key: string, fallback: number, min = 0) => sanitizeNumber((object as Record<string, unknown>)[key], fallback, min);
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
      polyglotEnabled: typeof (nestedParser as { polyglotEnabled?: unknown }).polyglotEnabled === "boolean"
        ? Boolean((nestedParser as { polyglotEnabled?: unknown }).polyglotEnabled)
        : DEFAULT_TOKEN_GRAPH_CONFIG.parser.polyglotEnabled,
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
      writePolicy: isStorageWritePolicy((nestedStorage as { writePolicy?: unknown }).writePolicy)
        ? (nestedStorage as { writePolicy: StorageWritePolicy }).writePolicy
        : DEFAULT_TOKEN_GRAPH_CONFIG.storage.writePolicy,
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
    responseFormat: { default: (nestedResponse as { default?: unknown }).default === "compact-tabular" ? "compact-tabular" : "json" }
  };
}

function unwrapPersistedConfig(value: unknown): { config: unknown; needsMigration: boolean } {
  if (value && typeof value === "object" && "schemaVersion" in value && "config" in value) {
    const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
    if (typeof schemaVersion === "number" && schemaVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
      throw new Error(`Unsupported newer TokenGraph config schema version ${schemaVersion}; refusing to overwrite it.`);
    }
    return {
      config: (value as { config?: unknown }).config,
      needsMigration: schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION
    };
  }
  return { config: value, needsMigration: true };
}

export async function saveTokenGraphConfig(root: string, config: TokenGraphConfig): Promise<TokenGraphConfig> {
  const persisted = normalizeConfig(config, false);
  const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");
  await withFileLock(lock, () => writeJsonAtomic(configPath(root), {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    config: persisted
  }, { telemetry: { root, storageClass: "durable" } }));
  return normalizeConfig(persisted);
}

type ConfigSnapshot =
  | { state: "missing" | "corrupt"; config: TokenGraphConfig }
  | { state: "valid"; config: TokenGraphConfig; persisted: TokenGraphConfig; rawBytes: string; needsRepair: boolean };

async function readConfigSnapshot(root: string): Promise<ConfigSnapshot> {
  let rawBytes: string;
  try {
    rawBytes = await readFile(configPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", config: normalizeConfig(DEFAULT_TOKEN_GRAPH_CONFIG) };
    }
    throw error;
  }
  try {
    const unwrapped = unwrapPersistedConfig(JSON.parse(rawBytes) as unknown);
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

async function persistConfigLocked(root: string, persisted: TokenGraphConfig): Promise<void> {
  await writeJsonAtomic(configPath(root), {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    config: persisted
  }, { telemetry: { root, storageClass: "durable" } });
}

async function repairConfigSnapshotLocked(root: string, snapshot: ConfigSnapshot): Promise<TokenGraphConfig> {
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

export async function loadTokenGraphConfig(root: string): Promise<TokenGraphConfig> {
  const initial = await readConfigSnapshot(root);
  if (!getLegacyRuntimeActivationStatus().activated) return initial.config;
  if (initial.state === "valid" && !initial.needsRepair) return initial.config;
  const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");
  return withFileLock(lock, async () => repairConfigSnapshotLocked(root, await readConfigSnapshot(root)));
}

export async function setTokenSavingProfile(root: string, profile: TokenSavingProfile): Promise<TokenGraphConfig> {
  return updateTokenGraphConfig(root, { tokenSavingProfile: profile });
}

export async function updateTokenGraphConfig(root: string, update: TokenGraphConfigUpdate): Promise<TokenGraphConfig> {
  const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");
  return withFileLock(lock, async () => {
    const snapshot = await readConfigSnapshot(root);
    const config = snapshot.config;
    if (snapshot.state === "corrupt") await quarantineCorruptJson(configPath(root));
    else if (snapshot.state === "valid" && snapshot.needsRepair) {
      await writeTextAtomic(`${configPath(root)}.bak`, snapshot.rawBytes, { telemetry: { root, storageClass: "durable" } });
    }
    const merged = normalizeConfig({
      ...config,
      ...update,
      routing: { ...config.routing, ...(update.routing ?? {}) },
      parser: { ...config.parser, ...(update.parser ?? {}) },
      storage: { ...config.storage, ...(update.storage ?? {}) },
      runner: { ...config.runner, ...(update.runner ?? {}) },
      memory: { ...config.memory, ...(update.memory ?? {}) },
      responseFormat: { ...config.responseFormat, ...(update.responseFormat ?? {}) },
      ...(update.routing?.mode === undefined ? {} : { routingMode: update.routing.mode }),
      ...(update.routing?.killSwitch === undefined ? {} : { routingKillSwitch: update.routing.killSwitch })
    }, false);
    await persistConfigLocked(root, merged);
    return normalizeConfig(merged);
  });
}
