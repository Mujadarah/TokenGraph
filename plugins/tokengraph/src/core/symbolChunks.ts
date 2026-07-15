import { createHash } from "node:crypto";

import type { CodeSymbol, ProjectIndex, SymbolChunk } from "./types.js";

export type { SymbolChunk } from "./types.js";

function idFor(symbol: CodeSymbol): string {
  return createHash("sha256").update(JSON.stringify([
    symbol.filePath, symbol.name, symbol.kind, symbol.exported, symbol.startLine ?? null, symbol.endLine ?? null
  ])).digest("hex");
}

export function buildSymbolChunks(project: Pick<ProjectIndex, "symbols"> & Partial<Pick<ProjectIndex, "files" | "imports">>): SymbolChunk[] {
  const files = new Map((project.files ?? []).map((file) => [file.path, file]));
  const edges = new Map<string, string[]>();
  for (const edge of project.imports ?? []) {
    if (!edge.resolvedPath) continue;
    edges.set(edge.filePath, [...(edges.get(edge.filePath) ?? []), edge.resolvedPath]);
  }
  return project.symbols
    .map((symbol) => ({
      id: idFor(symbol),
      filePath: symbol.filePath,
      symbolName: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      ...(symbol.startLine === undefined ? {} : { startLine: symbol.startLine }),
      ...(symbol.endLine === undefined ? {} : { endLine: symbol.endLine }),
      ...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
      ...(symbol.summary === undefined ? {} : { summary: symbol.summary }),
      ...(edges.has(symbol.filePath) ? { edges: [...new Set(edges.get(symbol.filePath) ?? [])].sort() } : {}),
      ...(symbol.provenance === undefined ? {} : { provenance: symbol.provenance }),
      ...(files.get(symbol.filePath)?.contentHash ? { contentHash: files.get(symbol.filePath)!.contentHash } : {}),
      ...(symbol.parserVersion === undefined ? {} : { parserVersion: symbol.parserVersion })
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.symbolName.localeCompare(b.symbolName) || a.id.localeCompare(b.id));
}
