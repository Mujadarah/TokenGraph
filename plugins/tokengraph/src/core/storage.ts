import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface JsonTokenGraphStoreOptions {
  schemaVersion: number;
  dataKey: string;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function quarantineCorruptJson(path: string): Promise<void> {
  const corruptPath = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(path, corruptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export class JsonTokenGraphStore<T = unknown> {
  constructor(
    private readonly filePath: string,
    private readonly options: JsonTokenGraphStoreOptions
  ) {}

  async read(): Promise<T[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as T[];
      }
      if (parsed && typeof parsed === "object") {
        const value = (parsed as Record<string, unknown>)[this.options.dataKey];
        return Array.isArray(value) ? (value as T[]) : [];
      }
      return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      if (error instanceof SyntaxError) {
        await quarantineCorruptJson(this.filePath);
        return [];
      }
      throw error;
    }
  }

  async write(data: T[]): Promise<void> {
    await writeJsonAtomic(resolve(this.filePath), {
      schemaVersion: this.options.schemaVersion,
      [this.options.dataKey]: data
    });
  }
}

export class SqliteTokenGraphStore {
  constructor(_databasePath: string) {
    throw new Error("The optional SQLite backend is not implemented; JSON storage remains the default.");
  }
}
