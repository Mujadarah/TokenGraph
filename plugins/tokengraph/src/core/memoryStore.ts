import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { tokenize } from "./token.js";
import { withFileLock } from "./storage.js";
import type { MemoryConflict, MemoryEntry, MemoryInput, MemoryRecall, MemoryStatus, MemoryUpdateInput } from "./types.js";

interface MemoryListOptions {
  includeDeprecated?: boolean;
  includeDeleted?: boolean;
}

interface MemoryRecallOptions extends MemoryListOptions {
  auditMode?: boolean;
  limit?: number;
}

const DEFAULT_SOURCE = "manual";
const CURRENT_MEMORY_SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function unique(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())));
}

function scoreMemory(memory: MemoryEntry, terms: string[]): number {
  const haystack = tokenize(
    [
      memory.type,
      memory.title,
      memory.body,
      memory.tags.join(" "),
      memory.linkedFiles.join(" "),
      memory.linkedSymbols.join(" "),
      memory.linkedSqlObjects.join(" "),
      memory.linkedRules.join(" "),
      memory.evidence.join(" ")
    ].join(" ")
  );
  return terms.reduce((score, term) => score + (haystack.some((part) => part.includes(term) || term.includes(part)) ? 1 : 0), 0);
}

function normalizeMemory(value: unknown): MemoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<MemoryEntry>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.type !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.body !== "string" ||
    !Array.isArray(candidate.tags) ||
    typeof candidate.createdAt !== "string"
  ) {
    return undefined;
  }
  const status: MemoryStatus = candidate.status === "deprecated" || candidate.status === "deleted" ? candidate.status : "active";
  const createdAt = candidate.createdAt;
  return {
    type: candidate.type,
    title: candidate.title,
    body: candidate.body,
    tags: unique(candidate.tags),
    id: candidate.id,
    createdAt,
    status,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt,
    ...(typeof candidate.lastUsedAt === "string" ? { lastUsedAt: candidate.lastUsedAt } : {}),
    ...(typeof candidate.confirmedAt === "string" ? { confirmedAt: candidate.confirmedAt } : {}),
    linkedFiles: unique(candidate.linkedFiles),
    linkedSymbols: unique(candidate.linkedSymbols),
    linkedSqlObjects: unique(candidate.linkedSqlObjects),
    linkedRules: unique(candidate.linkedRules),
    confidence: candidate.confidence === "high" || candidate.confidence === "low" ? candidate.confidence : "medium",
    supersedes: unique(candidate.supersedes),
    supersededBy: unique(candidate.supersededBy),
    source: typeof candidate.source === "string" && candidate.source.trim() ? candidate.source : DEFAULT_SOURCE,
    evidence: unique(candidate.evidence)
  };
}

function createMemory(input: MemoryInput): MemoryEntry {
  const timestamp = nowIso();
  return {
    type: input.type,
    title: input.title,
    body: input.body,
    tags: unique(input.tags),
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: timestamp,
    status: input.status ?? "active",
    updatedAt: timestamp,
    linkedFiles: unique(input.linkedFiles),
    linkedSymbols: unique(input.linkedSymbols),
    linkedSqlObjects: unique(input.linkedSqlObjects),
    linkedRules: unique(input.linkedRules),
    confidence: input.confidence ?? "medium",
    supersedes: unique(input.supersedes),
    supersededBy: unique(input.supersededBy),
    source: input.source?.trim() || DEFAULT_SOURCE,
    evidence: unique(input.evidence)
  };
}

function mergeMemory(memory: MemoryEntry, update: MemoryUpdateInput): MemoryEntry {
  return {
    ...memory,
    ...update,
    tags: update.tags ? unique(update.tags) : memory.tags,
    linkedFiles: update.linkedFiles ? unique(update.linkedFiles) : memory.linkedFiles,
    linkedSymbols: update.linkedSymbols ? unique(update.linkedSymbols) : memory.linkedSymbols,
    linkedSqlObjects: update.linkedSqlObjects ? unique(update.linkedSqlObjects) : memory.linkedSqlObjects,
    linkedRules: update.linkedRules ? unique(update.linkedRules) : memory.linkedRules,
    supersedes: update.supersedes ? unique(update.supersedes) : memory.supersedes,
    supersededBy: update.supersededBy ? unique(update.supersededBy) : memory.supersededBy,
    evidence: update.evidence ? unique(update.evidence) : memory.evidence,
    id: memory.id,
    createdAt: memory.createdAt,
    status: update.status ?? memory.status,
    confidence: update.confidence ?? memory.confidence,
    source: update.source?.trim() || memory.source,
    updatedAt: nowIso()
  };
}

function filterByStatus(memories: MemoryEntry[], options: MemoryListOptions): MemoryEntry[] {
  return memories.filter((memory) => {
    if (memory.status === "deleted" && !options.includeDeleted) return false;
    if (memory.status === "deprecated" && !options.includeDeprecated) return false;
    return true;
  });
}

export class MemoryStore {
  private static readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly filePath: string) {}

  async list(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    return filterByStatus(await this.readAll(), options);
  }

  async add(input: MemoryInput): Promise<MemoryEntry> {
    return this.enqueueWrite(async () => {
      const memories = await this.readAll();
      const entry = createMemory(input);
      memories.push(entry);
      await this.writeAtomic(memories);
      return entry;
    });
  }

  async update(id: string, update: MemoryUpdateInput): Promise<MemoryEntry | undefined> {
    return this.enqueueWrite(async () => {
      const memories = await this.readAll();
      const index = memories.findIndex((memory) => memory.id === id);
      if (index === -1) return undefined;
      const next = mergeMemory(memories[index], update);
      memories[index] = next;
      await this.writeAtomic(memories);
      return next;
    });
  }

  async deprecate(id: string, supersededBy: string[] = [], evidence: string[] = []): Promise<MemoryEntry | undefined> {
    return this.mutate(id, (memory) =>
      mergeMemory(memory, {
        status: "deprecated",
        supersededBy: unique([...memory.supersededBy, ...supersededBy]),
        evidence: unique([...memory.evidence, ...evidence])
      })
    );
  }

  async delete(id: string, options: { hard?: boolean } = {}): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const memories = await this.readAll();
      const index = memories.findIndex((memory) => memory.id === id);
      if (index === -1) return false;
      if (options.hard) {
        memories.splice(index, 1);
      } else {
        memories[index] = mergeMemory(memories[index], { status: "deleted" });
      }
      await this.writeAtomic(memories);
      return true;
    });
  }

  async confirm(id: string, evidence: string[] = [], confidence: MemoryEntry["confidence"] = "high"): Promise<MemoryEntry | undefined> {
    return this.mutate(id, (memory) =>
      mergeMemory(memory, {
        confirmedAt: nowIso(),
        confidence,
        evidence: unique([...memory.evidence, ...evidence])
      })
    );
  }

  async link(id: string, links: Pick<MemoryUpdateInput, "linkedFiles" | "linkedSymbols" | "linkedSqlObjects" | "linkedRules" | "evidence" | "source">): Promise<MemoryEntry | undefined> {
    return this.mutate(id, (memory) =>
      mergeMemory(memory, {
        linkedFiles: unique([...memory.linkedFiles, ...(links.linkedFiles ?? [])]),
        linkedSymbols: unique([...memory.linkedSymbols, ...(links.linkedSymbols ?? [])]),
        linkedSqlObjects: unique([...memory.linkedSqlObjects, ...(links.linkedSqlObjects ?? [])]),
        linkedRules: unique([...memory.linkedRules, ...(links.linkedRules ?? [])]),
        evidence: unique([...memory.evidence, ...(links.evidence ?? [])]),
        ...(links.source ? { source: links.source } : {})
      })
    );
  }

  async search(query: string, limit = 5): Promise<MemoryEntry[]> {
    const terms = tokenize(query);
    const memories = await this.list();
    return this.rank(memories, terms)
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  async recall(query: string, options: MemoryRecallOptions = {}): Promise<MemoryRecall> {
    const auditMode = options.auditMode === true;
    const terms = tokenize(query);
    const memories = await this.list({ includeDeprecated: auditMode || options.includeDeprecated, includeDeleted: auditMode || options.includeDeleted });
    const ranked = this.rank(memories, terms)
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .slice(0, Math.max(1, Math.min(options.limit ?? 10, 50)))
      .map((entry) => entry.memory);
    await this.markUsed(ranked.filter((memory) => memory.status === "active").map((memory) => memory.id));
    const refreshed = await this.list({ includeDeprecated: auditMode || options.includeDeprecated, includeDeleted: auditMode || options.includeDeleted });
    const byId = new Map(refreshed.map((memory) => [memory.id, memory]));
    return {
      query,
      auditMode,
      memories: ranked.map((memory) => byId.get(memory.id) ?? memory),
      policy: auditMode
        ? "Audit recall includes deprecated and deleted memories for inspection."
        : "Normal recall returns active memories and excludes deprecated or deleted memories."
    };
  }

  async findConflicts(input: { id?: string; candidate?: MemoryInput; query?: string; limit?: number }): Promise<MemoryConflict[]> {
    const memories = await this.list();
    const baseMemory = input.id ? memories.find((memory) => memory.id === input.id) : undefined;
    const queryText = input.query ?? (input.candidate ? `${input.candidate.type} ${input.candidate.title} ${input.candidate.body} ${input.candidate.tags.join(" ")}` : "");
    const terms = tokenize(
      baseMemory
        ? `${baseMemory.title} ${baseMemory.body} ${baseMemory.tags.join(" ")}`
        : input.candidate
          ? `${input.candidate.title} ${input.candidate.body} ${input.candidate.tags.join(" ")}`
          : queryText
    );
    return memories
      .filter((memory) => memory.id !== input.id)
      .map((memory) => {
        const memoryTerms = tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`);
        const matchedTerms = unique(terms.filter((term) => memoryTerms.some((part) => part.includes(term) || term.includes(part))));
        const sameType = input.candidate?.type ? memory.type === input.candidate.type : baseMemory ? memory.type === baseMemory.type : true;
        const contradictionHint = /\b(no|not|never|avoid|prefer|instead|deprecated|replace|use)\b/i.test(`${queryText} ${memory.title} ${memory.body}`);
        const reason = contradictionHint
          ? "Potential conflict: overlapping memory terms and incompatible guidance language were found."
          : "Potential conflict: overlapping memory terms should be reviewed before relying on either memory.";
        return { memory, matchedTerms, sameType, contradictionHint, reason };
      })
      .filter((entry) => entry.sameType && entry.matchedTerms.length >= 2)
      .sort((a, b) => Number(b.contradictionHint) - Number(a.contradictionHint) || b.matchedTerms.length - a.matchedTerms.length)
      .slice(0, Math.max(1, Math.min(input.limit ?? 10, 50)))
      .map(({ memory, matchedTerms, reason }) => ({ memory, matchedTerms, reason }));
  }

  private rank(memories: MemoryEntry[], terms: string[]) {
    return memories
      .map((memory) => {
        const linkedCount = memory.linkedFiles.length + memory.linkedSymbols.length + memory.linkedSqlObjects.length + memory.linkedRules.length;
        const score =
          scoreMemory(memory, terms) * 3 +
          (memory.status === "active" ? 2 : memory.status === "deprecated" ? -4 : -12) +
          (memory.confirmedAt ? 5 : 0) +
          Math.min(linkedCount, 4) +
          (memory.confidence === "high" ? 3 : memory.confidence === "low" ? -1 : 0);
        return { memory, score };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.memory.confirmedAt ?? "").localeCompare(a.memory.confirmedAt ?? "") ||
          (b.memory.lastUsedAt ?? b.memory.createdAt).localeCompare(a.memory.lastUsedAt ?? a.memory.createdAt)
      );
  }

  private async markUsed(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.enqueueWrite(async () => {
      const memories = await this.readAll();
      const timestamp = nowIso();
      let changed = false;
      for (const memory of memories) {
        if (ids.includes(memory.id)) {
          memory.lastUsedAt = timestamp;
          memory.updatedAt = timestamp;
          changed = true;
        }
      }
      if (changed) {
        await this.writeAtomic(memories);
      }
    });
  }

  private async mutate(id: string, transform: (memory: MemoryEntry) => MemoryEntry): Promise<MemoryEntry | undefined> {
    return this.enqueueWrite(async () => {
      const memories = await this.readAll();
      const index = memories.findIndex((memory) => memory.id === id);
      if (index === -1) return undefined;
      const next = transform(memories[index]);
      memories[index] = next;
      await this.writeAtomic(memories);
      return next;
    });
  }

  private async readAll(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown }).memories)
          ? (parsed as { memories: unknown[] }).memories
          : [];
      return records.map(normalizeMemory).filter((memory): memory is MemoryEntry => Boolean(memory));
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

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.filePath);
    const previous = MemoryStore.writeChains.get(key) ?? Promise.resolve();
    const current = previous.then(
      () => withFileLock(`${key}.lock`, operation),
      () => withFileLock(`${key}.lock`, operation)
    );
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
      await writeFile(
        tempPath,
        `${JSON.stringify(
          {
            schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
            memories
          },
          null,
          2
        )}\n`
      );
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
