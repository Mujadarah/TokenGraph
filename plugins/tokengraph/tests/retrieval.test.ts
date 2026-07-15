import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRetrievalCapsule, deliverDelta, escalateReadPolicy, expandGraph, rankFilesBm25, readExactSlice } from "../src/core/retrieval.js";
import type { ProjectIndex } from "../src/core/types.js";

function index(): ProjectIndex {
  return {
    root: ".", scannedAt: "2026-01-01T00:00:00.000Z", fingerprint: "f", frameworks: [],
    files: [
      { path: "src/auth.ts", kind: "module", language: "typescript", size: 20, estimatedTokens: 5, contentHash: "a", isTest: false },
      { path: "src/user.ts", kind: "module", language: "typescript", size: 20, estimatedTokens: 5, contentHash: "b", isTest: false }
    ],
    symbols: [{ name: "authenticate", kind: "function", filePath: "src/auth.ts", exported: true, startLine: 1, endLine: 3 }],
    imports: [{ filePath: "src/user.ts", source: "./auth", resolvedPath: "src/auth.ts" }], exclusions: [],
    sql: { tables: [], relations: [], constraints: [], policies: [], indexes: [], triggers: [], functions: [], views: [], enums: [], extensions: [], grants: [], materializedViews: [], history: [], warnings: [] }
  };
}

describe("deterministic retrieval", () => {
  it("ranks BM25 deterministically and expands graph edges", () => {
    const project = index();
    expect(rankFilesBm25(project, "authenticate", 2)[0]).toMatchObject({ path: "src/auth.ts", rank: 1 });
    expect(expandGraph(project, ["src/user.ts"], 1)).toEqual(["src/auth.ts", "src/user.ts"]);
    const first = buildRetrievalCapsule("task-1", "authenticate", project);
    const second = buildRetrievalCapsule("task-1", "authenticate", project);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("source text");
  });

  it("reads only confined exact slices and escalates monotonically", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-retrieval-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
      const slice = await readExactSlice(root, "src/a.ts", 2, 3);
      expect(slice.text).toBe("two\nthree");
      await expect(readExactSlice(root, "../outside.ts", 1, 1)).rejects.toThrow(/confined|relative/i);
      const policy = escalateReadPolicy({ level: "L1", allowRawReads: false, reason: "capsule" }, "L3");
      expect(policy).toMatchObject({ level: "L3", allowRawReads: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a matching host handshake for delta delivery", () => {
    const artifact = { id: "a", hash: "h", artifactSchemaVersion: 1, content: { value: 1 } };
    expect(deliverDelta({ handshakeId: "h", hostContextId: "c", sequence: 0 }, { handshakeId: "h", hostContextId: "c", sequence: 1 }, [artifact])).toMatchObject({ handshake: { sequence: 1 }, artifacts: [artifact] });
    expect(() => deliverDelta({ handshakeId: "h", hostContextId: "c", sequence: 0 }, { handshakeId: "h", hostContextId: "other", sequence: 1 }, [artifact])).toThrow(/handshake/i);
  });
});
