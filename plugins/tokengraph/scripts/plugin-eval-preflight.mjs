import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(await readFile(join(pluginRoot, ".plugin-eval/host-preflight.v1.json"), "utf8"));
const seedConfig = `[plugins."${pins.pluginId}"]\nenabled = true\n`;
const prefix = "tokengraph-host-preflight-v1-";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const absent = async (path) => {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
};

function fail(reason) {
  const error = new Error(reason);
  error.preflightReason = reason;
  throw error;
}

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--plugin-eval-root", "--codex-bin", "--target", "--auth-file"].includes(key) ||
        !argv[index + 1] || argv[index + 1].startsWith("--") || values[key]) fail("invalid-arguments");
    values[key] = resolve(argv[index + 1]);
  }
  if (!values["--plugin-eval-root"] || !values["--codex-bin"]) fail("missing-tool-paths");
  return {
    evalRoot: values["--plugin-eval-root"], codexBin: values["--codex-bin"],
    targetRoot: values["--target"] ?? resolve(pluginRoot, "../../release/tokengraph"),
    authFile: values["--auth-file"]
  };
}

function environment(root, seedHome) {
  const env = {};
  // Do not inherit API tokens, CLI overrides, hooks, plugin state or caller HOME.
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, HOME: seedHome, USERPROFILE: seedHome, CODEX_HOME: seedHome,
    PLUGIN_EVAL_CODEX_HOME_SOURCE: seedHome,
    TMPDIR: join(root, "temp"), TEMP: join(root, "temp"), TMP: join(root, "temp")
  };
}

function command(bin, args, cwd, env) {
  const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.error || result.signal || result.status !== 0) fail("read-only-command-failed");
  // Raw stderr/configuration are private. Reports contain only bounded gate facts.
  return result.stdout;
}

function requireInside(root, path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("invalid-provisioner-path");
  const fromRoot = relative(root, path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail("invalid-provisioner-path");
}

async function main() {
  const report = {
    kind: pins.kind, schemaVersion: pins.schemaVersion, harnessVersion: pins.harnessVersion,
    pins: { pluginEval: pins.pluginEvalVersion, codexCli: pins.codexCliVersion },
    pluginId: pins.pluginId,
    gates: {
      catalogResolution: { status: "unverified" },
      configuredEnablement: { status: "unverified" },
      hostRegistration: { status: "unverified", reason: "catalog-list-is-not-runtime-registration" },
      sessionStartHookReview: { status: "unverified" },
      sameThreadWorkspaceAttestation: { status: "unverified" }
    },
    cleanup: { verified: false }, readyForLiveScenario: false
  };
  let root;
  let rootIdentity;
  let physicalTemp;
  let state;
  let failed = false;
  try {
    const options = parse(process.argv.slice(2));
    const manifest = JSON.parse(await readFile(join(options.evalRoot, ".codex-plugin/plugin.json"), "utf8"));
    const provisioner = await readFile(join(options.evalRoot, "src/core/benchmark-workspace.js"), "utf8");
    if (manifest.name !== "plugin-eval" || manifest.version !== pins.pluginEvalVersion ||
        hash(provisioner.replaceAll("\r\n", "\n")) !== pins.provisionerSha256) fail("plugin-eval-pin-mismatch");
    const target = JSON.parse(await readFile(join(options.targetRoot, ".codex-plugin/plugin.json"), "utf8"));
    if (target.name !== "tokengraph") fail("wrong-target-plugin");
    physicalTemp = await realpath(tmpdir());
    root = await mkdtemp(join(physicalTemp, prefix));
    rootIdentity = await lstat(root);
    await chmod(root, 0o700);
    const seedHome = join(root, "seed");
    for (const child of ["seed", "input", "temp"]) await mkdir(join(root, child), { mode: 0o700 });
    await writeFile(join(seedHome, "config.toml"), seedConfig, { flag: "wx", mode: 0o600 });
    if (options.authFile) {
      // POSIX modes do not establish Windows ACL privacy. Catalog checks need
      // no credentials, so v1 refuses this copy instead of assuming TEMP is private.
      if (process.platform === "win32") fail("authentication-not-supported-on-windows");
      const info = await lstat(options.authFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) fail("unsafe-auth-file");
      await writeFile(join(seedHome, "auth.json"), await readFile(options.authFile), { flag: "wx", mode: 0o600 });
    }
    const env = environment(root, seedHome);
    const version = command(options.codexBin, ["--version"], seedHome, env).trim();
    if (version !== `codex-cli ${pins.codexCliVersion}`) fail("codex-cli-pin-mismatch");
    const statePath = join(root, "provisioned.json");
    command(process.execPath, [join(pluginRoot, "scripts/plugin-eval-provision-worker.mjs"), options.evalRoot,
      options.targetRoot, join(root, "input"), statePath], seedHome, env);
    state = JSON.parse(await readFile(statePath, "utf8"));
    for (const key of ["workspacePath", "homePath", "codexHomePath"]) requireInside(root, state[key]);
    const copiedConfigPath = join(state.codexHomePath, "config.toml");
    if (await readFile(copiedConfigPath, "utf8") !== seedConfig) fail("seed-config-not-preserved");
    report.gates.catalogResolution = { status: "fail" };
    const catalog = JSON.parse(await readFile(join(state.workspacePath, ".agents/plugins/marketplace.json"), "utf8"));
    const entry = catalog.plugins?.find((plugin) => plugin.name === "tokengraph");
    if (catalog.name !== pins.marketplaceName || entry?.source?.source !== "local" ||
        entry.source.path !== "./plugins/tokengraph") fail("unexpected-provisioned-catalog");
    // Supply the root to CLI 0.159.2 explicitly. This is a process-only config
    // override, not marketplace add/upgrade, plugin install, or hook approval.
    const listing = JSON.parse(command(options.codexBin, [
      "-c", `marketplaces.${pins.marketplaceName}.source_type="local"`,
      "-c", `marketplaces.${pins.marketplaceName}.source=${JSON.stringify(state.workspacePath)}`,
      "plugin", "list", "--marketplace", pins.marketplaceName, "--available", "--json"
    ], state.workspacePath, { ...env, HOME: state.homePath, USERPROFILE: state.homePath, CODEX_HOME: state.codexHomePath }));
    const matches = [...(listing.installed ?? []), ...(listing.available ?? [])].filter((plugin) => plugin.pluginId === pins.pluginId);
    if (matches.length !== 1) fail("catalog-target-not-resolved");
    report.gates.catalogResolution = { status: "pass" };
    const configured = matches[0];
    report.gates.configuredEnablement = { status: configured.enabled === true ? "pass" : "fail" };
    if (configured.enabled !== true) fail("benchmark-plugin-not-enabled");
    if (configured.installed !== false || !await absent(join(state.codexHomePath, "plugins/cache"))) fail("unexpected-plugin-installation");
    if (await readFile(copiedConfigPath, "utf8") !== seedConfig) fail("configuration-mutated-by-listing");
    report.noPluginInstalled = true;
  } catch (error) {
    failed = true;
    report.failure = error.preflightReason ?? "preflight-failed";
  } finally {
    if (root) {
      try {
        const current = await lstat(root);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev ||
            current.ino !== rootIdentity.ino || current.birthtimeMs !== rootIdentity.birthtimeMs ||
            await realpath(root) !== root || dirname(root) !== physicalTemp || !basename(root).startsWith(prefix)) fail("cleanup-root-identity-changed");
        await rm(root, { recursive: true, force: false });
        report.cleanup = {
          verified: await absent(root), seedHomeRemoved: await absent(join(root, "seed")),
          provisionedHomeRemoved: !state || await absent(state.codexHomePath)
        };
        if (!report.cleanup.verified) fail("cleanup-not-verified");
      } catch {
        failed = true;
        report.cleanup = { verified: false };
        report.failure = "cleanup-not-verified";
      }
    } else {
      report.cleanup = { verified: true, noDisposableHomeCreated: true };
    }
  }
  console.log(JSON.stringify(report));
  process.exitCode = failed ? 1 : 0;
}

await main();
