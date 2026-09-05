import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_GRAPH_CONFIG } from "../src/core/config.js";
import { collectDoctorReport } from "../src/core/doctor.js";
import { saveProjectIndex } from "../src/core/persistence.js";
import { indexProject } from "../src/core/projectIndexer.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tg-doctor-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TokenGraph doctor", () => {
  it("reports a missing index without creating workspace state", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "entry.ts"), "export const healthy = true;\n");

    const report = await collectDoctorReport({
      workspace: { status: "ready", source: "cli-root", root },
      pluginRoot: process.cwd(),
      now: new Date("2026-09-02T00:00:00.000Z")
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "degraded",
      workspace: { status: "ready", source: "cli-root" },
      stateAccess: "safe",
      versions: { agreement: "match" },
      lifecycle: { attestation: "unavailable" },
      parser: { runtime: "web-tree-sitter@0.26.11" },
      leases: { active: 0, stale: 0, malformed: 0, unavailableDomains: [] },
      ledgers: { open: 0, paused: 0, completed: 0, orphanCandidates: 0, malformed: 0 },
      storage: { configState: "default", writePolicy: "balanced", recentWrites: { available: false } },
      index: { presence: "missing", state: "missing" },
      recommendations: ["index-missing"]
    });
    expect(report.parser.grammars).toHaveLength(4);
    expect(report.parser.grammars.every((grammar) => grammar.present && (grammar.bytes ?? 0) > 0 && /^[a-f0-9]{64}$/.test(grammar.sha256 ?? ""))).toBe(true);
    await expect(stat(join(root, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns blocked trust diagnostics without reading a workspace", async () => {
    const report = await collectDoctorReport({
      workspace: { status: "blocked", source: "codex-request-metadata", blockingReason: "missing-trusted-workspace" },
      pluginRoot: process.cwd(),
      attestation: "missing"
    });

    expect(report).toMatchObject({
      status: "blocked",
      workspace: { status: "blocked", source: "codex-request-metadata", blockingReason: "missing-trusted-workspace" },
      stateAccess: "blocked",
      lifecycle: { attestation: "missing" },
      recommendations: ["missing-trusted-workspace"]
    });
  });

  it("reports a fresh manifest generation and detects later content drift", async () => {
    const root = await makeRoot();
    await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(join(root, ".git"), { recursive: true })]);
    const source = join(root, "src", "entry.ts");
    await writeFile(source, "export const version = 1;\n");
    await saveProjectIndex(root, await indexProject(root));

    const fresh = await collectDoctorReport({ workspace: { status: "ready", source: "cli-root", root }, pluginRoot: process.cwd() });
    expect(fresh.index).toMatchObject({ presence: "present", state: "fresh", schemaVersion: 5, rootValid: true, identityValid: true, metadataContentConsistent: true });

    await writeFile(source, "export const version = 2;\n");
    const stale = await collectDoctorReport({ workspace: { status: "ready", source: "cli-root", root }, pluginRoot: process.cwd() });
    expect(stale.index).toMatchObject({ presence: "present", state: "stale", metadataContentConsistent: false });
    expect(stale.recommendations).toContain("index-inconsistent");
  });

  it("blocks a state junction rather than traversing outside the trusted workspace", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.json"), JSON.stringify({ secret: "must-not-be-read" }));
    await symlink(outside, join(root, ".tokengraph"), process.platform === "win32" ? "junction" : "dir");

    const report = await collectDoctorReport({ workspace: { status: "ready", source: "cli-root", root }, pluginRoot: process.cwd() });

    expect(report).toMatchObject({ status: "blocked", stateAccess: "blocked", recommendations: ["state-boundary-violation"] });
  });

  it("blocks junctions at each diagnostic state surface", async () => {
    const cases = ["tasks", "repository", "telemetry"];
    for (const statePath of cases) {
      const root = await makeRoot();
      const outside = await makeRoot();
      await mkdir(join(root, ".tokengraph"), { recursive: true });
      await writeFile(join(outside, "sentinel.json"), JSON.stringify({ secret: statePath }));
      await symlink(outside, join(root, ".tokengraph", statePath), process.platform === "win32" ? "junction" : "dir");

      const report = await collectDoctorReport({ workspace: { status: "ready", source: "cli-root", root }, pluginRoot: process.cwd() });
      expect(report).toMatchObject({ status: "blocked", stateAccess: "blocked", recommendations: ["state-boundary-violation"] });
      await expect(readFile(join(outside, "sentinel.json"), "utf8")).resolves.toContain(statePath);
    }
  });

  it("reports stale and malformed leases, orphan ledgers, quota pressure, telemetry, missing parsers, and corrupt indexes without repair", async () => {
    const root = await makeRoot();
    const pluginRoot = await makeRoot();
    await Promise.all([
      mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true }),
      mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true }),
      mkdir(join(pluginRoot, "assets", "grammars"), { recursive: true }),
      mkdir(join(root, ".tokengraph", "config.json.lock"), { recursive: true }),
      mkdir(join(root, ".tokengraph", "repository", "memory.json.lock"), { recursive: true }),
      mkdir(join(root, ".tokengraph", "tasks"), { recursive: true }),
      mkdir(join(root, ".tokengraph", "telemetry"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(pluginRoot, "package.json"), JSON.stringify({ version: "1.0.0" })),
      writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ version: "2.0.0" })),
      writeFile(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" })),
      writeFile(join(root, ".tokengraph", "config.json"), JSON.stringify({
        schemaVersion: 4,
        config: { ...DEFAULT_TOKEN_GRAPH_CONFIG, storage: { ...DEFAULT_TOKEN_GRAPH_CONFIG.storage, writePolicy: "minimal", maxBytes: 1, runsMaxBytes: 1, cacheMaxBytes: 1, vaultMaxBytes: 1, durableMaxBytes: 1 } }
      })),
      writeFile(join(root, ".tokengraph", ".index-manifest.json"), "{not json"),
      writeFile(join(root, ".tokengraph", "config.json.lock", "lease.json"), JSON.stringify({ schemaVersion: 1, pid: 999999, nonce: "11111111-1111-4111-8111-111111111111", startedAt: "2026-09-01T00:00:00.000Z", heartbeatAt: "2026-09-01T00:00:00.000Z" })),
      writeFile(join(root, ".tokengraph", "repository", "memory.json.lock", "lease.json"), "not json"),
      writeFile(join(root, ".tokengraph", "tasks", "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({
        schemaId: "tokengraph-task-ledger",
        schemaVersion: 3,
        taskId: "00000000-0000-4000-8000-000000000000",
        host: "unknown",
        status: "open",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        estimatorVersion: "task-estimator-v2",
        deliveredArtifacts: [],
        outcomes: [],
        events: []
      })),
      writeFile(join(root, ".tokengraph", "tasks", "11111111-1111-4111-8111-111111111111.json"), "not json"),
      writeFile(join(root, ".tokengraph", "telemetry", "write-aggregates.json"), JSON.stringify({ schemaVersion: 1, days: [{ date: "2026-09-02", sampledPeakRssBytes: 7, classes: { durable: { operationCount: 2, logicalBytes: 12 }, cache: { operationCount: 1, logicalBytes: 3, physicalBytes: 5 } } }] })),
      writeFile(join(root, ".tokengraph", "pressure.bin"), "quota pressure")
    ]);
    const manifestBefore = await readFile(join(root, ".tokengraph", ".index-manifest.json"), "utf8");

    const report = await collectDoctorReport({
      workspace: { status: "ready", source: "cli-root", root },
      pluginRoot,
      now: new Date("2026-09-02T00:00:00.000Z")
    });

    expect(report.status).toBe("degraded");
    expect(report.versions.agreement).toBe("mismatch");
    expect(report.parser.grammars.every((grammar) => !grammar.present)).toBe(true);
    expect(report.leases).toMatchObject({ stale: 1, malformed: 1 });
    expect(report.ledgers).toMatchObject({ open: 1, orphanCandidates: 1, malformed: 1 });
    expect(report.storage).toMatchObject({ quotaPressure: true, writePolicy: "minimal", recentWrites: { operations: 3, logicalBytes: 15, physicalBytes: null, sampledPeakRssBytes: 7 } });
    expect(report.index).toMatchObject({ presence: "corrupt", state: "corrupt" });
    expect(report.recommendations).toEqual(expect.arrayContaining(["version-mismatch", "parser-assets-missing", "stale-lease", "malformed-lease", "orphan-ledger", "malformed-ledger", "storage-quota-pressure", "index-corrupt"]));
    await expect(readFile(join(root, ".tokengraph", ".index-manifest.json"), "utf8")).resolves.toBe(manifestBefore);
  });

  it("compares source manifests with the generated release and packaged manifests without inventing a release sibling", async () => {
    const sandbox = await makeRoot();
    const source = join(sandbox, "plugins", "tokengraph");
    const release = join(sandbox, "release", "tokengraph");
    for (const root of [source, release]) {
      await Promise.all([mkdir(join(root, ".codex-plugin"), { recursive: true }), mkdir(join(root, ".claude-plugin"), { recursive: true })]);
      await Promise.all([
        writeFile(join(root, "package.json"), JSON.stringify({ version: "0.23.1" })),
        writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ version: "0.23.1" })),
        writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.23.1" }))
      ]);
    }
    await mkdir(join(source, "src"));
    await writeFile(join(release, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.23.2" }));

    const sourceReport = await collectDoctorReport({ workspace: { status: "ready", source: "test", root: sandbox }, pluginRoot: source });
    const packagedReport = await collectDoctorReport({ workspace: { status: "blocked", source: "test", blockingReason: "no-workspace" }, pluginRoot: release });

    expect(sourceReport.versions).toMatchObject({ generatedRelease: { package: "0.23.1", codexManifest: "0.23.1", claudeManifest: "0.23.2" }, agreement: "mismatch" });
    expect(packagedReport.versions).toMatchObject({ generatedRelease: null, package: "0.23.1", codexManifest: "0.23.1", claudeManifest: "0.23.2", agreement: "mismatch" });
  });

  it("degrades deterministically when installed version metadata is unavailable", async () => {
    const root = await makeRoot();
    const pluginRoot = await makeRoot();
    const report = await collectDoctorReport({ workspace: { status: "ready", source: "test", root }, pluginRoot });
    expect(report.versions.agreement).toBe("unavailable");
    expect(report.recommendations).toEqual(expect.arrayContaining(["version-unavailable", "parser-assets-missing", "index-missing"]));
  });
});
