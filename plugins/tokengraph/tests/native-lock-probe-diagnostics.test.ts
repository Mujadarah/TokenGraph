import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it } from "vitest";
import { captureProbeDiagnostic, waitForProbeExists, waitForProbeStatus, type ProbeDiagnosticContext } from "./support/nativeLockProbeDiagnostics.js";
import { canonicalPersistenceLock } from "../src/core/lockDomain.js";

const children = new Set<ChildProcess>();
const roots: string[] = [];

async function fixture(exitCode?: number): Promise<ProbeDiagnosticContext> {
  const root = await mkdtemp(join(tmpdir(), "tg-probe-diagnostic-"));
  roots.push(root);
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["-e", exitCode === undefined ? "setInterval(() => {}, 1000)" : `process.exit(${exitCode})`], { windowsHide: true, stdio: "pipe" });
  children.add(child);
  if (exitCode !== undefined) await new Promise<void>((done, reject) => { child.once("exit", () => done()); child.once("error", reject); });
  return {
    child, startedAt, request: {
      workspaceRoot: root, coordinationRoot: root, operation: "try", domain: "workspace-state",
      key: "config.json", timeoutMs: 15_000, pauseAt: "after-journal-sync",
      pauseState: "pending-lease-create", pauseOccurrence: 1
    }, records: () => [], stderr: () => "", cut: { index: 39, stage: "recovery" }
  };
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("Diagnostic fixture did not exit.")), 5_000);
        child.once("exit", () => { clearTimeout(timer); done(); });
      });
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
    }
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("distinguishes a live child missing the expected status without terminating it", async () => {
  const context = await fixture();
  const error = await waitForProbeStatus([], "paused", 20, context).catch((value: unknown) => value);
  expect((error as Error).message).toContain('"lifecycle":"live"');
  expect((error as Error).message).toContain('"exitCode":null');
  expect((error as Error).message).toContain('"watchdog":"not-observed"');
  expect((error as Error).message).toMatch(/"elapsedMs":\d+/u);
  expect(context.child.exitCode).toBeNull();
  expect(context.child.signalCode).toBeNull();
});

it("identifies the already exited holder when a parent barrier wait expires", async () => {
  const context = await fixture(124);
  const error = await waitForProbeExists(join(context.request.workspaceRoot, "absent"), 20, () => [context]).catch((value: unknown) => value);
  expect((error as Error).message).toContain("Timed out waiting for native lock probe state.");
  expect((error as Error).message).toContain('"lifecycle":"exited"');
  expect((error as Error).message).toContain(`"pid":${context.child.pid}`);
  expect((error as Error).message).toContain('"request":{"operation":"try","domain":"workspace-state","key":"config.json"');
});

it("keeps successful status and file waits free of diagnostic reads", async () => {
  const context = await fixture(0);
  const accessed: string[] = [];
  context.records = () => { accessed.push("records"); throw new Error("Unexpected diagnostic read"); };
  await expect(waitForProbeStatus([{ status: "paused" }], "paused", 20, context)).resolves.toBeUndefined();
  await expect(waitForProbeExists(context.request.workspaceRoot, 20, () => { accessed.push("contexts"); return [context]; })).resolves.toBeUndefined();
  expect(accessed).toEqual([]);
  expect(await readdir(context.request.workspaceRoot)).toEqual([]);
});

it("summarizes journal and lease state read-only and omits private payloads and stderr", async () => {
  const context = await fixture(1);
  const lock = await canonicalPersistenceLock(context.request.workspaceRoot, "workspace-state", "config.json");
  await mkdir(lock.compatibilityPath, { recursive: true });
  const secret = "private-secret-project-data";
  const journal = JSON.stringify({ schemaVersion: 2, generation: 2, phase: "barrier-created", pid: 123,
    nonce: secret, relativeLegacyName: context.request.workspaceRoot, barrierIdentity: secret });
  const temporary = JSON.stringify({ schemaVersion: 2, generation: 3, phase: "barrier-created", pendingLeaseWrite: { operation: "create", temporaryIdentity: secret, payloadSha256: secret } });
  const lease = JSON.stringify({ schemaVersion: 1, pid: 456, nonce: secret });
  await writeFile(lock.journalPath, journal);
  await writeFile(`${lock.journalPath}.tokengraph-write-v2.tmp`, temporary);
  await writeFile(join(lock.compatibilityPath, "lease.json"), lease);
  context.stderr = () => `${context.request.workspaceRoot} ${secret}`;
  context.records = () => [{ status: "paused" }];
  const result = await captureProbeDiagnostic(context);
  expect(result).toMatchObject({ lifecycle: "exited", exitCode: 1, lastStatus: "paused", lastObservedPhase: "barrier-created",
    journal: { state: "observed", schemaVersion: 2, generation: 2, pid: 123, barrierIdentityRecorded: true },
    journalTemporary: { state: "observed", generation: 3, pendingLeaseWrite: "create", temporaryIdentityRecorded: true },
    lease: { state: "observed", schemaVersion: 1, pid: 456 }, leaseTemporary: { state: "missing" }, barrier: { state: "directory" },
    stderr: { bytes: Buffer.byteLength(context.stderr()), content: "omitted" } });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(context.request.workspaceRoot);
  expect(await readFile(lock.journalPath, "utf8")).toBe(journal);
  expect(await readFile(`${lock.journalPath}.tokengraph-write-v2.tmp`, "utf8")).toBe(temporary);
  expect(await readFile(join(lock.compatibilityPath, "lease.json"), "utf8")).toBe(lease);
});

it("reports malformed or oversized state without printing its content", async () => {
  const context = await fixture(1);
  const lock = await canonicalPersistenceLock(context.request.workspaceRoot, "workspace-state", "config.json");
  await mkdir(lock.domainRoot, { recursive: true });
  await writeFile(lock.journalPath, "private-invalid-json");
  await writeFile(`${lock.journalPath}.tokengraph-write-v2.tmp`, "x".repeat(8_193));
  const result = await captureProbeDiagnostic(context);
  expect(result).toMatchObject({ lastObservedPhase: "not-observed", journal: { state: "invalid-json" }, journalTemporary: { state: "oversized" } });
  expect(JSON.stringify(result)).not.toContain("private-invalid-json");
});

it("refuses hardlinked journal files and linked domain directories", async () => {
  const context = await fixture(1);
  const lock = await canonicalPersistenceLock(context.request.workspaceRoot, "workspace-state", "config.json");
  await mkdir(lock.domainRoot, { recursive: true });
  const target = join(context.request.coordinationRoot, "private-target");
  await writeFile(target, JSON.stringify({ phase: "idle", generation: 0 }));
  await link(target, lock.journalPath);
  expect(await captureProbeDiagnostic(context)).toMatchObject({ journal: { state: "unsafe" } });
  await rm(lock.domainRoot, { recursive: true });
  const targetDirectory = join(context.request.workspaceRoot, "private-directory");
  await mkdir(targetDirectory);
  await writeFile(join(targetDirectory, ".tokengraph-native-journal-v2.lock"), JSON.stringify({ phase: "idle" }));
  await symlink(targetDirectory, lock.domainRoot, process.platform === "win32" ? "junction" : "dir");
  expect(await captureProbeDiagnostic(context)).toMatchObject({ journal: { state: "unsafe" } });
  expect(await readdir(targetDirectory)).toEqual([".tokengraph-native-journal-v2.lock"]);
});

it("redacts unexpected request and status labels", async () => {
  const context = await fixture(1);
  context.request.key = "private-project-name.json";
  context.request.pauseAt = "private-pause";
  context.records = () => [{ status: "private-status" }];
  const result = JSON.stringify(await captureProbeDiagnostic(context));
  expect(result).toContain('"key":"redacted"');
  expect(result).toContain('"pauseAt":"redacted"');
  expect(result).toContain('"lastStatus":"redacted"');
  expect(result).not.toContain("private-");
});

it("preserves the original timeout failure if diagnostic collection fails", async () => {
  const context = await fixture(124);
  context.records = () => { throw new Error("private-diagnostic-error"); };
  const error = await waitForProbeStatus([], "paused", 20, context).catch((value: unknown) => value);
  expect((error as Error).message).toBe("Timed out waiting for probe status paused. native-lock-probes=unavailable");
});

it("reports the exited child's request, cut, PID and watchdog exit at a parent status deadline", async () => {
  const context = await fixture(124);
  const error = await waitForProbeStatus([], "paused", 20, context).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('"pid":');
  expect((error as Error).message).toContain('"lifecycle":"exited"');
  expect((error as Error).message).toContain('"exitCode":124');
  expect((error as Error).message).toContain('"watchdog":"exit-124"');
  expect((error as Error).message).toContain('"cut":{"index":39,"stage":"recovery"}');
  expect((error as Error).message).toContain('"lastObservedPhase":"not-observed"');
  expect((error as Error).message).toContain('"journal":{"state":"missing"}');
});
