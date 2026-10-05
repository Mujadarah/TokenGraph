import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const evalRoot = process.env.TOKENGRAPH_PLUGIN_EVAL_ROOT;
const codexBin = process.env.TOKENGRAPH_CODEX_BIN;
const temporaryRoots: string[] = [];
const scriptPath = resolve(process.cwd(), "scripts/plugin-eval-preflight.mjs");
const preflightRoots = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("tokengraph-host-preflight-v1-")).sort();

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-preflight-test-"));
  temporaryRoots.push(root);
  for (const child of ["seed", "input", "temp", "target/.codex-plugin"]) {
    await mkdir(join(root, child), { recursive: true });
  }
  await writeFile(join(root, "target/.codex-plugin/plugin.json"), JSON.stringify({ name: "tokengraph", version: "0.25.0" }));
  await writeFile(join(root, "seed/config.toml"), [
    '[marketplaces.unrelated]',
    'source_type = "git"',
    'source = "https://example.invalid/unrelated.git"',
    '[plugins."tokengraph@tokengraph"]',
    'enabled = true',
    '[hooks.state."caller-hook"]',
    'trusted = true',
    ''
  ].join("\n"));
  return root;
}

function provisionInherited(root: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.argv[1];
    const { provisionBenchmarkWorkspace } = await import(pathToFileURL(path.join(process.argv[2], 'src/core/benchmark-workspace.js')));
    const p = await provisionBenchmarkWorkspace({
      target: { kind: 'plugin', name: 'tokengraph', path: path.join(root, 'target') },
      config: { workspace: { sourcePath: path.join(root, 'input'), setupMode: 'copy' }, targetProvisioning: { mode: 'workspace-plugin-marketplace' } },
      scenarioId: 'host-preflight-test'
    });
    console.log(JSON.stringify(p));
  `, root, evalRoot!], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_EVAL_CODEX_HOME_SOURCE: join(root, "seed"), TMPDIR: join(root, "temp"), TEMP: join(root, "temp"), TMP: join(root, "temp") }
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { workspacePath: string; homePath: string; codexHomePath: string };
}

function preflight(root: string, extra: string[] = [], tool = codexBin!) {
  const result = spawnSync(process.execPath, [scriptPath, "--plugin-eval-root", evalRoot!, "--codex-bin", tool,
    "--target", join(root, "target"), ...extra], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_EVAL_CODEX_HOME_SOURCE: join(root, "seed"), PRIVATE_TEST_TOKEN: "not-a-real-secret" }
  });
  return { ...result, report: JSON.parse(result.stdout || "{}") };
}

describe("versioned host preflight static contract", () => {
  it("pins the reviewed provisioner and keeps invalid arguments privacy safe", async () => {
    const pins = JSON.parse(await readFile(resolve(process.cwd(), ".plugin-eval/host-preflight.v1.json"), "utf8"));
    expect(pins).toMatchObject({ schemaVersion: 1, harnessVersion: 1, pluginEvalVersion: "0.1.2", codexCliVersion: "0.159.2", pluginId: "tokengraph@plugin-eval-benchmark" });
    expect(pins.provisionerSha256).toMatch(/^[0-9a-f]{64}$/);
    const result = spawnSync(process.execPath, [scriptPath, "--unexpected-private-argument", "not-a-real-secret"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: "invalid-arguments", cleanup: { verified: true, noDisposableHomeCreated: true }, readyForLiveScenario: false });
    expect(result.stdout + result.stderr).not.toContain("not-a-real-secret");
  });
});

describe.skipIf(!evalRoot || !codexBin)("Plugin Eval 0.1.2 host preflight regressions", () => {
  it("loads the catalog without absent inherited Git snapshots", async () => {
    const before = await preflightRoots();
    const root = await fixture();
    const p = provisionInherited(root);
    const loaded = spawnSync(codexBin!, ["plugin", "marketplace", "list"], {
      cwd: p.workspacePath,
      encoding: "utf8",
      env: { ...process.env, HOME: p.homePath, USERPROFILE: p.homePath, CODEX_HOME: p.codexHomePath }
    });
    const diagnostic = loaded.stderr.replaceAll(root, "<DISPOSABLE_ROOT>").replaceAll(tmpdir().replaceAll("\\", "\\\\"), "<SYSTEM_TEMP>");
    expect(loaded.status).toBe(1);
    expect(diagnostic).toContain("marketplace root does not contain a supported manifest");
    const corrected = preflight(root);
    expect(corrected.status, corrected.stdout).toBe(0);
    expect(corrected.report.gates.catalogResolution).toEqual({ status: "pass" });
    expect(corrected.report.noPluginInstalled).toBe(true);
    expect(corrected.report.cleanup).toEqual({ verified: true, seedHomeRemoved: true, provisionedHomeRemoved: true });
    expect(await preflightRoots()).toEqual(before);
  });

  it("enables the exact provisioned marketplace identity", async () => {
    const root = await fixture();
    const p = provisionInherited(root);
    const catalog = JSON.parse(await readFile(join(p.workspacePath, ".agents/plugins/marketplace.json"), "utf8"));
    const config = await readFile(join(p.codexHomePath, "config.toml"), "utf8");
    expect(catalog.name).toBe("plugin-eval-benchmark");
    expect(config).toContain('[plugins."tokengraph@tokengraph"]');
    expect(config).not.toContain('[plugins."tokengraph@plugin-eval-benchmark"]');
    const corrected = preflight(root);
    expect(corrected.status, corrected.stdout).toBe(0);
    expect(corrected.report.gates.configuredEnablement).toEqual({ status: "pass" });
    expect(corrected.report.gates.hostRegistration).toMatchObject({ status: "unverified" });
    expect(corrected.report.gates.sessionStartHookReview).toEqual({ status: "unverified" });
    expect(corrected.report.gates.sameThreadWorkspaceAttestation).toEqual({ status: "unverified" });
    expect(corrected.report.readyForLiveScenario).toBe(false);
    expect(corrected.stdout).not.toMatch(/caller-hook|unrelated|PRIVATE_TEST_TOKEN|not-a-real-secret/);
    expect(await readFile(join(root, "seed/config.toml"), "utf8")).toBe(config);
  });

  it("keeps unattempted gates unverified when the target identity is wrong", async () => {
    const before = await preflightRoots();
    const root = await fixture();
    await writeFile(join(root, "target/.codex-plugin/plugin.json"), JSON.stringify({ name: "unrelated", version: "0.25.0" }));
    const result = preflight(root);
    expect(result.status).toBe(1);
    expect(result.report.failure).toBe("wrong-target-plugin");
    expect(result.report.gates.catalogResolution).toEqual({ status: "unverified" });
    expect(result.report.gates.configuredEnablement).toEqual({ status: "unverified" });
    expect(result.report.cleanup.verified).toBe(true);
    expect(await preflightRoots()).toEqual(before);
  });

  it.skipIf(process.platform !== "win32")("rejects Windows auth copies without a verified private ACL", async () => {
    const before = await preflightRoots();
    const root = await fixture();
    const authPath = join(root, "private-auth.json");
    const auth = '{"access_token":"not-a-real-secret"}';
    await writeFile(authPath, auth);
    const result = preflight(root, ["--auth-file", authPath]);
    expect(result.status).toBe(1);
    expect(result.report.failure).toBe("authentication-not-supported-on-windows");
    expect(result.report.cleanup.verified).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("not-a-real-secret");
    expect(await readFile(authPath, "utf8")).toBe(auth);
    expect(await preflightRoots()).toEqual(before);
  });

  it("cleans up CLI pin failure, including POSIX authentication copies", async () => {
    const before = await preflightRoots();
    const root = await fixture();
    const authPath = join(root, "private-auth.json");
    const auth = JSON.stringify({ tokens: { access_token: "not-a-real-secret" } });
    await writeFile(authPath, auth);
    const result = preflight(root, process.platform === "win32" ? [] : ["--auth-file", authPath], process.execPath);
    expect(result.status).toBe(1);
    expect(result.report.failure).toBe("codex-cli-pin-mismatch");
    expect(result.report.cleanup).toMatchObject({ verified: true, seedHomeRemoved: true, provisionedHomeRemoved: true });
    expect(result.stdout + result.stderr).not.toContain("not-a-real-secret");
    expect(await readFile(authPath, "utf8")).toBe(auth);
    expect(await preflightRoots()).toEqual(before);
  });

  it("cleans up worker import failure, including POSIX authentication copies", async () => {
    const before = await preflightRoots();
    const root = await fixture();
    const broken = join(root, "broken-eval");
    await mkdir(join(broken, ".codex-plugin"), { recursive: true });
    await mkdir(join(broken, "src/core"), { recursive: true });
    await writeFile(join(broken, ".codex-plugin/plugin.json"), await readFile(join(evalRoot!, ".codex-plugin/plugin.json")));
    await writeFile(join(broken, "src/core/benchmark-workspace.js"), await readFile(join(evalRoot!, "src/core/benchmark-workspace.js")));
    const authPath = join(root, "private-auth.json");
    await writeFile(authPath, '{"access_token":"not-a-real-secret"}');
    const result = spawnSync(process.execPath, [scriptPath, "--plugin-eval-root", broken, "--codex-bin", codexBin!, "--target", join(root, "target"),
      ...(process.platform === "win32" ? [] : ["--auth-file", authPath])], { encoding: "utf8" });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.failure).toBe("read-only-command-failed");
    expect(report.cleanup.verified).toBe(true);
    expect(report.gates.hostRegistration.status).toBe("unverified");
    expect(result.stdout + result.stderr).not.toContain("not-a-real-secret");
    await expect(access(authPath)).resolves.toBeUndefined();
    expect(await preflightRoots()).toEqual(before);
  });
});
