import { describe, expect, it } from "vitest";
import { PINNED_GRAMMARS, TREE_SITTER_RUNTIME, assertStandalonePolyglot, parsePolyglotSource } from "../src/core/polyglot.js";

describe("standalone polyglot parser contract", () => {
  it("pins the runtime and official grammar versions", () => {
    expect(TREE_SITTER_RUNTIME).toBe("web-tree-sitter@0.26.11");
    expect(PINNED_GRAMMARS).toMatchObject({ python: { version: "v0.25.0" }, go: { version: "v0.25.0" }, rust: { version: "v0.24.2" }, java: { version: "v0.23.5" } });
  });

  it("normalizes source hashes and refuses workspace execution", () => {
    expect(parsePolyglotSource("python", "def sample():\r\n  return True\n")).toMatchObject({ runtime: TREE_SITTER_RUNTIME, grammarVersion: "v0.25.0", symbols: ["sample"], workspaceExecution: false });
    expect(() => assertStandalonePolyglot({ workspaceExecution: true })).toThrow(/standalone|workspace/i);
  });
});
