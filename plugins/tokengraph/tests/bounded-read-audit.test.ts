import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const injection = vi.hoisted(() => ({
  beforeLstat: undefined as ((path: string) => Promise<void>) | undefined,
  failSyncFor: undefined as string | undefined
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
      if (injection.beforeLstat) await injection.beforeLstat(String(path));
      return actual.lstat(path as never, options as never) as never;
    },
    open: async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      const handle = await (actual.open as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof actual.open>>>)(path, ...rest);
      const marker = injection.failSyncFor;
      if (marker === undefined || !String(path).includes(marker)) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "sync") return async () => { throw new Error("injected-sync-failure"); };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      });
    }
  };
});

const { attestHostWorkspace, loadHostWorkspaceAttestation } = await import("../src/core/hostWorkspace.js");
const { createTaskLedger, inspectTaskLedgerReadOnly } = await import("../src/core/taskLedger.js");

const roots: string[] = [];
const attestations: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function hostAttestationPath(pluginRoot: string, sessionId: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const pluginHash = createHash("sha256").update(await realpath(pluginRoot)).digest("hex");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const path = join(await realpath(tmpdir()), "tokengraph-host-workspaces", pluginHash, `${sessionHash}.json`);
  attestations.push(path);
  return path;
}

function ledgerPath(root: string, taskId: string): string {
  return join(root, ".tokengraph", "tasks", `${taskId}.json`);
}

afterEach(async () => {
  injection.beforeLstat = undefined;
  injection.failSyncFor = undefined;
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...attestations.splice(0).map((path) => rm(path, { force: true }))
  ]);
});

describe("bounded read classification", () => {
  it("reports a task ledger unlinked after the bounded read began as unstable, not missing", async () => {
    const root = await makeRoot("tokengraph-audit-ledger-root-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    const path = ledgerPath(root, ledger.taskId);

    await expect(inspectTaskLedgerReadOnly(root, ledger.taskId)).resolves.toMatchObject({ status: "valid" });
    await expect(inspectTaskLedgerReadOnly(root, randomUUID())).resolves.toEqual({ status: "missing" });

    let seen = 0;
    injection.beforeLstat = async (candidate) => {
      if (candidate !== path) return;
      seen += 1;
      if (seen === 2) await rm(path, { force: true });
    };
    const inspected = await inspectTaskLedgerReadOnly(root, ledger.taskId);
    injection.beforeLstat = undefined;
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(inspected).toEqual({ status: "unstable" });
  });

  it("reports a host attestation unlinked after the bounded read began as unstable, not missing", async () => {
    const pluginRoot = await makeRoot("tokengraph-audit-plugin-");
    const workspace = await makeRoot("tokengraph-audit-workspace-");
    const sessionId = `audit-${randomUUID()}`;
    const path = await hostAttestationPath(pluginRoot, sessionId);

    await attestHostWorkspace(pluginRoot, sessionId, workspace);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({
      status: "valid", root: await realpath(workspace)
    });
    await expect(loadHostWorkspaceAttestation(pluginRoot, `absent-${randomUUID()}`)).resolves.toEqual({ status: "missing" });

    let seen = 0;
    injection.beforeLstat = async (candidate) => {
      if (candidate !== path) return;
      seen += 1;
      if (seen === 2) await rm(path, { force: true });
    };
    const loaded = await loadHostWorkspaceAttestation(pluginRoot, sessionId);
    injection.beforeLstat = undefined;
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(loaded).toEqual({ status: "unstable" });
  });

  it("rejects a quarantined ledger that carries inconsistent disposition evidence", async () => {
    const root = await makeRoot("tokengraph-audit-quarantine-root-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    const path = ledgerPath(root, ledger.taskId);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    const report = {
      taskId: ledger.taskId,
      eventCount: 0,
      estimate: { range: { low: 0, likely: 0, high: 0, unit: "estimated_tokens" }, confidence: "low", basis: ["forged"], overhead: 0, estimatorVersion: stored.estimatorVersion },
      categories: [],
      quality: { status: "not_evaluated", checks: [] }
    };
    await writeFile(path, `${JSON.stringify({
      ...stored, status: "quarantined", lastDisposition: "complete", completedReport: report
    }, null, 2)}\n`);
    await expect(inspectTaskLedgerReadOnly(root, ledger.taskId)).resolves.toEqual({ status: "invalid" });

    await writeFile(path, `${JSON.stringify({ ...stored, status: "quarantined" }, null, 2)}\n`);
    await expect(inspectTaskLedgerReadOnly(root, ledger.taskId)).resolves.toMatchObject({ status: "valid" });
  });

  it("removes an exclusively created host temporary when the durability flush fails", async () => {
    const pluginRoot = await makeRoot("tokengraph-audit-temp-plugin-");
    const workspace = await makeRoot("tokengraph-audit-temp-workspace-");
    const sessionId = `audit-temp-${randomUUID()}`;
    const path = await hostAttestationPath(pluginRoot, sessionId);
    const directory = join(path, "..");

    injection.failSyncFor = ".tg-host-";
    await expect(attestHostWorkspace(pluginRoot, sessionId, workspace)).rejects.toThrow();
    injection.failSyncFor = undefined;
    expect((await readdir(directory)).filter((name) => name.startsWith(".tg-host-"))).toEqual([]);

    await attestHostWorkspace(pluginRoot, sessionId, workspace);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({
      status: "valid", root: await realpath(workspace)
    });
  });

  it("classifies a same-binding attestation whose stored root vanished as detached and refreshes it", async () => {
    const pluginRoot = await makeRoot("tokengraph-audit-detached-plugin-");
    const workspace = await makeRoot("tokengraph-audit-detached-workspace-");
    const sessionId = `audit-detached-${randomUUID()}`;
    await hostAttestationPath(pluginRoot, sessionId);

    await attestHostWorkspace(pluginRoot, sessionId, workspace);
    await rm(workspace, { recursive: true, force: true });
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "detached" });

    const replacement = await makeRoot("tokengraph-audit-detached-next-");
    await attestHostWorkspace(pluginRoot, sessionId, replacement);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({
      status: "valid", root: await realpath(replacement)
    });
  });

  it("keeps a foreign-binding attestation mismatched and unrefreshable", async () => {
    const pluginRoot = await makeRoot("tokengraph-audit-binding-plugin-");
    const workspace = await makeRoot("tokengraph-audit-binding-workspace-");
    const sessionId = `audit-binding-${randomUUID()}`;
    const path = await hostAttestationPath(pluginRoot, sessionId);

    await attestHostWorkspace(pluginRoot, sessionId, workspace);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...stored, sessionHash: "0".repeat(64) })}\n`);
    const foreign = await readFile(path, "utf8");
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "mismatched" });
    await expect(attestHostWorkspace(pluginRoot, sessionId, workspace)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(foreign);
  });
});
