import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadTokenGraphConfig, saveTokenGraphConfig } from "../src/core/config.js";
import { loadRoutingControl, saveRoutingControl } from "../src/core/routingControl.js";
import { repositoryMemoryPath, repositoryRulesPath, saveProjectIndex } from "../src/core/persistence.js";
import { CURRENT_INDEX_SCHEMA_VERSION, indexProject } from "../src/core/projectIndexer.js";
import type { ProjectIndex } from "../src/core/types.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-audit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("audit remediation persistence contracts", () => {
  it("keeps repository knowledge outside the worktree state directory", async () => {
    const root = await makeRoot();
    expect(await repositoryMemoryPath(root)).toBe(join(root, ".tokengraph", "repository", "memory.json"));
    expect(await repositoryRulesPath(root)).toBe(join(root, ".tokengraph", "repository", "rules.json"));
  });

  it("migrates legacy worktree knowledge without losing its bytes", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const legacy = JSON.stringify({ schemaVersion: 1, memories: [{ id: "mem-1" }] });
    await writeFile(join(root, ".tokengraph", "memory.json"), legacy);
    const migrated = await repositoryMemoryPath(root);
    expect(await readFile(migrated, "utf8")).toBe(legacy);
  });

  it("does not overwrite a newer index schema", async () => {
    const root = await makeRoot();
    const newer = { schemaVersion: CURRENT_INDEX_SCHEMA_VERSION + 1 } as ProjectIndex;
    await expect(saveProjectIndex(root, newer)).rejects.toThrow(/refusing to overwrite/i);
  });

  it("exposes unsupported-language counts in the index contract", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "legacy.rb"), "puts 'ignored'\n");
    const index = await indexProject(root);
    expect(index.unsupportedLanguageCounts).toMatchObject({ ".rb": 1 });
  });

  it("keeps the routing environment override ephemeral", async () => {
    const root = await makeRoot();
    const previous = process.env.TOKENGRAPH_ROUTING_MODE;
    try {
      await saveTokenGraphConfig(root, { ...(await loadTokenGraphConfig(root)), routingMode: "always-advisory", routing: { mode: "always-advisory", killSwitch: false } });
      process.env.TOKENGRAPH_ROUTING_MODE = "always-activate";
      expect((await loadTokenGraphConfig(root)).routingMode).toBe("always-activate");
      delete process.env.TOKENGRAPH_ROUTING_MODE;
      expect((await loadTokenGraphConfig(root)).routingMode).toBe("always-advisory");
    } finally {
      if (previous === undefined) delete process.env.TOKENGRAPH_ROUTING_MODE;
      else process.env.TOKENGRAPH_ROUTING_MODE = previous;
    }
  });

  it("does not trust a malformed promotion report", async () => {
    const root = await makeRoot();
    await saveRoutingControl(root, {
      schemaVersion: 1,
      killSwitch: false,
      promotion: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        enforcementEnabled: true,
        gates: { forgedGate: true },
        categoryCounts: {}
      }
    });
    expect((await loadRoutingControl(root)).promotion).toBeUndefined();
  });

  it("retains atomic JSON files with a parseable schema envelope", async () => {
    const root = await makeRoot();
    const config = await loadTokenGraphConfig(root);
    const persisted = JSON.parse(await readFile(join(root, ".tokengraph", "config.json"), "utf8")) as { schemaVersion?: number; config?: unknown };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.config).toEqual(expect.objectContaining({ routingMode: config.routingMode }));
    await writeFile(join(root, ".tokengraph", "config.json"), JSON.stringify({ schemaVersion: 99, config }));
    await expect(loadTokenGraphConfig(root)).rejects.toThrow(/newer.*schema/i);
  });
});
