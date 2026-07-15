import { describe, expect, it } from "vitest";
import { parseConfigurationData, parseConfigurationDataBounded } from "../src/core/configData.js";
import { buildSymbolChunks } from "../src/core/symbolChunks.js";
import { indexProject } from "../src/core/projectIndexer.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("bounded configuration parsing", () => {
  it("treats tsconfig-like input as data and enforces limits", async () => {
    await expect(parseConfigurationDataBounded('{ /* comment */ "compilerOptions": { "strict": true, }, }')).resolves.toEqual({ compilerOptions: { strict: true } });
    expect(() => parseConfigurationData('{ "__proto__": { "polluted": true } }')).toThrow(/unsafe/i);
    expect(() => parseConfigurationData(JSON.stringify({ nested: { value: 1 } }), { maxDepth: 1 })).toThrow(/nesting/i);
    expect(() => parseConfigurationData("x".repeat(20), { maxBytes: 10 })).toThrow(/byte/i);
  });
});

describe("source-free SymbolChunk records", () => {
  it("is deterministic and contains no source text", () => {
    const chunks = buildSymbolChunks({ symbols: [
      { name: "zeta", kind: "function", filePath: "src/a.ts", exported: true, startLine: 4, endLine: 5 },
      { name: "alpha", kind: "const", filePath: "src/a.ts", exported: false }
    ] });
    expect(chunks.map((chunk) => chunk.symbolName)).toEqual(["alpha", "zeta"]);
    expect(chunks[0]).not.toHaveProperty("source");
    expect(chunks[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(buildSymbolChunks({ symbols: [...chunks.map((chunk) => ({ name: chunk.symbolName, kind: chunk.kind, filePath: chunk.filePath, exported: chunk.exported, startLine: chunk.startLine, endLine: chunk.endLine }))] })).toEqual(chunks);
  });

  it("persists source-free chunks alongside the project index", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-indexing-"));
    try {
      await writeFile(join(root, "sample.ts"), "export function sample() { return 'secret source'; }\n");
      const index = await indexProject(root);
      expect(index.symbolChunks).toEqual(expect.arrayContaining([expect.objectContaining({ symbolName: "sample", filePath: "sample.ts" })]));
      expect(JSON.stringify(index.symbolChunks)).not.toContain("secret source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses configuration as bounded data and preserves file-local degradation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-config-indexing-"));
    try {
      await writeFile(join(root, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }');
      await writeFile(join(root, "jsconfig.json"), '{ "compilerOptions": { "extends": "./missing", ' + '"x": ' + '"'.padEnd(600000, "x") + '" } }');
      const index = await indexProject(root);
      expect(index.configuration).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "tsconfig.json", status: "parsed" }),
        expect.objectContaining({ path: "jsconfig.json", status: "degraded" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
