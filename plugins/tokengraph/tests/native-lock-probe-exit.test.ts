import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { legacyWorkerFailureMessage, type ProbeDiagnosticContext } from "./support/nativeLockProbeDiagnostics.js";
import { finishProbeExitDiagnostic, waitForProbeExit } from "./support/nativeLockProbeExit.js";

// Only asynchronous diagnostic I/O is replaced, to hold it behind a deterministic
// barrier. The wait, event delivery, SIGKILL and child exit are real harness code.
const diagnostic = vi.hoisted(() => ({ capture: vi.fn<() => Promise<object>>() }));
vi.mock("./support/nativeLockProbeDiagnostics.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./support/nativeLockProbeDiagnostics.js")>();
  return {
    ...original,
    captureProbeDiagnostic: () => diagnostic.capture(),
    probeFailure: async (message: string) => {
      await diagnostic.capture();
      return new Error(`${message} native-lock-probes=[]`);
    }
  };
});

const children = new Set<ChildProcess>();
const completions: Promise<unknown>[] = [];
let releaseDiagnostic: () => void;

beforeEach(() => {
  const blocked = new Promise<object>((done) => {
    releaseDiagnostic = () => done({ journal: { state: "missing" }, lastObservedPhase: "not-observed" });
  });
  diagnostic.capture.mockReset().mockImplementation(() => blocked);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

async function fixture(script = "setInterval(() => {}, 1000)"): Promise<ProbeDiagnosticContext & { child: ChildProcess }> {
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: "pipe" });
  children.add(child);
  await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
  return { child, startedAt, request: {
    workspaceRoot: process.cwd(), coordinationRoot: process.cwd(), operation: "try",
    domain: "workspace-state", key: "config.json", timeoutMs: 15_000
  }, records: () => [{ status: "acquired" }], stderr: () => "private-stderr", cut: { index: 39, stage: "recovery" } };
}

function contain(context: ProbeDiagnosticContext & { child: ChildProcess }, timeoutMs: number, diagnosticContext = true): {
  completion: Promise<unknown>; failure: () => unknown;
} {
  let failure: unknown;
  const completion = (async () => {
    try {
      await waitForProbeExit(context.child, timeoutMs, diagnosticContext ? context : undefined);
    } catch (error) { failure = error; }
    finally {
      if (context.child.exitCode === null && context.child.signalCode === null) {
        const exited = waitForProbeExit(context.child, 5_000);
        expect(context.child.kill("SIGKILL")).toBe(true);
        await exited;
      }
      await finishProbeExitDiagnostic(failure);
    }
    return failure;
  })();
  completions.push(completion);
  return { completion, failure: () => failure };
}

afterEach(async () => {
  releaseDiagnostic();
  vi.useRealTimers();
  await Promise.all(completions.splice(0));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForProbeExit(child, 5_000);
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
    }
  }
  children.clear();
});

it("starts deadline rejection and termination while diagnostic capture is blocked", async () => {
  const context = await fixture();
  const run = contain(context, 20);
  await vi.advanceTimersByTimeAsync(20);
  expect(context.child.killed).toBe(true);
  expect(run.failure()).toBeInstanceOf(Error);
  expect((run.failure() as Error).message).toContain("did not exit before its deadline");
  expect(diagnostic.capture).toHaveBeenCalledOnce();
  releaseDiagnostic();
  const error = await run.completion;
  expect((error as Error).message).toContain('"journal":{"state":"missing"}');
  expect((error as Error).message).toContain('"lifecycle":"live"');
});

it("starts child-error rejection and termination while diagnostic capture is blocked", async () => {
  const context = await fixture();
  const run = contain(context, 1_000);
  context.child.emit("error", Object.assign(new Error("private-child-message"), { code: "EACCES" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(context.child.killed).toBe(true);
  expect(run.failure()).toBeInstanceOf(Error);
  expect((run.failure() as Error).message).toContain("child wait failed");
  expect(diagnostic.capture).toHaveBeenCalledOnce();
  releaseDiagnostic();
  await run.completion;
});

it("preserves an allowlisted child error code without its raw message or path", async () => {
  const context = await fixture();
  const run = contain(context, 1_000);
  const raw = "private-child-message /private/workspace/file";
  context.child.emit("error", Object.assign(new Error(raw), { code: "EACCES" }));
  releaseDiagnostic();
  const error = await run.completion as NodeJS.ErrnoException;
  expect(error.code).toBe("EACCES");
  expect(error.message).toContain("EACCES");
  expect(error.message).not.toContain(raw);
  expect(error.message).not.toContain(context.request.workspaceRoot);
});

it("redacts child errors without a diagnostic context", async () => {
  const context = await fixture();
  const run = contain(context, 1_000, false);
  const raw = "private-child-message /private/workspace/file";
  context.child.emit("error", Object.assign(new Error(raw), { code: "private-code" }));
  const error = await run.completion as NodeJS.ErrnoException;
  expect(error.message).not.toContain(raw);
  expect(error.message).not.toContain("private-code");
  expect(error.code).toBe("unclassified");
});

it("keeps the legacy-worker exit assertion strict while omitting raw stderr", () => {
  const stderr = "private-worker-stderr /private/workspace/file";
  let error: unknown;
  try { expect(1, legacyWorkerFailureMessage(stderr)).toBe(0); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(stderr);
  expect((error as Error).message).toContain(`"bytes":${Buffer.byteLength(stderr)}`);
});

it("keeps a successful child exit free of diagnostic capture", async () => {
  const context = await fixture("process.exit(0)");
  await expect(waitForProbeExit(context.child, 1_000, context)).resolves.toBe(0);
  expect(diagnostic.capture).not.toHaveBeenCalled();
});
