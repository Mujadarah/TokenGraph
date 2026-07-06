import { mkdir, readFile, writeFile } from "node:fs/promises";

import { configPath, stateDir } from "./persistence.js";
import type { TokenGraphConfig, TokenGraphConfigUpdate, TokenSavingProfile } from "./types.js";

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
  maxFiles: PROFILE_DEFAULTS.balanced.maxFiles,
  maxSqlObjects: PROFILE_DEFAULTS.balanced.maxSqlObjects,
  maxMemories: PROFILE_DEFAULTS.balanced.maxMemories,
  maxPlannedContextTokens: PROFILE_DEFAULTS.balanced.maxPlannedContextTokens,
  rawReadWarningThreshold: PROFILE_DEFAULTS.balanced.rawReadWarningThreshold,
  sqlIndexingEnabled: true,
  memoryEnabled: true,
  wikiGenerationEnabled: false
};

function isProfile(value: unknown): value is TokenSavingProfile {
  return value === "conservative" || value === "balanced" || value === "aggressive";
}

function sanitizeNumber(value: unknown, fallback: number, min = 0): number {
  return Number.isInteger(value) && (value as number) >= min ? (value as number) : fallback;
}

function normalizeConfig(value: unknown): TokenGraphConfig {
  const candidate = value && typeof value === "object" ? (value as Partial<TokenGraphConfig>) : {};
  return {
    tokenSavingProfile: isProfile(candidate.tokenSavingProfile) ? candidate.tokenSavingProfile : DEFAULT_TOKEN_GRAPH_CONFIG.tokenSavingProfile,
    maxFiles: sanitizeNumber(candidate.maxFiles, DEFAULT_TOKEN_GRAPH_CONFIG.maxFiles, 1),
    maxSqlObjects: sanitizeNumber(candidate.maxSqlObjects, DEFAULT_TOKEN_GRAPH_CONFIG.maxSqlObjects),
    maxMemories: sanitizeNumber(candidate.maxMemories, DEFAULT_TOKEN_GRAPH_CONFIG.maxMemories),
    maxPlannedContextTokens: sanitizeNumber(candidate.maxPlannedContextTokens, DEFAULT_TOKEN_GRAPH_CONFIG.maxPlannedContextTokens, 1),
    rawReadWarningThreshold: sanitizeNumber(candidate.rawReadWarningThreshold, DEFAULT_TOKEN_GRAPH_CONFIG.rawReadWarningThreshold, 1),
    sqlIndexingEnabled: typeof candidate.sqlIndexingEnabled === "boolean" ? candidate.sqlIndexingEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.sqlIndexingEnabled,
    memoryEnabled: typeof candidate.memoryEnabled === "boolean" ? candidate.memoryEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.memoryEnabled,
    wikiGenerationEnabled: typeof candidate.wikiGenerationEnabled === "boolean" ? candidate.wikiGenerationEnabled : DEFAULT_TOKEN_GRAPH_CONFIG.wikiGenerationEnabled
  };
}

export async function saveTokenGraphConfig(root: string, config: TokenGraphConfig): Promise<TokenGraphConfig> {
  const normalized = normalizeConfig(config);
  await mkdir(stateDir(root), { recursive: true });
  await writeFile(configPath(root), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export async function loadTokenGraphConfig(root: string): Promise<TokenGraphConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(root), "utf8")) as unknown;
    const normalized = normalizeConfig(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      await saveTokenGraphConfig(root, normalized);
    }
    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
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
  return saveTokenGraphConfig(root, { ...config, ...update });
}
