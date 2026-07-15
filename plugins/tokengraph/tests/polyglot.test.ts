import { describe, expect, it } from "vitest";
import { PINNED_GRAMMARS, TREE_SITTER_RUNTIME, assertStandalonePolyglot, parsePolyglotSource } from "../src/core/polyglot.js";

describe("standalone polyglot parser contract", () => {
  it("pins the runtime and official grammar versions", () => {
    expect(TREE_SITTER_RUNTIME).toBe("web-tree-sitter@0.26.11");
    expect(PINNED_GRAMMARS).toMatchObject({ python: { version: "v0.25.0" }, go: { version: "v0.25.0" }, rust: { version: "v0.24.2" }, java: { version: "v0.23.5" } });
  });

  it("normalizes source hashes and refuses workspace execution", async () => {
    const parsed = await parsePolyglotSource("python", "def sample():\r\n  return 'secret source'\n");
    expect(parsed).toMatchObject({ runtime: TREE_SITTER_RUNTIME, grammarVersion: "v0.25.0", symbols: ["sample"], workspaceExecution: false, parser: "tree-sitter" });
    expect(JSON.stringify(parsed.symbolDetails)).not.toContain("secret source");
    expect(() => assertStandalonePolyglot({ workspaceExecution: true })).toThrow(/standalone|workspace/i);
  });

  it("isolates parsing in a timeout-bounded worker and caps nodes and symbols", async () => {
    const source = Array.from({ length: 20 }, (_, index) => `def symbol_${index}():\n  return ${index}`).join("\n");
    await expect(parsePolyglotSource("python", source, undefined, { maxSymbols: 2, maxNodes: 1, timeoutMs: 2_000 })).resolves.toMatchObject({
      symbols: ["symbol_0", "symbol_1"],
      parser: "heuristic",
      degradedReason: expect.stringMatching(/node limit/i)
    });
    await expect(parsePolyglotSource("python", source, undefined, { timeoutMs: 1 })).rejects.toThrow(/timed out/i);
  });
});
