import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { runWithFileLock } from "../src/core/fileLockLease.js";
import { canonicalPersistenceLock } from "../src/core/lockDomain.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real native test runner contract", () => {
  it("loads the real current addon through the importer-scoped provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-contract-"));
    roots.push(root);
    const lock = await canonicalPersistenceLock(root, "workspace-state", "contract.json");
    await expect(runWithFileLock(lock, async () => "owned")).resolves.toBe("owned");
    await expect(access(lock.anchorPath)).resolves.toBeUndefined();
    await expect(access(lock.journalPath)).resolves.toBeUndefined();
    await expect(access(lock.compatibilityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the production provider zero-configuration and uniquely imported", async () => {
    const provider = await readFile(resolve("src/core/nativeLockProvider.ts"), "utf8");
    const lease = await readFile(resolve("src/core/fileLockLease.ts"), "utf8");
    expect(provider).toMatch(/loadNativeLockAddon\(\)/u);
    expect(provider).not.toMatch(/process\.env|TOKENGRAPH_TEST|setProvider|fallback/iu);
    expect(lease.match(/\.\/nativeLockProvider\.js/gu)).toHaveLength(1);
  });

  it("runs fixed preactivation before an activated contained harness", async () => {
    const runner = await readFile(resolve("scripts/run-tests.mjs"), "utf8");
    expect(runner).toMatch(/preactivation/iu);
    expect(runner).toMatch(/activated/iu);
    const main = runner.slice(runner.indexOf("async function main"));
    expect(main.indexOf('runContained("preactivation"')).toBeLessThan(main.indexOf("mkdtemp("));
    expect(runner).not.toMatch(/pnpm|\.cmd/iu);
  });

  it("specifies bounded whole-tree termination and no-follow control cleanup", async () => {
    const runner = await readFile(resolve("scripts/run-tests.mjs"), "utf8");
    expect(runner).toMatch(/SIGTERM/iu);
    expect(runner).toMatch(/SIGKILL/iu);
    expect(runner).toMatch(/kill\(-pid, 0\)/u);
    expect(runner).not.toMatch(/rm\(controlRoot,\s*\{\s*recursive:\s*true/iu);
    expect(runner).toMatch(/removeTreeNoFollow\(controlRoot\)/u);
    expect(runner).toMatch(/lstat\([^)]*statusPath/iu);
  });

  it("preserves evidence whenever POSIX or Windows containment cannot be proved", async () => {
    const runner = await readFile(resolve("scripts/run-tests.mjs"), "utf8");
    const posixTermination = runner.slice(
      runner.indexOf("async function terminatePosixProcessGroup"),
      runner.indexOf("export async function runContainedPosix")
    );
    const windowsContainment = runner.slice(
      runner.indexOf("async function runContainedWindows"),
      runner.indexOf("async function runContained(")
    );

    expect(posixTermination).toMatch(/ContainmentError/iu);
    expect(posixTermination).not.toMatch(/throw new Error\(/u);
    expect(windowsContainment).not.toMatch(/taskkill/iu);
    expect(windowsContainment).toMatch(/child\.kill\("SIGKILL"\)/u);
    expect(windowsContainment).toMatch(/supervisor exit (?:could not be proved|is unproven)/iu);
  });

  it("classifies an ambiguous POSIX post-exit probe as unproved containment", async () => {
    const runner = await readFile(resolve("scripts/run-tests.mjs"), "utf8");
    const posixRun = runner.slice(
      runner.indexOf("export async function runContainedPosix"),
      runner.indexOf("async function runContained(")
    );

    expect(posixRun).not.toMatch(/if \(processGroupAlive\(child\.pid\)\)/u);
    expect(posixRun).toMatch(/confirmPosixProcessGroupDrained\(child\.pid, label, evidenceRoot/iu);
    expect(runner).toMatch(/async function confirmPosixProcessGroupDrained[\s\S]*catch[\s\S]*terminatePosixProcessGroup[\s\S]*ContainmentError/iu);
  });

  it("behaviorally preserves the exact evidence root after an ambiguous POSIX post-exit probe", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "tokengraph-posix-containment-evidence-"));
    roots.push(evidenceRoot);
    const evidencePath = join(evidenceRoot, "evidence.txt");
    const childPath = join(evidenceRoot, "child.mjs");
    const childPidPath = join(evidenceRoot, "child.pid");
    await writeFile(evidencePath, "preserve-me\n");
    await writeFile(childPath, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const descendant = spawn(process.execPath, ["--input-type=module", "--eval", "setTimeout(() => process.exit(0), 30_000)"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      writeFileSync(process.argv[2], JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid }));
      descendant.unref();
    `);

    const helperUrl = pathToFileURL(resolve("scripts/run-tests.mjs")).href;
    const probe = `
      import { readFileSync } from "node:fs";
      import { rm } from "node:fs/promises";
      import { ContainmentError, runContainedPosix, runWithContainmentFailurePolicy } from ${JSON.stringify(helperUrl)};
      const [evidenceRoot, childPath, childPidPath] = process.argv.slice(1);
      let probes = 0;
      let cleanupCalls = 0;
      const signals = [];
      const processInfo = () => JSON.parse(readFileSync(childPidPath, "utf8"));
      const descendantAlive = () => {
        try {
          process.kill(processInfo().descendantPid, 0);
          return true;
        } catch (error) {
          if (error?.code === "ESRCH") return false;
          throw error;
        }
      };
      try {
        await runWithContainmentFailurePolicy(
          () => runContainedPosix("behavioral probe", [childPath, childPidPath], process.env, evidenceRoot, {
            timeoutMs: 5_000,
            terminationGraceMs: 2_000,
            probeProcessGroup: () => {
              probes += 1;
              if (probes === 1) throw Object.assign(new Error("injected non-ESRCH probe failure"), { code: "EPERM" });
              return descendantAlive();
            },
            signalProcessGroup: (_pid, signal) => {
              signals.push(signal);
              process.kill(processInfo().descendantPid, "SIGKILL");
            }
          }),
          async () => {
            cleanupCalls += 1;
            await rm(evidenceRoot, { recursive: true, force: true });
          }
        );
        process.stderr.write("TOKENGRAPH_TRACE " + JSON.stringify({ classification: "none", probes, cleanupCalls, signals, descendantAliveAfterHelper: descendantAlive() }) + "\\n");
        process.exitCode = 24;
      } catch (error) {
        const descendantAliveAfterHelper = descendantAlive();
        if (descendantAliveAfterHelper) process.kill(processInfo().descendantPid, "SIGKILL");
        process.stderr.write("TOKENGRAPH_TRACE " + JSON.stringify({
          classification: error instanceof ContainmentError ? "ContainmentError" : error?.constructor?.name,
          message: error instanceof Error ? error.message : String(error),
          probes,
          cleanupCalls,
          signals,
          descendantAliveAfterHelper
        }) + "\\n");
        process.exitCode = 23;
      }
    `;
    const result = await new Promise<{ code: number | string | undefined; stderr: string }>((resolveResult) => {
      execFile(process.execPath, ["--input-type=module", "--eval", probe, evidenceRoot, childPath, childPidPath], {
        cwd: process.cwd(),
        windowsHide: true
      }, (error, _stdout, stderr) => {
        resolveResult({ code: error?.code ?? undefined, stderr });
      });
    });
    const traceLine = result.stderr.split(/\r?\n/u).find((line) => line.startsWith("TOKENGRAPH_TRACE "));
    const trace = JSON.parse(traceLine?.slice("TOKENGRAPH_TRACE ".length) ?? "null") as {
      classification: string;
      message: string;
      probes: number;
      cleanupCalls: number;
      signals: string[];
      descendantAliveAfterHelper: boolean;
    } | null;

    expect(result.code).toBe(23);
    expect(trace).toMatchObject({
      classification: "ContainmentError",
      message: `behavioral probe POSIX post-exit process-group probe was ambiguous (injected non-ESRCH probe failure); evidence preserved at ${evidenceRoot}.`,
      cleanupCalls: 0,
      signals: ["SIGTERM"],
      descendantAliveAfterHelper: false
    });
    expect(trace?.probes).toBeGreaterThanOrEqual(4);
    await expect(readFile(evidencePath, "utf8")).resolves.toBe("preserve-me\n");

    const processInfo = JSON.parse(await readFile(childPidPath, "utf8")) as { rootPid: number; descendantPid: number };
    for (const pid of [processInfo.rootPid, processInfo.descendantPid]) {
      let processAlive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        processAlive = false;
      }
      expect(processAlive, `process ${pid}`).toBe(false);
    }
  });

  it("uses the exact versioned Windows request and status protocols", async () => {
    const runner = await readFile(resolve("scripts/run-tests.mjs"), "utf8");
    const supervisor = await readFile(resolve("scripts/run-process-tree-windows.ps1"), "utf8");
    for (const field of ["schemaVersion: 1", "exe:", "argv:", "cwd:", "env:", "timeoutMs", "statusPath"]) {
      expect(runner, field).toContain(field);
    }
    expect(runner).not.toMatch(/commandLine:/u);
    expect(supervisor).toMatch(/CREATE_NO_WINDOW/u);
    expect(supervisor).toMatch(/CREATE_UNICODE_ENVIRONMENT/u);
    expect(supervisor).toMatch(/AllocHGlobal|StringToHGlobalUni/u);
    expect(supervisor).toMatch(/FileMode\]::CreateNew|FileMode\.CreateNew/u);
    for (const field of ["schemaVersion", "state", "childPid", "exitCode", "forced", "activeProcesses", "errorCode"]) {
      expect(supervisor, field).toContain(field);
    }
  });

  it("retains the suspended process handle until pre-assignment exit is proved", async () => {
    const supervisor = await readFile(resolve("scripts/run-process-tree-windows.ps1"), "utf8");
    const recovery = supervisor.slice(
      supervisor.indexOf("} catch (Exception error)"),
      supervisor.indexOf("} finally {")
    );
    const termination = recovery.indexOf("TerminateProcess(pi.hProcess, 125)");
    const boundedWait = recovery.indexOf("WaitForSingleObject(pi.hProcess, 30000)");
    const terminationFailure = recovery.indexOf("TERMINATE_PROCESS_FAILED");

    expect(termination).toBeGreaterThanOrEqual(0);
    expect(boundedWait).toBeGreaterThan(termination);
    expect(terminationFailure).toBeGreaterThan(boundedWait);
  });

  it.runIf(process.platform === "win32")("round-trips empty arguments and Unicode through the Job Object supervisor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-windows-runner-contract-"));
    roots.push(root);
    const childPath = join(root, "child.mjs");
    const outputPath = join(root, "output.json");
    const statusPath = join(root, "status.json");
    const specPath = join(root, "spec.json");
    await writeFile(childPath, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), value: process.env.TOKENGRAPH_UNICODE_ROUNDTRIP }));\n");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 1,
      exe: process.execPath,
      argv: [childPath, outputPath, "", "space value", 'quote"value', "trail\\", "λ"],
      cwd: root,
      env: { ...process.env, TOKENGRAPH_UNICODE_ROUNDTRIP: "zăpadă" },
      timeoutMs: 30_000,
      statusPath
    }));

    const result = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      resolve("scripts/run-process-tree-windows.ps1"), "-Spec", specPath
    ], { cwd: process.cwd(), windowsHide: true });
    expect(result.stderr).toBe("");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      argv: ["", "space value", 'quote"value', "trail\\", "λ"],
      value: "zăpadă"
    });
    const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual([
      "activeProcesses", "childPid", "errorCode", "exitCode", "forced", "schemaVersion", "state"
    ]);
    expect(status).toEqual({
      schemaVersion: 1,
      state: "completed",
      childPid: expect.any(Number),
      exitCode: 0,
      forced: false,
      activeProcesses: 0,
      errorCode: null
    });
  }, 45_000);

  it("routes every real production-bundle launcher through the external runtime", async () => {
    const consumers = ["cli-runner.test.ts", "hooks.test.ts", "mcp-smoke.test.ts", "cli-smoke.test.ts"];
    for (const consumer of consumers) {
      const source = await readFile(resolve("tests", consumer), "utf8");
      expect(source, consumer).toMatch(/\.\/support\/externalRuntime\.js/u);
    }
    const smoke = await readFile(resolve("tests/cli-smoke.test.ts"), "utf8");
    expect(smoke).toMatch(/"--",\s*"--root",\s*root,\s*"--server",\s*externalServerEntry/iu);
    const smokeRunner = await readFile(resolve("scripts/smoke.mjs"), "utf8");
    expect(smokeRunner).not.toMatch(/setTimeout\(resolveClose/iu);
    expect(smokeRunner).toMatch(/Timed out waiting for the MCP server process to exit/iu);
  });

  it("binds test-provider paths to an exact identity-recorded harness", async () => {
    const provider = await readFile(resolve("tests/support/nativeLockProvider.ts"), "utf8");
    const activation = await readFile(resolve("tests/support/activateNativeLockRuntime.ts"), "utf8");
    const external = await readFile(resolve("tests/support/externalRuntime.ts"), "utf8");
    for (const source of [provider, activation, external]) {
      expect(source).toMatch(/TOKENGRAPH_TEST_HARNESS_MANIFEST/u);
      expect(source).toMatch(/lstat/iu);
      expect(source).not.toMatch(/\baccess\(/u);
    }
    expect(provider).not.toMatch(/split\(\/\[\\\\\/\]/u);
  });
});
