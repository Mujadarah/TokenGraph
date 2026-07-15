import { copyFile, readFile } from "node:fs/promises";

import { configPath, stateDir } from "./persistence.js";
import { canonicalPersistenceLockKey, quarantineCorruptJson, withFileLock, writeJsonAtomic } from "./storage.js";
import type { RoutingMode, TokenGraphConfig, TokenGraphConfigUpdate, TokenSavingProfile } from "./types.js";

export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

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
    maxAliases: 500,
    typescriptSource: "bundled"
  },
  storage: { maxBytes: 64 * 1024 * 1024, runRetentionDays: 14, cacheRetentionDays: 7 },
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

function sanitizeNumber(value: unknown, fallback: number, min = 0): number {
  return Number.isInteger(value) && (value as number) >= min ? (value as number) : fallback;
}

function normalizeConfig(value: unknown, applyEnvironment = true): TokenGraphConfig {
  const candidate = value && typeof value === "object" ? (value as Partial<TokenGraphConfig>) : {};
  const nestedRouting = candidate.routing && typeof candidate.routing === "object" ? candidate.routing : {};
  const nestedParser = candidate.parser && typeof candidate.parser === "object" ? candidate.parser : {};
  const nestedStorage = candidate.storage && typeof candidate.storage === "object" ? candidate.storage : {};
  const nestedRunner = candidate.runner && typeof candidate.runner === "object" ? candidate.runner : {};
  const nestedMemory = candidate.memory && typeof candidate.memory === "object" ? candidate.memory : {};
  const nestedResponse = candidate.responseFormat && typeof candidate.responseFormat === "object" ? candidate.responseFormat : {};
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
      maxAliases: integer(nestedParser, "maxAliases", DEFAULT_TOKEN_GRAPH_CONFIG.parser.maxAliases, 0),
      typescriptSource: (nestedParser as { typescriptSource?: unknown }).typescriptSource === "project-opt-in" ? "project-opt-in" : "bundled"
    },
    storage: {
      maxBytes: integer(nestedStorage, "maxBytes", DEFAULT_TOKEN_GRAPH_CONFIG.storage.maxBytes, 1),
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
  const key = await canonicalPersistenceLockKey(root, ".tokengraph", "config.json");
  await withFileLock(`${key}.lock`, () => writeJsonAtomic(configPath(root), {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    config: persisted
  }));
  return normalizeConfig(persisted);
}

export async function loadTokenGraphConfig(root: string): Promise<TokenGraphConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(root), "utf8")) as unknown;
    const unwrapped = unwrapPersistedConfig(parsed);
    const persistedNormalized = normalizeConfig(unwrapped.config, false);
    const normalized = normalizeConfig(persistedNormalized);
    if (unwrapped.needsMigration || JSON.stringify(unwrapped.config) !== JSON.stringify(persistedNormalized)) {
      await copyFile(configPath(root), `${configPath(root)}.bak`).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await saveTokenGraphConfig(root, persistedNormalized);
    }
    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
    }
    if (error instanceof SyntaxError) {
      await quarantineCorruptJson(configPath(root));
      return saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
    }
    throw error;
  }
}

export async function setTokenSavingProfile(root: string, profile: TokenSavingProfile): Promise<TokenGraphConfig> {
  const config = await loadTokenGraphConfig(root);
  return saveTokenGraphConfig(root, { ...config, tokenSavingProfile: profile });
}

export async function updateTokenGraphConfig(root: string, update: TokenGraphConfigUpdate): Promise<TokenGraphConfig> {
  const config = await loadTokenGraphConfig(root);
  const merged = {
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
  };
  return saveTokenGraphConfig(root, merged);
}
