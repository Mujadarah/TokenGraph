#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { TARGETS } from "./generate-native-lock-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(root, "node_modules", "vitest", "vitest.mjs");
const timeoutMs = 15 * 60_000;
const harnessPrefix = "tokengraph-native-test-v2-";
const controlPrefix = "tokengraph-job-control-v2-";
const terminationGraceMs = 5_000;
const windowsSupervisorGraceMs = 60_000;
const maxStatusBytes = 4_096;

export class ContainmentError extends Error {}

function parse(argv) {
  let mode = "full";
  if (argv[0] === "--preactivation-only") { mode = "preactivation"; argv = argv.slice(1); }
  else if (argv[0] === "--activated-only") { mode = "activated"; argv = argv.slice(1); }
  if (argv[0] === "--") argv = argv.slice(1);
  if (mode === "preactivation" && argv.length > 0) throw new Error("The preactivation suite is fixed and cannot be filtered.");
  return { mode, forwarded: argv };
}

function identityOf(stats) {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

async function requireAbsentNoFollow(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} unexpectedly exists.`);
}

async function waitForChild(child, durationMs) {
  return await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { cleanup(); resolveExit(undefined); }, durationMs);
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); resolveExit(code ?? 1); };
    const cleanup = () => { clearTimeout(timer); child.off("error", onError); child.off("exit", onExit); };
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      resolveExit(child.exitCode ?? 1);
    }
  });
}

async function validateOwnedFile(path, expectedIdentity, maximumBytes, label) {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size <= 0n || stats.size > BigInt(maximumBytes) || identityOf(stats) !== expectedIdentity) {
    throw new Error(`${label} identity is invalid.`);
  }
}

async function readExactWindowsStatus(controlRoot, controlIdentity, statusPath) {
  const beforeRoot = await lstat(controlRoot, { bigint: true });
  if (!beforeRoot.isDirectory() || beforeRoot.isSymbolicLink() || identityOf(beforeRoot) !== controlIdentity || await realpath(controlRoot) !== controlRoot) {
    throw new Error("Windows control directory identity changed.");
  }
  const before = await lstat(statusPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maxStatusBytes)) {
    throw new Error("Windows containment status file is unsafe.");
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(statusPath, flags);
  let text;
  try {
    const opened = await handle.stat({ bigint: true });
    if (identityOf(opened) !== identityOf(before)) throw new Error("Windows containment status identity changed before read.");
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(statusPath, { bigint: true });
  if (identityOf(after) !== identityOf(before)) throw new Error("Windows containment status identity changed after read.");
  const status = JSON.parse(text);
  const keys = Object.keys(status).sort();
  const expectedKeys = ["activeProcesses", "childPid", "errorCode", "exitCode", "forced", "schemaVersion", "state"];
  if (keys.join("\0") !== expectedKeys.join("\0") || status.schemaVersion !== 1 ||
      !Number.isInteger(status.childPid) || status.childPid <= 0 ||
      !(status.exitCode === null || Number.isInteger(status.exitCode)) || typeof status.forced !== "boolean" ||
      !(status.activeProcesses === null || Number.isInteger(status.activeProcesses)) ||
      !(status.errorCode === null || (typeof status.errorCode === "string" && status.errorCode.length > 0 && status.errorCode.length <= 128)) ||
      !["completed", "forced-failure"].includes(status.state)) {
    throw new Error("Windows containment status schema is invalid.");
  }
  if (status.state === "completed" && (status.forced || !Number.isInteger(status.exitCode) || status.activeProcesses !== 0 || status.errorCode !== null)) {
    throw new Error("Windows containment completion status is contradictory.");
  }
  if (status.state === "forced-failure" && !status.forced) throw new Error("Windows forced-failure status is contradictory.");
  const afterRoot = await lstat(controlRoot, { bigint: true });
  if (identityOf(afterRoot) !== controlIdentity || await realpath(controlRoot) !== controlRoot) throw new Error("Windows control directory identity changed after status read.");
  return status;
}

async function runContainedWindows(label, args, environment, evidenceRoot) {
  for (const [name, value] of Object.entries(environment)) {
    if (name.includes("\0") || (value !== undefined && String(value).includes("\0"))) throw new Error("Child environment contains NUL.");
  }
  for (const value of args) if (String(value).includes("\0")) throw new Error("Child argument contains NUL.");
  const controlRoot = await createControlRoot();
  const controlStats = await lstat(controlRoot, { bigint: true });
  const controlIdentity = identityOf(controlStats);
  const specPath = join(controlRoot, "spec.json");
  const statusPath = join(controlRoot, "status.json");
  const request = {
    schemaVersion: 1,
    exe: process.execPath,
    argv: args.map(String),
    cwd: root,
    env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])),
    timeoutMs,
    statusPath
  };
  await writeFile(specPath, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
  const specIdentity = identityOf(await lstat(specPath, { bigint: true }));
  await validateOwnedFile(specPath, specIdentity, 1024 * 1024, "Windows containment specification");
  await requireAbsentNoFollow(statusPath, "Windows containment status");
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(root, "scripts/run-process-tree-windows.ps1"), "-Spec", specPath], { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
  const code = await waitForChild(child, timeoutMs + windowsSupervisorGraceMs);
  if (code === undefined) {
    let terminationFailure;
    try {
      if (!child.kill("SIGKILL")) terminationFailure = new Error("direct supervisor termination was refused");
    } catch (error) {
      terminationFailure = error;
    }
    const forcedCode = await waitForChild(child, terminationGraceMs);
    if (forcedCode === undefined) {
      throw new ContainmentError(`${label} supervisor exit could not be proved after direct termination; evidence preserved at ${evidenceRoot ?? controlRoot}.`);
    }
    const detail = terminationFailure instanceof Error ? ` (${terminationFailure.message})` : "";
    throw new ContainmentError(`${label} supervisor required forced termination${detail}; evidence preserved at ${evidenceRoot ?? controlRoot}.`);
  }
  let status;
  try {
    status = await readExactWindowsStatus(controlRoot, controlIdentity, statusPath);
    await validateOwnedFile(specPath, specIdentity, 1024 * 1024, "Windows containment specification");
  } catch (error) {
    throw new ContainmentError(`${label} containment status failed (${error.message}); evidence preserved at ${evidenceRoot ?? controlRoot}.`);
  }
  if (status.state !== "completed") throw new ContainmentError(`${label} containment was forced (${status.errorCode ?? "unknown"}); evidence preserved at ${evidenceRoot ?? controlRoot}.`);
  const entries = (await readdir(controlRoot)).sort();
  if (entries.join("\0") !== ["spec.json", "status.json"].join("\0")) throw new ContainmentError(`${label} control layout changed; evidence preserved at ${evidenceRoot ?? controlRoot}.`);
  await removeTreeNoFollow(controlRoot);
  await requireAbsentNoFollow(controlRoot, "Windows control directory");
  return Number(status.exitCode);
}

function processGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

function createPosixRuntime(options) {
  return {
    probeProcessGroup: options.probeProcessGroup ?? processGroupAlive,
    signalProcessGroup: options.signalProcessGroup ?? ((pid, signal) => process.kill(-pid, signal)),
    now: options.now ?? (() => Date.now()),
    wait: options.wait ?? ((durationMs) => new Promise((resolveWait) => setTimeout(resolveWait, durationMs)))
  };
}

async function waitForProcessGroupExit(pid, durationMs, runtime) {
  const deadline = runtime.now() + durationMs;
  while (runtime.probeProcessGroup(pid) && runtime.now() < deadline) await runtime.wait(25);
  return !runtime.probeProcessGroup(pid);
}

async function terminatePosixProcessGroup(pid, label, evidenceRoot, graceMs, runtime) {
  let signalled = false;
  try {
    if (runtime.probeProcessGroup(pid)) {
      runtime.signalProcessGroup(pid, "SIGTERM");
      signalled = true;
    }
    if (!(await waitForProcessGroupExit(pid, graceMs, runtime))) {
      runtime.signalProcessGroup(pid, "SIGKILL");
      signalled = true;
      if (!(await waitForProcessGroupExit(pid, graceMs, runtime))) {
        throw new ContainmentError(`${label} POSIX process group exit is unproven after SIGKILL; evidence preserved at ${evidenceRoot ?? "no harness"}.`);
      }
    }
    return signalled;
  } catch (error) {
    if (error instanceof ContainmentError) throw error;
    if (error?.code === "ESRCH") return signalled;
    throw new ContainmentError(`${label} POSIX process group termination is unproven (${error.message}); evidence preserved at ${evidenceRoot ?? "no harness"}.`);
  }
}

async function confirmPosixProcessGroupDrained(pid, label, evidenceRoot, graceMs, runtime) {
  let alive;
  try {
    alive = runtime.probeProcessGroup(pid);
  } catch (error) {
    await terminatePosixProcessGroup(pid, label, evidenceRoot, graceMs, runtime);
    throw new ContainmentError(`${label} POSIX post-exit process-group probe was ambiguous (${error.message}); evidence preserved at ${evidenceRoot ?? "no harness"}.`);
  }
  if (!alive) return;
  await terminatePosixProcessGroup(pid, label, evidenceRoot, graceMs, runtime);
  throw new ContainmentError(`${label} left descendant processes; evidence preserved at ${evidenceRoot ?? "no harness"}.`);
}

export async function runContainedPosix(label, args, environment, evidenceRoot, options = {}) {
  const runtime = createPosixRuntime(options);
  const graceMs = options.terminationGraceMs ?? terminationGraceMs;
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? root,
    env: environment,
    stdio: "inherit",
    detached: true
  });
  const code = await waitForChild(child, options.timeoutMs ?? timeoutMs);
  if (code === undefined) {
    await terminatePosixProcessGroup(child.pid, label, evidenceRoot, graceMs, runtime);
    throw new ContainmentError(`${label} timed out; evidence preserved at ${evidenceRoot ?? "no harness"}.`);
  }
  await confirmPosixProcessGroupDrained(child.pid, label, evidenceRoot, graceMs, runtime);
  return Number(code);
}

async function runContained(label, args, environment, evidenceRoot) {
  return process.platform === "win32"
    ? runContainedWindows(label, args, environment, evidenceRoot)
    : runContainedPosix(label, args, environment, evidenceRoot);
}

async function scanBundles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await scanBundles(path); continue; }
    if (!entry.isFile() || !/\.(?:c?js|mjs)$/u.test(entry.name)) continue;
    const source = await readFile(path, "utf8");
    if (/TOKENGRAPH_TEST_|tests[\\/]support|vitest\.activated/iu.test(source)) throw new Error("Test provider marker entered a production bundle.");
  }
}

async function treeHashes(directory, excludedTopLevel = new Set()) {
  const result = new Map();
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!prefix && excludedTopLevel.has(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      const stats = await lstat(path, { bigint: true });
      if (stats.isSymbolicLink()) throw new Error("The native test runtime contains a linked entry.");
      if (stats.isDirectory()) {
        result.set(`${relativePath}/`, "directory");
        await walk(path, relativePath);
        if (identityOf(await lstat(path, { bigint: true })) !== identityOf(stats)) throw new Error("The native test runtime directory identity changed.");
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1n) throw new Error("The native test runtime contains an unsafe file.");
      const handle = await open(path, constants.O_RDONLY);
      let bytes;
      try {
        if (identityOf(await handle.stat({ bigint: true })) !== identityOf(stats)) throw new Error("The native test runtime file identity changed before read.");
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (identityOf(await lstat(path, { bigint: true })) !== identityOf(stats)) throw new Error("The native test runtime file identity changed after read.");
      result.set(relativePath, `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  await walk(directory, "");
  return result;
}

function equalTree(left, right) {
  return left.size === right.size && [...left].every(([path, hash]) => right.get(path) === hash);
}

function serializeTree(tree) {
  return Object.fromEntries([...tree].sort(([left], [right]) => left.localeCompare(right)));
}

function currentTarget() {
  const match = TARGETS.find((target) => target.platform === process.platform && target.arch === process.arch);
  if (!match) throw new Error("The current platform is not supported by the native test harness.");
  if (process.platform === "linux") {
    const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
    const values = typeof glibc === "string" ? glibc.split(".").map(Number) : [];
    if (values.length < 2 || values[0] < 2 || (values[0] === 2 && values[1] < 28)) throw new Error("The native test harness requires glibc 2.28 or newer.");
  }
  return match;
}

async function readCurrentAssetOverride(target) {
  const configured = process.env.TOKENGRAPH_NATIVE_CURRENT_ASSET;
  if (configured === undefined) return undefined;
  if (typeof configured !== "string" || configured.length === 0 || configured.includes("\0") || !isAbsolute(configured)) {
    throw new Error("The current-target native asset override must be an absolute path.");
  }
  const path = resolve(configured);
  const allowed = new Set([
    resolve(root, "native-output", target.id, target.file),
    resolve(root, "assets/native-lock", target.id, target.file)
  ]);
  if (!allowed.has(path)) throw new Error("The current-target native asset override is outside the exact build or source-asset path.");
  for (const directory of [dirname(path), dirname(dirname(path))]) {
    const stats = await lstat(directory, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) {
      throw new Error("The current-target native asset override has an unsafe directory.");
    }
  }
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > 64n * 1024n * 1024n ||
      resolve(await realpath(path)) !== path) {
    throw new Error("The current-target native asset override is not a safe regular file.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    if (identityOf(await handle.stat({ bigint: true })) !== identityOf(before)) {
      throw new Error("The current-target native asset override identity changed before read.");
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (identityOf(await lstat(path, { bigint: true })) !== identityOf(before)) {
    throw new Error("The current-target native asset override identity changed after read.");
  }
  return bytes;
}

async function assembleHarness(harnessRoot, target) {
  const buildRoot = join(harnessRoot, "build");
  const runtimeRoot = join(harnessRoot, "runtime");
  const assetRoot = join(harnessRoot, "assets");
  const stagingRoot = join(harnessRoot, "staging");
  for (const path of [buildRoot, runtimeRoot, assetRoot, stagingRoot]) await mkdir(path, { mode: 0o700 });
  const childIdentities = Object.fromEntries(await Promise.all(
    Object.entries({ build: buildRoot, runtime: runtimeRoot, assets: assetRoot, staging: stagingRoot }).map(async ([name, path]) => {
      const stats = await lstat(path, { bigint: true });
      return [name, { path, identity: identityOf(stats) }];
    })
  ));
  const childEnv = { ...process.env, TEMP: stagingRoot, TMP: stagingRoot, TMPDIR: stagingRoot };
  if (process.platform === "win32" && !childEnv.CARGO) {
    const installedCargo = join(homedir(), ".cargo", "bin", "cargo.exe");
    await access(installedCargo);
    childEnv.CARGO = installedCargo;
  }
  if (await runContained("build", [resolve(root, "scripts/build.mjs")], childEnv, harnessRoot) !== 0) throw new Error("Fresh production build failed.");
  await scanBundles(join(root, "dist"));
  const nativePath = join(buildRoot, target.id, target.file);
  const currentAssetOverride = await readCurrentAssetOverride(target);
  let nativeBytes;
  if (currentAssetOverride === undefined) {
    if (await runContained("native build", [resolve(root, "scripts/build-native-lock-addon.mjs"), "--target", target.rustTarget, "--out", buildRoot], childEnv, harnessRoot) !== 0) throw new Error("Current-target native build failed.");
    nativeBytes = await readFile(nativePath);
  } else {
    await mkdir(dirname(nativePath), { mode: 0o700 });
    await writeFile(nativePath, currentAssetOverride, { flag: "wx", mode: 0o600 });
    nativeBytes = currentAssetOverride;
  }
  const manifest = {
    schemaVersion: 1, addonAbiVersion: 1, nodeApiVersion: 9, rustToolchain: "1.97.1",
    artifacts: TARGETS.map((entry) => ({ ...entry, path: `${entry.id}/${entry.file}`, bytes: entry.id === target.id ? nativeBytes.length : 1, sha256: entry.id === target.id ? createHash("sha256").update(nativeBytes).digest("hex") : "0".repeat(64) }))
  };
  await cp(join(root, "dist"), join(runtimeRoot, "dist"), { recursive: true, force: false, errorOnExist: true });
  await cp(join(root, "package.json"), join(runtimeRoot, "package.json"), { force: false, errorOnExist: true });
  await mkdir(join(runtimeRoot, "assets"), { recursive: true });
  for (const entry of await readdir(join(root, "assets"), { withFileTypes: true })) {
    if (entry.name === "native-lock") continue;
    if (entry.isSymbolicLink()) throw new Error("Source assets contain a linked top-level entry.");
    await cp(join(root, "assets", entry.name), join(runtimeRoot, "assets", entry.name), {
      recursive: entry.isDirectory(), force: false, errorOnExist: true
    });
  }
  await mkdir(join(assetRoot, target.id), { recursive: true });
  await cp(nativePath, join(assetRoot, target.id, target.file), { force: false, errorOnExist: true });
  await writeFile(join(assetRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await cp(assetRoot, join(runtimeRoot, "assets", "native-lock"), { recursive: true, force: false, errorOnExist: true });
  await scanBundles(join(runtimeRoot, "dist"));
  const sourceDistTree = await treeHashes(join(root, "dist"));
  const runtimeDistTree = await treeHashes(join(runtimeRoot, "dist"));
  const sourceAssetsTree = await treeHashes(join(root, "assets"), new Set(["native-lock"]));
  const runtimeSourceAssetsTree = await treeHashes(join(runtimeRoot, "assets"), new Set(["native-lock"]));
  if (!equalTree(sourceDistTree, runtimeDistTree)) throw new Error("Mirrored dist bytes differ from the fresh production build.");
  if (!equalTree(sourceAssetsTree, runtimeSourceAssetsTree)) throw new Error("Mirrored source asset bytes differ.");
  if (!(await readFile(join(root, "package.json"))).equals(await readFile(join(runtimeRoot, "package.json")))) throw new Error("Mirrored package metadata differs.");
  const harnessManifestPath = join(buildRoot, "harness-state.json");
  const harnessStats = await lstat(harnessRoot, { bigint: true });
  const harnessState = {
    schemaVersion: 1,
    root: { path: harnessRoot, identity: identityOf(harnessStats) },
    children: childIdentities,
    trees: {
      runtime: serializeTree(await treeHashes(runtimeRoot)),
      assets: serializeTree(await treeHashes(assetRoot))
    }
  };
  await writeFile(harnessManifestPath, `${JSON.stringify(harnessState)}\n`, { flag: "wx", mode: 0o600 });
  return { runtimeRoot, assetRoot, stagingRoot, harnessManifestPath, childEnv };
}

async function removeTreeNoFollow(path) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error("Harness cleanup refuses a linked entry.");
  if (stats.isDirectory()) {
    for (const entry of await readdir(path)) await removeTreeNoFollow(join(path, entry));
    await rmdir(path);
    return;
  }
  if (!stats.isFile()) throw new Error("Harness cleanup refuses a non-file entry.");
  await unlink(path);
}

async function removeOwnedHarness(path, identity) {
  const stats = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  const physicalTemporaryDirectory = await realpath(tmpdir());
  const fromTemp = relative(physicalTemporaryDirectory, path);
  if (canonical !== path || !stats.isDirectory() || stats.isSymbolicLink() || `${stats.dev}:${stats.ino}:${stats.birthtimeNs}` !== identity || fromTemp.includes(sep) || !basename(path).startsWith(harnessPrefix)) throw new Error(`Harness cleanup identity failed; evidence preserved at ${path}.`);
  const entries = (await readdir(path)).sort();
  if (entries.join("\0") !== ["assets", "build", "runtime", "staging"].join("\0")) throw new Error(`Harness cleanup layout failed; evidence preserved at ${path}.`);
  await removeTreeNoFollow(path);
  await requireAbsentNoFollow(path, "Harness root");
}

async function createPhysicalTemporaryRoot(prefix) {
  return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

export async function createControlRoot() {
  return await createPhysicalTemporaryRoot(controlPrefix);
}

export async function createHarnessRoot() {
  return await createPhysicalTemporaryRoot(harnessPrefix);
}

export async function runWithContainmentFailurePolicy(operation, cleanupOnOrdinaryFailure) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ContainmentError)) await cleanupOnOrdinaryFailure();
    throw error;
  }
}

async function main() {
  const { mode, forwarded } = parse(process.argv.slice(2));
  const baseEnv = { ...process.env };
  if (mode !== "activated") {
    const code = await runContained("preactivation", [vitest, "run", "--config", resolve(root, "vitest.preactivation.config.ts")], baseEnv);
    if (code !== 0) process.exit(code);
    if (mode === "preactivation") return;
  }
  const harnessRoot = await createHarnessRoot();
  const initial = await lstat(harnessRoot, { bigint: true });
  const identity = identityOf(initial);
  await runWithContainmentFailurePolicy(async () => {
    const harness = await assembleHarness(harnessRoot, currentTarget());
    const environment = {
      ...harness.childEnv,
      TOKENGRAPH_TEST_HARNESS_MANIFEST: harness.harnessManifestPath,
      TOKENGRAPH_TEST_RUNTIME_ROOT: harness.runtimeRoot,
      TOKENGRAPH_TEST_NATIVE_ASSETS: harness.assetRoot,
      TOKENGRAPH_TEST_NATIVE_STAGING: harness.stagingRoot
    };
    const code = await runContained("activated tests", [vitest, "run", "--config", resolve(root, "vitest.activated.config.ts"), ...forwarded], environment, harnessRoot);
    await removeOwnedHarness(harnessRoot, identity);
    if (code !== 0) process.exit(code);
  }, async () => { await removeOwnedHarness(harnessRoot, identity).catch(() => undefined); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
