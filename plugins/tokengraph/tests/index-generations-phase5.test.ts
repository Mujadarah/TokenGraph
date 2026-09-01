import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_INDEX_SCHEMA_VERSION, indexProject } from "../src/core/projectIndexer.js";
import {
  indexGenerationPath,
  indexManifestPath,
  indexPath,
  loadProjectIndex,
  saveProjectIndex,
  type ProjectIndexManifest
} from "../src/core/persistence.js";
import { purgeStorageClass, storageClassUsage } from "../src/core/storagePolicy.js";
import { refreshProjectIndex } from "../src/server.js";

const roots: string[] = [];
const execFile = promisify(execFileCallback);

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tg-p5-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

async function readManifest(root: string): Promise<ProjectIndexManifest> {
  return JSON.parse(await readFile(indexManifestPath(root), "utf8")) as ProjectIndexManifest;
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("transactional index generations", () => {
  it("builds schema-v5 indexes with validated generation metadata", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const index = await indexProject(root);

    expect(CURRENT_INDEX_SCHEMA_VERSION).toBe(5);
    expect(index.schemaVersion).toBe(5);
    expect(index.generation).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      createdAt: index.scannedAt,
      sourceScanSignature: index.scanSignature,
      intendedFileCount: 1,
      validatedContentSetHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("publishes a validated immutable generation through the minimal manifest", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const index = await indexProject(root);

    await saveProjectIndex(root, index);

    await expect(access(indexPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = await readManifest(root);
    expect(manifest).toEqual({
      generationFile: `.index-generation-${index.generation!.id}.json`,
      generationId: index.generation!.id,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(JSON.parse(await readFile(indexGenerationPath(root, index.generation!.id), "utf8"))).toMatchObject({
      schemaVersion: 5,
      generation: { id: index.generation!.id }
    });
    await expect(loadProjectIndex(root)).resolves.toMatchObject({ generation: { id: index.generation!.id } });
  });

  it("accounts and purges abandoned generation artifacts as cache state", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const name = ".index-generation-11111111-1111-4111-8111-111111111111.candidate.json";
    const path = join(root, ".tokengraph", name);
    await writeFile(path, "candidate");

    await expect(storageClassUsage(root)).resolves.toMatchObject({ cache: { bytes: 9, files: 1 } });
    const result = await purgeStorageClass(root, "cache", { confirmedNoLegacyTokenGraphProcesses: true });

    expect(result.removed).toContain(`.tokengraph/${name}`);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the active generation and legacy evidence during cache purge", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const active = await indexProject(root);
    await saveProjectIndex(root, active);
    await writeFile(indexPath(root), "legacy-evidence");
    const abandoned = ".index-generation-11111111-1111-4111-8111-111111111111.json";
    await writeFile(join(root, ".tokengraph", abandoned), "abandoned");

    await purgeStorageClass(root, "cache", { confirmedNoLegacyTokenGraphProcesses: true });

    await expect(access(indexManifestPath(root))).resolves.toBeUndefined();
    await expect(access(indexGenerationPath(root, active.generation!.id))).resolves.toBeUndefined();
    await expect(readFile(indexPath(root), "utf8")).resolves.toBe("legacy-evidence");
    await expect(access(join(root, ".tokengraph", abandoned))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the active publication when generation quota validation fails", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "src", "entry.ts");
    await writeFile(sourcePath, "export const entry = 'first';\n");
    const active = await indexProject(root);
    await saveProjectIndex(root, active);
    const activeManifest = await readFile(indexManifestPath(root), "utf8");
    await writeFile(sourcePath, "export const entry = 'second';\n");

    await expect(refreshProjectIndex(root, active, {
      storageQuotas: {
        maxBytes: 10_000_000,
        runsMaxBytes: 10_000_000,
        cacheMaxBytes: 1,
        vaultMaxBytes: 10_000_000,
        durableMaxBytes: 10_000_000
      }
    })).rejects.toThrow(/cache.*quota/i);

    await expect(readFile(indexManifestPath(root), "utf8")).resolves.toBe(activeManifest);
    await expect(loadProjectIndex(root)).resolves.toMatchObject({ generation: { id: active.generation!.id } });
  });

  it("fails closed when the manifest-selected generation is tampered", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const index = await indexProject(root);
    await saveProjectIndex(root, index);
    const manifest = await readManifest(root);
    const generationPath = join(root, ".tokengraph", manifest.generationFile);
    const persisted = JSON.parse(await readFile(generationPath, "utf8"));
    persisted.generation.validatedContentSetHash = "0".repeat(64);
    await writeFile(generationPath, serialized(persisted));

    await expect(loadProjectIndex(root)).resolves.toBeUndefined();
  });

  it("fails closed for malformed, foreign, and missing manifest targets", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(indexManifestPath(root), "{malformed");
    await expect(loadProjectIndex(root)).resolves.toBeUndefined();

    await writeFile(indexManifestPath(root), JSON.stringify({
      generationFile: "../foreign.json",
      generationId: "11111111-1111-4111-8111-111111111111",
      contentHash: "0".repeat(64)
    }));
    await expect(loadProjectIndex(root)).resolves.toBeUndefined();

    await writeFile(indexManifestPath(root), JSON.stringify({
      generationFile: ".index-generation-11111111-1111-4111-8111-111111111111.json",
      generationId: "11111111-1111-4111-8111-111111111111",
      contentHash: "0".repeat(64)
    }));
    await expect(loadProjectIndex(root)).resolves.toBeUndefined();
  });

  it("retries a bounded pointer race until the immutable generation appears", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const candidate = await indexProject(root);
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const generationContent = serialized(candidate);
    await writeFile(indexManifestPath(root), JSON.stringify({
      generationFile: `.index-generation-${candidate.generation!.id}.json`,
      generationId: candidate.generation!.id,
      contentHash: createHash("sha256").update(generationContent).digest("hex")
    }));
    const delayedWrite = new Promise<void>((resolveWrite, rejectWrite) => {
      setTimeout(() => {
        writeFile(indexGenerationPath(root, candidate.generation!.id), generationContent).then(() => resolveWrite(), rejectWrite);
      }, 20);
    });

    await expect(loadProjectIndex(root)).resolves.toMatchObject({ generation: { id: candidate.generation!.id } });
    await delayedWrite;
  });

  it("records terminal exclusions in the intended content set", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    await writeFile(join(root, "src", "binary.ts"), "binary\u0000content");

    const index = await indexProject(root);

    expect(index.files.map((file) => file.path)).toEqual(["src/entry.ts"]);
    expect(index.exclusions).toContainEqual({ path: "src/binary.ts", reason: "binary" });
    expect(index.generation?.intendedFileCount).toBe(2);
  });

  it("ignores an unreferenced generation left by a crash before manifest replacement", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "src", "entry.ts");
    await writeFile(sourcePath, "export const entry = 'first';\n");
    const active = await indexProject(root);
    await saveProjectIndex(root, active);
    const activeManifest = await readFile(indexManifestPath(root), "utf8");
    await writeFile(sourcePath, "export const entry = 'second';\n");
    const abandoned = await indexProject(root);
    await writeFile(indexGenerationPath(root, abandoned.generation!.id), serialized(abandoned));

    await expect(loadProjectIndex(root)).resolves.toMatchObject({ generation: { id: active.generation!.id } });
    await expect(readFile(indexManifestPath(root), "utf8")).resolves.toBe(activeManifest);
  });

  it("loads schema-v4 and publishes the first full v5 generation without rewriting legacy evidence", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const current = await indexProject(root);
    const legacy = { ...current, schemaVersion: 4 } as typeof current;
    delete (legacy as typeof current & { generation?: unknown }).generation;
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const legacyContent = serialized(legacy);
    await writeFile(indexPath(root), legacyContent);

    const loaded = await loadProjectIndex(root);
    const rebuilt = await refreshProjectIndex(root, loaded, {});

    expect(loaded?.schemaVersion).toBe(4);
    expect(rebuilt).toMatchObject({ mode: "full", fallbackReason: expect.stringMatching(/schema metadata/i) });
    expect(rebuilt.index.schemaVersion).toBe(5);
    await expect(readFile(indexPath(root), "utf8")).resolves.toBe(legacyContent);
    await expect(loadProjectIndex(root)).resolves.toMatchObject({ schemaVersion: 5, generation: { id: rebuilt.index.generation!.id } });
  });

  it("never overwrites future-schema legacy evidence", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    const candidate = await indexProject(root);
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const future = `${JSON.stringify({ schemaVersion: 6, sentinel: "future" })}\n`;
    await writeFile(indexPath(root), future);

    await expect(saveProjectIndex(root, candidate)).rejects.toThrow(/newer.*refusing to overwrite/i);

    await expect(readFile(indexPath(root), "utf8")).resolves.toBe(future);
    await expect(access(indexManifestPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent promotions and leaves one complete manifest-selected generation", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "src", "entry.ts");
    await writeFile(sourcePath, "export const entry = 'first';\n");
    const first = await indexProject(root);
    await writeFile(sourcePath, "export const entry = 'second';\n");
    const second = await indexProject(root);

    await Promise.all([saveProjectIndex(root, first), saveProjectIndex(root, second)]);

    const active = await loadProjectIndex(root);
    expect([first.generation!.id, second.generation!.id]).toContain(active?.generation?.id);
    expect((await readManifest(root)).generationId).toBe(active?.generation?.id);
  });

  it("keeps an open old generation readable while a new manifest is published on Windows", async () => {
    const root = await makeRoot();
    const sourcePath = join(root, "src", "entry.ts");
    await writeFile(sourcePath, "export const entry = 'first';\n");
    const first = await indexProject(root);
    await saveProjectIndex(root, first);
    const reader = await open(indexGenerationPath(root, first.generation!.id), "r");
    try {
      await writeFile(sourcePath, "export const entry = 'second';\n");
      const second = await indexProject(root);
      await saveProjectIndex(root, second);

      expect(JSON.parse(await reader.readFile("utf8"))).toMatchObject({ generation: { id: first.generation!.id } });
      await expect(loadProjectIndex(root)).resolves.toMatchObject({ generation: { id: second.generation!.id } });
    } finally {
      await reader.close();
    }
  });

  it("refuses publication after the repository branch identity changes", async () => {
    const root = await makeRoot();
    await execFile("git", ["init", "-q", "-b", "main", root]);
    await execFile("git", ["-C", root, "config", "user.email", "generation@example.invalid"]);
    await execFile("git", ["-C", root, "config", "user.name", "Generation Fixture"]);
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n");
    await execFile("git", ["-C", root, "add", "."]);
    await execFile("git", ["-C", root, "commit", "-qm", "baseline"]);
    const active = await indexProject(root);
    await saveProjectIndex(root, active);
    const activeManifest = await readFile(indexManifestPath(root), "utf8");
    const candidate = await indexProject(root);
    await execFile("git", ["-C", root, "switch", "-q", "-c", "other"]);

    await expect(saveProjectIndex(root, candidate)).rejects.toThrow(/repository identity changed/i);

    await expect(readFile(indexManifestPath(root), "utf8")).resolves.toBe(activeManifest);
  });
});
