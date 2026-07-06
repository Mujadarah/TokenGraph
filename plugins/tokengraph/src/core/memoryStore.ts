import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { tokenize } from "./token.js";
import type { MemoryEntry, MemoryInput } from "./types.js";

function scoreMemory(memory: MemoryEntry, terms: string[]): number {
  const haystack = tokenize(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")}`);
  return terms.reduce((score, term) => score + (haystack.some((part) => part.includes(term) || term.includes(part)) ? 1 : 0), 0);
}

export class MemoryStore {
  private static readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly filePath: string) {}

  async list(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MemoryEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      if (error instanceof SyntaxError) {
        await this.quarantineCorruptFile();
        return [];
      }
      throw error;
    }
  }

  async add(input: MemoryInput): Promise<MemoryEntry> {
    return this.enqueueWrite(async () => {
      const memories = await this.list();
      const entry: MemoryEntry = {
        ...input,
        id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString()
      };
      memories.push(entry);
      await this.writeAtomic(memories);
      return entry;
    });
  }

  async search(query: string, limit = 5): Promise<MemoryEntry[]> {
    const terms = tokenize(query);
    const memories = await this.list();
    return memories
      .map((memory) => ({ memory, score: scoreMemory(memory, terms) }))
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.filePath);
    const previous = MemoryStore.writeChains.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    MemoryStore.writeChains.set(
      key,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    return current;
  }

  private async writeAtomic(memories: MemoryEntry[]): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.memory-${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(memories, null, 2)}\n`);
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private async quarantineCorruptFile(): Promise<void> {
    const corruptPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    try {
      await rename(this.filePath, corruptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
