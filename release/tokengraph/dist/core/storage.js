import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export async function writeJsonAtomic(path, value) {
    await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
export async function writeTextAtomic(path, content) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
    try {
        await writeFile(tempPath, content);
        await rename(tempPath, path);
    }
    finally {
        await rm(tempPath, { force: true });
    }
}
export async function quarantineCorruptJson(path) {
    const corruptPath = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    try {
        await rename(path, corruptPath);
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}
export class JsonTokenGraphStore {
    filePath;
    options;
    constructor(filePath, options) {
        this.filePath = filePath;
        this.options = options;
    }
    async read() {
        try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
            if (Array.isArray(parsed)) {
                return parsed;
            }
            if (parsed && typeof parsed === "object") {
                const value = parsed[this.options.dataKey];
                return Array.isArray(value) ? value : [];
            }
            return [];
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            if (error instanceof SyntaxError) {
                await quarantineCorruptJson(this.filePath);
                return [];
            }
            throw error;
        }
    }
    async write(data) {
        await writeJsonAtomic(resolve(this.filePath), {
            schemaVersion: this.options.schemaVersion,
            [this.options.dataKey]: data
        });
    }
}
export class SqliteTokenGraphStore {
    constructor(_databasePath) {
        throw new Error("The optional SQLite backend is not implemented; JSON storage remains the default.");
    }
}
