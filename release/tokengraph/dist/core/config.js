import { readFile } from "node:fs/promises";
import { configPath } from "./persistence.js";
import { quarantineCorruptJson, writeJsonAtomic } from "./storage.js";
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
};
export const DEFAULT_TOKEN_GRAPH_CONFIG = {
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
function isProfile(value) {
    return value === "conservative" || value === "balanced" || value === "aggressive";
}
function sanitizeNumber(value, fallback, min = 0) {
    return Number.isInteger(value) && value >= min ? value : fallback;
}
function normalizeConfig(value) {
    const candidate = value && typeof value === "object" ? value : {};
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
function unwrapPersistedConfig(value) {
    if (value && typeof value === "object" && "schemaVersion" in value && "config" in value) {
        return {
            config: value.config,
            needsMigration: value.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION
        };
    }
    return { config: value, needsMigration: true };
}
export async function saveTokenGraphConfig(root, config) {
    const normalized = normalizeConfig(config);
    await writeJsonAtomic(configPath(root), {
        schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
        config: normalized
    });
    return normalized;
}
export async function loadTokenGraphConfig(root) {
    try {
        const parsed = JSON.parse(await readFile(configPath(root), "utf8"));
        const unwrapped = unwrapPersistedConfig(parsed);
        const normalized = normalizeConfig(unwrapped.config);
        if (unwrapped.needsMigration || JSON.stringify(unwrapped.config) !== JSON.stringify(normalized)) {
            await saveTokenGraphConfig(root, normalized);
        }
        return normalized;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
        }
        if (error instanceof SyntaxError) {
            await quarantineCorruptJson(configPath(root));
            return saveTokenGraphConfig(root, DEFAULT_TOKEN_GRAPH_CONFIG);
        }
        throw error;
    }
}
export async function setTokenSavingProfile(root, profile) {
    const config = await loadTokenGraphConfig(root);
    return saveTokenGraphConfig(root, { ...config, tokenSavingProfile: profile });
}
export async function updateTokenGraphConfig(root, update) {
    const config = await loadTokenGraphConfig(root);
    return saveTokenGraphConfig(root, { ...config, ...update });
}
