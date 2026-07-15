import { describe, expect, it } from "vitest";
import { parseConfigurationData, parseConfigurationDataBounded } from "../src/core/configData.js";
import { buildSymbolChunks } from "../src/core/symbolChunks.js";
import { indexProject, updateProjectIndexIncremental } from "../src/core/projectIndexer.js";
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

  it("bounds configuration inheritance and path aliases without executing project code", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-config-chain-"));
    try {
      await writeFile(join(root, "tsconfig.json"), '{ "extends": "./base", "compilerOptions": { "paths": { "@one/*": ["src/*"] } } }');
      await writeFile(join(root, "base.json"), '{ "extends": "./tsconfig.json" }');
      const cyclic = await indexProject(root, { parserLimits: { maxTsconfigChain: 8, maxAliases: 8 } });
      expect(cyclic.configuration).toContainEqual(expect.objectContaining({ path: "tsconfig.json", status: "degraded", reason: expect.stringMatching(/cyclic/i) }));

      await writeFile(join(root, "tsconfig.json"), '{ "compilerOptions": { "paths": { "@one/*": ["src/*"], "@two/*": ["lib/*"] } } }');
      const aliases = await indexProject(root, { parserLimits: { maxTsconfigChain: 8, maxAliases: 1 } });
      expect(aliases.configuration).toContainEqual(expect.objectContaining({ path: "tsconfig.json", status: "degraded", reason: expect.stringMatching(/alias/i) }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wires configured source byte and symbol limits into indexing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-source-limits-"));
    try {
      await writeFile(join(root, "large.ts"), `export const payload = "${"x".repeat(512)}";\n`);
      await writeFile(join(root, "symbols.ts"), Array.from({ length: 8 }, (_, index) => `export const s${index} = ${index};`).join("\n"));
      const index = await indexProject(root, {
        parserLimits: { maxFileBytes: 256, maxTotalBytes: 1024, maxSymbols: 3, perFileTimeoutMs: 2_000, wholeIndexTimeoutMs: 10_000 }
      });
      expect(index.files.map((file) => file.path)).not.toContain("large.ts");
      expect(index.exclusions).toContainEqual(expect.objectContaining({ path: "large.ts", reason: "large-file" }));
      expect(index.symbols.filter((symbol) => symbol.filePath === "symbols.ts")).toHaveLength(3);
      expect(index.exclusions).toContainEqual(expect.objectContaining({ path: "symbols.ts", reason: "budget" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the generated-file cap consistently to metadata and full scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-generated-limit-"));
    try {
      await writeFile(join(root, "a.generated.ts"), "export const first = 1;\n");
      await writeFile(join(root, "b.generated.ts"), "export const second = 2;\n");
      await writeFile(join(root, "source.ts"), "export const source = 3;\n");
      const index = await indexProject(root, { parserLimits: { maxGeneratedFiles: 1 } });
      expect(index.files.map((file) => file.path)).toEqual(["a.generated.ts", "source.ts"]);
      expect(index.exclusions).toContainEqual(expect.objectContaining({ path: "b.generated.ts", reason: "budget" }));
      expect(Object.keys(index.scanMetadata?.files ?? {})).toEqual(["a.generated.ts", "source.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finishes with preserved exclusions when the whole-index budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-index-timeout-"));
    try {
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(root, `file-${index}.ts`), `export const value${index} = ${index};\n`);
      }
      const started = Date.now();
      const index = await indexProject(root, { parserLimits: { wholeIndexTimeoutMs: 1, perFileTimeoutMs: 1 } });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(index.exclusions.some((entry) => entry.reason === "budget")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses source limits for incremental updates and keeps B7 parsers promotion-gated", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-incremental-limits-"));
    try {
      await writeFile(join(root, "sample.ts"), "export const value = 1;\n");
      await writeFile(join(root, "sample.py"), "def promoted_symbol():\n  return True\n");
      await writeFile(join(root, "Sample.java"), "class HiddenUntilPromotion {}\n");
      const initial = await indexProject(root, { parserLimits: { maxFileBytes: 1024 } });
      expect(initial.symbols.some((symbol) => symbol.name === "promoted_symbol")).toBe(false);
      expect(initial.symbols.some((symbol) => symbol.name === "HiddenUntilPromotion")).toBe(false);
      expect(initial.symbols).toContainEqual(expect.objectContaining({ name: "value", provenance: "typescript", parserVersion: "5.9.3" }));
      const promoted = await indexProject(root, { polyglotEnabled: true, parserLimits: { perFileTimeoutMs: 2_000 } });
      expect(promoted.symbols.some((symbol) => symbol.name === "promoted_symbol" && symbol.provenance === "tree-sitter")).toBe(true);
      expect(promoted.symbols.some((symbol) => symbol.name === "HiddenUntilPromotion" && symbol.provenance === "tree-sitter")).toBe(true);

      await writeFile(join(root, "sample.ts"), `export const value = "${"x".repeat(256)}";\n`);
      const updated = await updateProjectIndexIncremental(root, initial, { parserLimits: { maxFileBytes: 64, maxTotalBytes: 1024 } });
      expect(updated.index.files.map((file) => file.path)).not.toContain("sample.ts");
      expect(updated.index.exclusions).toContainEqual(expect.objectContaining({ path: "sample.ts", reason: "large-file" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
