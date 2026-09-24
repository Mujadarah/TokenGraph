import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

export class DiagnosticBoundaryError extends Error {
  readonly code = "DIAGNOSTIC_BOUNDARY_VIOLATION";
  constructor() {
    super("TokenGraph diagnostic path is linked, outside its authorized root, or changed identity.");
  }
}

interface Snapshot { path: string; stats: BigIntStats }

function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function confined(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith("../") && !nested.startsWith("..\\"));
}

/** Bounded diagnostics never create state or acquire a persistence lock. */
export class DiagnosticReader {
  readonly root: string;
  private remainingEntries = 20_000;
  private remainingBytes = 512 * 1024 * 1024;

  constructor(root: string) { this.root = resolve(root); }

  private async capture(path: string): Promise<Snapshot[] | undefined> {
    const absolute = resolve(path);
    if (!confined(this.root, absolute)) throw new DiagnosticBoundaryError();
    const volume = parse(absolute).root;
    let current = volume;
    const snapshots: Snapshot[] = [];
    for (const segment of absolute.slice(volume.length).split(/[\\/]+/).filter(Boolean)) {
      current = join(current, segment);
      let stats: BigIntStats;
      try { stats = await lstat(current, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await this.validate(snapshots);
          return undefined;
        }
        throw error;
      }
      if (stats.isSymbolicLink() || (current !== absolute && !stats.isDirectory())) throw new DiagnosticBoundaryError();
      // Capture identities from the authorized root downwards. Ancestors are
      // checked for links but their unrelated directory activity is not ours.
      if (confined(this.root, current)) snapshots.push({ path: current, stats });
    }
    if (await realpath(absolute) !== absolute) throw new DiagnosticBoundaryError();
    return snapshots;
  }

  private async validate(snapshots: readonly Snapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      const current = await lstat(snapshot.path, { bigint: true }).catch(() => { throw new DiagnosticBoundaryError(); });
      if (current.isSymbolicLink() || !same(snapshot.stats, current)) throw new DiagnosticBoundaryError();
    }
  }

  async inspect(path: string): Promise<BigIntStats | undefined> {
    const snapshots = await this.capture(path);
    if (!snapshots) return undefined;
    await this.validate(snapshots);
    return snapshots.at(-1)?.stats;
  }

  async directory(path: string): Promise<Dirent[] | undefined> {
    path = resolve(path);
    const snapshots = await this.capture(path);
    if (!snapshots) return undefined;
    if (!snapshots.at(-1)?.stats.isDirectory()) throw new DiagnosticBoundaryError();
    const directory = await opendir(path, { bufferSize: 1 });
    try {
      await this.validate(snapshots);
      const entries: Dirent[] = [];
      for (;;) {
        await this.validate(snapshots);
        const entry = await directory.read();
        await this.validate(snapshots);
        if (!entry) return entries.sort((a, b) => a.name.localeCompare(b.name));
        if (--this.remainingEntries < 0) throw new Error("TokenGraph diagnostic entry budget exceeded.");
        if (entry.isSymbolicLink()) throw new DiagnosticBoundaryError();
        entries.push(entry);
      }
    } finally { await directory.close(); }
  }

  async bytes(path: string, maximumBytes: number): Promise<Buffer | undefined> {
    path = resolve(path);
    const snapshots = await this.capture(path);
    if (!snapshots) return undefined;
    const before = snapshots.at(-1)!.stats;
    if (!before.isFile() || before.nlink !== 1n) throw new DiagnosticBoundaryError();
    if (before.size < 0n || before.size > BigInt(maximumBytes) || before.size > BigInt(this.remainingBytes)) {
      throw new Error("TokenGraph diagnostic byte budget exceeded.");
    }
    this.remainingBytes -= Number(before.size);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!same(before, opened)) throw new DiagnosticBoundaryError();
      await this.validate(snapshots);
      // Read no more than the validated size plus one byte. Growth cannot turn
      // an apparently bounded input into an unbounded allocation or read.
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (BigInt(count) !== before.size || !same(before, await handle.stat({ bigint: true }))) throw new DiagnosticBoundaryError();
      await this.validate(snapshots);
      return bytes.subarray(0, count);
    } finally { await handle.close(); }
  }

  async text(path: string, maximumBytes: number): Promise<string | undefined> {
    return (await this.bytes(path, maximumBytes))?.toString("utf8");
  }
}
