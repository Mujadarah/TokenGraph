import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { tokenize } from "./token.js";
import type { MemoryEntry, MemoryInput } from "./types.js";

function scoreMemory(memory: MemoryEntry, terms: string[]): number {
  const haystack = tokenize(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")}`);
  return terms.reduce((score, term) => score + (haystack.some((part) => part.includes(term) || term.includes(part)) ? 1 : 0), 0);
}

export class MemoryStore {
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
      throw error;
    }
  }

  async add(input: MemoryInput): Promise<MemoryEntry> {
    const memories = await this.list();
    const entry: MemoryEntry = {
      ...input,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString()
    };
    memories.push(entry);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(memories, null, 2)}\n`);
    return entry;
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
}

