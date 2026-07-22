import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStableArtifact } from "../src/core/artifact.js";
import { buildEvidenceBackedSliceRecommendation, buildRetrievalCapsule, capsuleArtifact, deliverDelta, escalateReadPolicy, expandGraph, rankFilesBm25, readExactSlice, recommendExactRead, startReadPolicyResponse } from "../src/core/retrieval.js";
import type { CodeFile, ProjectIndex } from "../src/core/types.js";

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

function rankingIndex(
  files: Array<Pick<CodeFile, "path" | "kind" | "language" | "isTest">>,
  distances: Record<string, number> = {}
): ProjectIndex {
  return {
    ...index(),
    files: files.map((file, position) => ({
      ...file,
      size: 20,
      estimatedTokens: 5,
      contentHash: `${position}`
    })),
    symbols: files.map((file) => ({
      name: "target",
      kind: "function" as const,
      filePath: file.path,
      exported: true
    })),
    imports: [],
    retrievalSignals: { source: "git-commit-distance", historyDepth: 50, fileCommitDistance: distances }
  };
}

describe("deterministic retrieval", () => {
  it("ranks BM25 deterministically and expands graph edges", () => {
    const project = index();
    expect(rankFilesBm25(project, "authenticate", 2)[0]).toMatchObject({ path: "src/auth.ts", rank: 1 });
    expect(expandGraph(project, ["src/user.ts"], 1)).toEqual(["src/auth.ts", "src/user.ts"]);
    expect(buildRetrievalCapsule("task-1", "user", project, ["src/user.ts"], 0).references.map((entry) => entry.path)).toEqual(["src/user.ts"]);
    const first = buildRetrievalCapsule("task-1", "authenticate", project);
    const second = buildRetrievalCapsule("task-1", "authenticate", project);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("source text");
    const statements = [...first.files, ...first.symbols, ...first.references];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatchObject({
        text: expect.any(String),
        evidenceClass: expect.stringMatching(/^(indexed|derived)$/),
        confidence: expect.stringMatching(/^(medium|high)$/),
        source: expect.any(String)
      });
      expect(statement.text.trim()).not.toBe("");
      expect(statement.source.trim()).not.toBe("");
    }
    expect(first.files[0]).toMatchObject({
      path: "src/auth.ts",
      evidenceClass: "indexed",
      confidence: "high",
      source: "index:file:src/auth.ts@a"
    });
    expect(first.references[0]).toMatchObject({ path: "src/auth.ts", evidenceClass: "derived" });

    const otherTask = buildRetrievalCapsule("task-2", "authenticate", project);
    expect(otherTask).toEqual(first);
    expect(capsuleArtifact(otherTask)).toEqual(capsuleArtifact(first));
    expect(capsuleArtifact(first).artifactSchemaVersion).toBe(5);
    expect(capsuleArtifact(first).hash).not.toBe(createStableArtifact("capsule/retrieval", first, 4).hash);
    expect(JSON.stringify(capsuleArtifact(first))).not.toContain("task-1");
  });

  it("breaks lexical ties with bounded Git commit distance", () => {
    const project = rankingIndex([
      { path: "src/old.ts", kind: "module", language: "typescript", isTest: false },
      { path: "src/recent.ts", kind: "module", language: "typescript", isTest: false }
    ], { "src/old.ts": 10, "src/recent.ts": 0 });

    const ranked = rankFilesBm25(project, "implement target", 2);

    expect(ranked.map((entry) => entry.path)).toEqual(["src/recent.ts", "src/old.ts"]);
    expect(Number((ranked[0]!.score - ranked[1]!.score).toFixed(6))).toBe(0.03);
  });

  it.each([
    ["coverage target", "tests/target.spec.ts", [
      { path: "src/target.ts", kind: "module", language: "typescript", isTest: false },
      { path: "tests/target.spec.ts", kind: "test", language: "typescript", isTest: true }
    ]],
    ["database target", "z-db/target.sql", [
      { path: "a-src/target.ts", kind: "module", language: "typescript", isTest: false },
      { path: "z-db/target.sql", kind: "sql", language: "sql", isTest: false }
    ]],
    ["documentation target", "z-docs/target.md", [
      { path: "a-src/target.ts", kind: "module", language: "typescript", isTest: false },
      { path: "z-docs/target.md", kind: "doc", language: "markdown", isTest: false }
    ]],
    ["implement target", "z-src/target.ts", [
      { path: "a-notes/target.md", kind: "doc", language: "markdown", isTest: false },
      { path: "z-src/target.ts", kind: "module", language: "typescript", isTest: false }
    ]],
    ["cleanup target", "z-src/target.ts", [
      { path: "a-notes/target.md", kind: "doc", language: "markdown", isTest: false },
      { path: "z-src/target.ts", kind: "module", language: "typescript", isTest: false }
    ]],
    ["fix target", "tests/target.spec.ts", [
      { path: "src/target.ts", kind: "module", language: "typescript", isTest: false },
      { path: "tests/target.spec.ts", kind: "test", language: "typescript", isTest: true }
    ]],
    ["design target", "y-docs/target.md", [
      { path: "a-tests/target.spec.ts", kind: "test", language: "typescript", isTest: true },
      { path: "y-docs/target.md", kind: "doc", language: "markdown", isTest: false },
      { path: "z-src/target.ts", kind: "module", language: "typescript", isTest: false }
    ]]
  ] as const)("applies the shared task-type weight for %s", (query, expectedPath, files) => {
    expect(rankFilesBm25(rankingIndex([...files]), query, files.length)[0]?.path).toBe(expectedPath);
  });

  it("never introduces zero-BM25 files and preserves deterministic top-k path ordering", () => {
    const project = rankingIndex([
      { path: "src/alpha.ts", kind: "module", language: "typescript", isTest: false },
      { path: "src/beta.ts", kind: "module", language: "typescript", isTest: false },
      { path: "src/unrelated.ts", kind: "module", language: "typescript", isTest: false }
    ]);
    project.symbols = project.symbols.filter((symbol) => symbol.filePath !== "src/unrelated.ts");

    expect(rankFilesBm25(project, "implement target", 1)).toEqual([
      expect.objectContaining({ path: "src/alpha.ts", rank: 1 })
    ]);
    expect(rankFilesBm25(project, "implement target", 10).map((entry) => entry.path)).not.toContain("src/unrelated.ts");
  });

  it("reads only confined exact slices and escalates monotonically", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-retrieval-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
      const currentContentHash = "b6285c57e8797db5d4c51c80d6f11938afda9b11c6a003549709189e9b4b92a2";
      const slice = await readExactSlice(root, "src/a.ts", 2, 3, 64 * 1024, currentContentHash);
      expect(slice.text).toBe("two\nthree");
      expect(slice.contentHash).toBe(currentContentHash);
      await writeFile(join(root, "src", "a.ts"), "one\nchanged\nthree\n");
      await expect(readExactSlice(root, "src/a.ts", 2, 3, 64 * 1024, currentContentHash)).rejects.toThrow(/current source hash/i);
      await expect(readExactSlice(root, "src/a.ts", 1, 1, 64 * 1024, undefined, 1)).rejects.toThrow(/source file.*byte limit/i);
      await expect(readExactSlice(root, "../outside.ts", 1, 1)).rejects.toThrow(/confined|relative/i);
      const policy = escalateReadPolicy({ level: "L1", allowRawReads: false, reason: "capsule" }, "L3");
      expect(policy).toMatchObject({ level: "L3", allowRawReads: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a matching host handshake for delta delivery", () => {
    const artifact = { id: "a", hash: "h", artifactSchemaVersion: 1, content: { value: 1 } };
    expect(deliverDelta({ handshakeId: "h", hostContextId: "c", sequence: 0 }, { handshakeId: "h", hostContextId: "c", sequence: 1 }, [artifact])).toMatchObject({ handshake: { sequence: 1 }, artifacts: [artifact], artifactReferences: [] });
    expect(deliverDelta({ handshakeId: "h", hostContextId: "c", sequence: 0 }, { handshakeId: "h", hostContextId: "c", sequence: 1 }, [artifact], ["a@h"])).toMatchObject({ artifacts: [], artifactReferences: [{ id: "a", hash: "h" }] });
    expect(deliverDelta({ handshakeId: "h", hostContextId: "c", sequence: 0 }, { handshakeId: "h", hostContextId: "c", sequence: 1 }, [artifact], ["other@h"])).toMatchObject({ artifacts: [artifact], artifactReferences: [] });
    expect(() => deliverDelta({ handshakeId: "h", hostContextId: "c", sequence: 0 }, { handshakeId: "h", hostContextId: "other", sequence: 1 }, [artifact])).toThrow(/handshake/i);
  });

  it("limits exact-read advice to one per response and forces reassessment after three reads", () => {
    let state = escalateReadPolicy({ level: "L1", allowRawReads: false, reason: "capsule" }, "L3");
    for (let read = 0; read < 3; read += 1) {
      state = startReadPolicyResponse(state);
      const recommendation = recommendExactRead(state);
      expect(recommendation.allowed).toBe(true);
      state = recommendation.state;
      expect(recommendExactRead(state)).toMatchObject({ allowed: false, reason: expect.stringMatching(/one exact read/i) });
    }
    expect(state.requiresReassessment).toBe(true);
    state = startReadPolicyResponse(state);
    expect(recommendExactRead(state)).toMatchObject({ allowed: false, reason: expect.stringMatching(/reassessment/i) });
    expect(recommendExactRead(state, { reassessed: true })).toMatchObject({ allowed: false, reason: expect.stringMatching(/evidence gap/i) });
    expect(recommendExactRead(state, { reassessed: true, evidenceGap: "Need the concrete generic constraint." })).toMatchObject({ allowed: true, state: { targetedReads: 4, requiresReassessment: false } });
  });

  it("marks editing read recommendations as derived from a hash-bound indexed range", () => {
    expect(buildEvidenceBackedSliceRecommendation("src/auth.ts", 1, 3, "abc")).toMatchObject({
      mode: "slice", file: "src/auth.ts", startLine: 1, endLine: 3, contentHash: "abc",
      evidenceClass: "derived", confidence: "high",
      source: "index:symbol-range:src/auth.ts@abc:1-3"
    });
  });
});
