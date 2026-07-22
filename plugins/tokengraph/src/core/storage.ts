import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

export interface JsonTokenGraphStoreOptions {
  schemaVersion: number;
  dataKey: string;
}

const FILE_LOCK_ATTEMPTS = 200;
const FILE_LOCK_WAIT_MS = 10;
const FILE_LOCK_STALE_MS = 30_000;

export const SAFE_WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isTransientWindowsFsError(error: unknown): boolean {
  return process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String((error as NodeJS.ErrnoException).code));
}

async function retryTransientWindowsFs<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsFsError(error) || attempt >= 19) throw error;
      await wait(FILE_LOCK_WAIT_MS);
    }
  }
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await assertNoSymbolicLinkComponents(lockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  await assertNoSymbolicLinkComponents(lockPath);
  for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !isTransientWindowsFsError(error)) throw error;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > FILE_LOCK_STALE_MS) {
          await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT" && !isTransientWindowsFsError(lockError)) throw lockError;
      }
      await wait(FILE_LOCK_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for a persistence file lock.");
}

export async function canonicalPersistenceLockKey(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalRoot = resolvedRoot;
  }
  const key = join(canonicalRoot, ...segments);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await assertNoSymbolicLinkComponents(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinkComponents(path);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const tempPath = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  for (const segment of remainder) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`State write cannot traverse symbolic-link or junction component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function resolveConfinedPath(root: string, relativeFile: string, createParents = false): Promise<string> {
  if (!relativeFile || isAbsolute(relativeFile) || relativeFile.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("Confined path must be a safe relative file path.");
  }
  const canonicalRoot = await realpath(resolve(root));
  const segments = relativeFile.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) throw new Error("Confined path must name a file.");
  let parent = canonicalRoot;
  for (const segment of segments) {
    const candidate = join(parent, segment);
    if (createParents) await mkdir(candidate, { recursive: false }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    parent = await realpath(candidate);
    const confined = relative(canonicalRoot, parent);
    if (!confined || confined.startsWith("..") || isAbsolute(confined)) {
      throw new Error("Path resolves outside the trusted workspace.");
    }
  }
  const filePath = join(parent, fileName);
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error("Confined file path cannot be a symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return filePath;
}

export async function writeTextAtomicConfined(root: string, relativeFile: string, content: string): Promise<void> {
  await writeTextAtomic(await resolveConfinedPath(root, relativeFile, true), content);
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
        const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
        if (typeof schemaVersion === "number" && schemaVersion !== this.options.schemaVersion) {
          throw new Error(`Unsupported TokenGraph store schema version ${schemaVersion}; expected ${this.options.schemaVersion}.`);
        }
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
