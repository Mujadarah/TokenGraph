import { createHash } from "node:crypto";

import type { CodeSymbol, ProjectIndex, SymbolChunk } from "./types.js";

export type { SymbolChunk } from "./types.js";

function idFor(symbol: CodeSymbol): string {
  return createHash("sha256").update(JSON.stringify([
    symbol.filePath, symbol.name, symbol.kind, symbol.exported, symbol.startLine ?? null, symbol.endLine ?? null
  ])).digest("hex");
}

export function buildSymbolChunks(project: Pick<ProjectIndex, "symbols">): SymbolChunk[] {
  return project.symbols
    .map((symbol) => ({
      id: idFor(symbol),
      filePath: symbol.filePath,
      symbolName: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      ...(symbol.startLine === undefined ? {} : { startLine: symbol.startLine }),
      ...(symbol.endLine === undefined ? {} : { endLine: symbol.endLine })
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.symbolName.localeCompare(b.symbolName) || a.id.localeCompare(b.id));
}
