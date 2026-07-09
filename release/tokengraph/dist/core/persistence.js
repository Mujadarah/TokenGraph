import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { quarantineCorruptJson, writeJsonAtomic, writeTextAtomic } from "./storage.js";
export function stateDir(root) {
    return join(root, ".tokengraph");
}
export function indexPath(root) {
    return join(stateDir(root), "index.json");
}
export function memoryPath(root) {
    return join(stateDir(root), "memory.json");
}
export function configPath(root) {
    return join(stateDir(root), "config.json");
}
export function rulesPath(root) {
    return join(stateDir(root), "rules.json");
}
export function tokenEventsPath(root) {
    return join(stateDir(root), "token-events.json");
}
export function benchmarkRunsPath(root) {
    return join(stateDir(root), "benchmark-runs.json");
}
export function wikiDir(root) {
    return join(stateDir(root), "wiki");
}
export function wikiManifestPath(root) {
    return join(wikiDir(root), "manifest.json");
}
export async function saveProjectIndex(root, index) {
    await writeJsonAtomic(indexPath(root), index);
}
function isProjectIndex(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return (typeof candidate.root === "string" &&
        typeof candidate.scannedAt === "string" &&
        typeof candidate.fingerprint === "string" &&
        Array.isArray(candidate.files) &&
        Array.isArray(candidate.symbols) &&
        Array.isArray(candidate.imports) &&
        Array.isArray(candidate.exclusions) &&
        Array.isArray(candidate.frameworks) &&
        Boolean(candidate.sql) &&
        Array.isArray(candidate.sql?.tables) &&
        Array.isArray(candidate.sql?.relations) &&
        Array.isArray(candidate.sql?.policies) &&
        Array.isArray(candidate.sql?.indexes) &&
        Array.isArray(candidate.sql?.triggers) &&
        Array.isArray(candidate.sql?.functions) &&
        Array.isArray(candidate.sql?.views) &&
        Array.isArray(candidate.sql?.constraints) &&
        Array.isArray(candidate.sql?.enums) &&
        Array.isArray(candidate.sql?.extensions) &&
        Array.isArray(candidate.sql?.grants) &&
        Array.isArray(candidate.sql?.materializedViews) &&
        Array.isArray(candidate.sql?.history));
}
export async function loadProjectIndex(root) {
    try {
        const parsed = JSON.parse(await readFile(indexPath(root), "utf8"));
        return isProjectIndex(parsed) ? parsed : undefined;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        if (error instanceof SyntaxError) {
            await quarantineCorruptJson(indexPath(root));
            return undefined;
        }
        throw error;
    }
}
function isWikiManifest(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return (candidate.schemaVersion === 1 &&
        typeof candidate.fingerprint === "string" &&
        typeof candidate.generatedAt === "string" &&
        Array.isArray(candidate.pages) &&
        candidate.pages.every((page) => page &&
            typeof page === "object" &&
            typeof page.slug === "string" &&
            typeof page.title === "string" &&
            typeof page.estimatedTokens === "number" &&
            typeof page.file === "string"));
}
function isSafeWikiPageFile(root, file) {
    if (!file || isAbsolute(file) || file.startsWith("../") || file.startsWith("..\\")) {
        return false;
    }
    const directory = resolve(wikiDir(root));
    const resolved = resolve(directory, file);
    const relativePath = relative(directory, resolved);
    return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
export async function saveProjectWiki(root, wiki) {
    await mkdir(wikiDir(root), { recursive: true });
    const pages = wiki.pages.map((page) => ({
        slug: page.slug,
        title: page.title,
        estimatedTokens: page.estimatedTokens,
        file: `${page.slug}.md`
    }));
    for (const wikiPage of wiki.pages) {
        await writeTextAtomic(join(wikiDir(root), `${wikiPage.slug}.md`), wikiPage.body);
    }
    const manifest = {
        schemaVersion: wiki.schemaVersion,
        fingerprint: wiki.fingerprint,
        generatedAt: new Date().toISOString(),
        pages
    };
    await writeJsonAtomic(wikiManifestPath(root), manifest);
}
export async function loadProjectWiki(root) {
    try {
        const manifest = JSON.parse(await readFile(wikiManifestPath(root), "utf8"));
        if (!isWikiManifest(manifest) || !manifest.pages.every((page) => isSafeWikiPageFile(root, page.file))) {
            return undefined;
        }
        const pages = [];
        for (const manifestPage of manifest.pages) {
            pages.push({
                slug: manifestPage.slug,
                title: manifestPage.title,
                estimatedTokens: manifestPage.estimatedTokens,
                body: await readFile(join(wikiDir(root), manifestPage.file), "utf8")
            });
        }
        return {
            schemaVersion: manifest.schemaVersion,
            fingerprint: manifest.fingerprint,
            pages
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        if (error instanceof SyntaxError) {
            await quarantineCorruptJson(wikiManifestPath(root));
            return undefined;
        }
        throw error;
    }
}
export async function clearProjectWiki(root) {
    await rm(wikiDir(root), { recursive: true, force: true });
}
export async function getWikiStatus(root) {
    const wiki = await loadProjectWiki(root);
    if (!wiki) {
        return { root, state: "missing", hasWiki: false };
    }
    const index = await loadProjectIndex(root);
    const indexFingerprint = index?.fingerprint;
    return {
        root,
        state: indexFingerprint && indexFingerprint === wiki.fingerprint ? "fresh" : "stale",
        hasWiki: true,
        wikiFingerprint: wiki.fingerprint,
        indexFingerprint
    };
}
export async function clearProjectIndex(root) {
    await rm(indexPath(root), { force: true });
    await clearProjectWiki(root);
}
export async function clearProjectState(root) {
    await rm(stateDir(root), { recursive: true, force: true });
}
