#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(pluginRoot, "native", "lock-addon", "Cargo.toml");

export const TARGETS = Object.freeze([
  { id: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", rustTarget: "aarch64-apple-darwin", file: "tokengraph-lock.darwin-arm64.node", osFloor: "macos-11.0" },
  { id: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", rustTarget: "x86_64-apple-darwin", file: "tokengraph-lock.darwin-x64.node", osFloor: "macos-11.0" },
  { id: "linux-arm64-gnu", platform: "linux", arch: "arm64", libc: "glibc", rustTarget: "aarch64-unknown-linux-gnu", file: "tokengraph-lock.linux-arm64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "linux-x64-gnu", platform: "linux", arch: "x64", libc: "glibc", rustTarget: "x86_64-unknown-linux-gnu", file: "tokengraph-lock.linux-x64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "win32-arm64", platform: "win32", arch: "arm64", libc: "none", rustTarget: "aarch64-pc-windows-msvc", file: "tokengraph-lock.win32-arm64.node", osFloor: "windows-10" },
  { id: "win32-x64", platform: "win32", arch: "x64", libc: "none", rustTarget: "x86_64-pc-windows-msvc", file: "tokengraph-lock.win32-x64.node", osFloor: "windows-10-server-2016" }
].map((target) => Object.freeze(target)));

export const APPROVED_LICENSE_EXPRESSIONS = Object.freeze([
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "MIT",
  "MIT OR Apache-2.0",
  "Apache-2.0 OR MIT",
  "ISC",
  "Unlicense OR MIT",
  "(MIT OR Apache-2.0) AND Unicode-3.0",
  "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT"
]);

const approvedLicenses = new Set(APPROVED_LICENSE_EXPRESSIONS);
const outputNames = new Set(["manifest.json", "THIRD_PARTY_NOTICES.txt"]);

function usage() {
  return "Usage: node scripts/generate-native-lock-manifest.mjs --assets <directory>";
}

function requireOptionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.\n${usage()}`);
  return value;
}

export function parseManifestArguments(argv) {
  let assets;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--assets") {
      if (assets !== undefined) throw new Error("--assets may only be provided once.");
      assets = resolve(requireOptionValue(argv, ++index, "--assets"));
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    throw new Error(`Unknown argument: ${argument}\n${usage()}`);
  }
  if (assets === undefined) throw new Error(`--assets is required.\n${usage()}`);
  return { assetsDir: assets };
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function packageSource(packageEntry, rootPackageId) {
  if (packageEntry.source === null && packageEntry.id === rootPackageId) return "workspace";
  if (packageEntry.source !== "registry+https://github.com/rust-lang/crates.io-index") {
    throw new Error("Native dependency source policy rejected an unreviewed source.");
  }
  return "registry+https://github.com/rust-lang/crates.io-index";
}

function resolvedPackages(metadata) {
  const root = assertPlainObject(metadata, "Cargo metadata");
  if (!Array.isArray(root.packages) || root.resolve === null || typeof root.resolve !== "object" || !Array.isArray(root.resolve.nodes)) {
    throw new Error("Cargo metadata does not contain a complete resolved dependency graph.");
  }
  const packagesById = new Map();
  for (const packageEntry of root.packages) {
    assertPlainObject(packageEntry, "Cargo package metadata");
    if (typeof packageEntry.id !== "string" || packagesById.has(packageEntry.id)) {
      throw new Error("Cargo metadata contains a missing or duplicate package id.");
    }
    packagesById.set(packageEntry.id, packageEntry);
  }
  const nodesById = new Map();
  for (const node of root.resolve.nodes) {
    assertPlainObject(node, "Cargo resolve node");
    if (typeof node.id !== "string" || !Array.isArray(node.dependencies) || nodesById.has(node.id)) {
      throw new Error("Cargo metadata contains a malformed resolved dependency node.");
    }
    if (!node.dependencies.every((dependency) => typeof dependency === "string")) {
      throw new Error("Cargo metadata contains a malformed dependency id.");
    }
    nodesById.set(node.id, node);
  }
  if (typeof root.resolve.root !== "string" || !nodesById.has(root.resolve.root)) {
    throw new Error("Cargo metadata does not identify the native addon root package.");
  }
  const visited = new Set();
  const pending = [root.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    const node = nodesById.get(id);
    const packageEntry = packagesById.get(id);
    if (!node || !packageEntry) throw new Error("Cargo metadata dependency closure is incomplete.");
    visited.add(id);
    for (const dependency of node.dependencies) pending.push(dependency);
  }
  return [...visited].map((id) => packagesById.get(id));
}

export function buildThirdPartyNotices(metadata) {
  const rootPackageId = metadata?.resolve?.root;
  const packages = resolvedPackages(metadata).map((packageEntry) => {
    if (typeof packageEntry.name !== "string" || packageEntry.name.length === 0 ||
        typeof packageEntry.version !== "string" || packageEntry.version.length === 0) {
      throw new Error("Native dependency metadata contains a malformed package identity.");
    }
    if (typeof packageEntry.license !== "string" || !approvedLicenses.has(packageEntry.license)) {
      throw new Error(`Native dependency license policy rejected ${packageEntry.name}.`);
    }
    return {
      name: packageEntry.name,
      version: packageEntry.version,
      source: packageSource(packageEntry, rootPackageId),
      license: packageEntry.license
    };
  });
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  packages.sort((left, right) =>
    compare(left.name, right.name) ||
    compare(left.version, right.version) ||
    compare(left.source, right.source)
  );
  const records = packages.map((entry) => [
    `${entry.name} ${entry.version}`,
    `Source: ${entry.source}`,
    `License: ${entry.license}`
  ].join("\n"));
  return [
    "TokenGraph Native Lock Addon Third-Party Notices",
    "Generated deterministically from the locked Cargo dependency closure.",
    ...records
  ].join("\n\n") + "\n";
}

export async function readLockedCargoMetadata(options = {}) {
  const cargo = options.cargo ?? process.env.CARGO ?? "cargo";
  const { stdout } = await execFileAsync(cargo, [
    "metadata",
    "--manifest-path", manifestPath,
    "--locked",
    "--format-version", "1"
  ], {
    cwd: pluginRoot,
    encoding: "utf8",
    env: { ...process.env, RUSTUP_TOOLCHAIN: "1.97.1" },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export async function withRegularUnlinkedFileSnapshot(path, label, consume, options = {}) {
  const before = await lstat(path).catch(() => undefined);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.nlink !== 1) {
    throw new Error(`${label} must be a nonempty, unlinked regular file.`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(() => undefined);
  if (!handle) throw new Error(`${label} could not be opened without following links.`);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)) {
      throw new Error(`${label} identity changed before reading.`);
    }
    const bytes = await handle.readFile();
    const result = await consume(bytes, opened);
    if (options.afterSnapshot) await options.afterSnapshot();
    const after = await lstat(path).catch(() => undefined);
    if (!after || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
        !sameIdentity(opened, after) || bytes.length !== opened.size) {
      throw new Error(`${label} identity changed while reading.`);
    }
    return result;
  } finally {
    await handle.close();
  }
}

export async function readRegularUnlinkedFile(path, label) {
  return withRegularUnlinkedFileSnapshot(path, label, (bytes) => bytes);
}

export async function assertNativeAssetLayout(assetsDir) {
  const rootStats = await lstat(assetsDir).catch(() => undefined);
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Native assets root must be an existing unlinked directory.");
  }
  const expected = new Set([...TARGETS.map((target) => target.id), ...outputNames]);
  const entries = await readdir(assetsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!expected.has(entry.name)) throw new Error(`Native assets contain an unlisted entry: ${entry.name}.`);
    const entryStats = await lstat(resolve(assetsDir, entry.name));
    if (entryStats.isSymbolicLink()) throw new Error(`Native assets contain a linked entry: ${entry.name}.`);
  }
  for (const target of TARGETS) {
    const targetPath = resolve(assetsDir, target.id);
    const targetStats = await lstat(targetPath).catch(() => undefined);
    if (!targetStats || !targetStats.isDirectory() || targetStats.isSymbolicLink()) {
      throw new Error(`Native target directory is missing or unsafe: ${target.id}.`);
    }
    const targetEntries = await readdir(targetPath, { withFileTypes: true });
    if (targetEntries.length !== 1 || targetEntries[0].name !== target.file) {
      throw new Error(`Native target directory ${target.id} must contain only ${target.file}.`);
    }
    const artifactStats = await lstat(resolve(targetPath, target.file));
    if (!artifactStats.isFile() || artifactStats.isSymbolicLink()) {
      throw new Error(`Native artifact ${target.id} must be an unlinked regular file.`);
    }
  }
}

export async function inspectNativeArtifacts(assetsDir) {
  const resolvedAssets = resolve(assetsDir);
  await assertNativeAssetLayout(resolvedAssets);
  const artifacts = [];
  for (const target of TARGETS) {
    const relativePath = `${target.id}/${target.file}`;
    const bytes = await readRegularUnlinkedFile(resolve(resolvedAssets, target.id, target.file), `Native artifact ${target.id}`);
    artifacts.push({
      ...target,
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  return artifacts;
}

async function optionalOutputSnapshot(path, label) {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return { bytes: null, mode: null };
  return { bytes: await readRegularUnlinkedFile(path, label), mode: stats.mode & 0o777 };
}

async function verifyOutputState(output) {
  const stats = await lstat(output.path).catch(() => undefined);
  if (output.expected === null) {
    if (stats !== undefined) throw new Error("Expected native output absence could not be proven.");
    return;
  }
  const bytes = await readRegularUnlinkedFile(output.path, output.label);
  if (!bytes.equals(output.expected)) throw new Error("Native output bytes do not match the expected state.");
}

async function cleanupTemporaryFiles(paths) {
  const failures = [];
  for (const path of paths) {
    try {
      await rm(path, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function restoreOutput(output, replaceFile, temporaryPaths) {
  if (output.prior === null) {
    const stats = await lstat(output.path).catch(() => undefined);
    if (stats === undefined) return;
    const current = await readRegularUnlinkedFile(output.path, output.label);
    if (!current.equals(output.next)) throw new Error("Native output replacement state is unproven.");
    await rm(output.path);
    await verifyOutputState({ ...output, expected: null });
    return;
  }
  const restoreTemp = resolve(dirname(output.path), `.${output.name}.${process.pid}-${randomUUID()}.restore.tmp`);
  temporaryPaths.push(restoreTemp);
  await writeFile(restoreTemp, output.prior, { flag: "wx", mode: output.priorMode ?? 0o644 });
  await chmod(restoreTemp, output.priorMode ?? 0o644);
  await replaceFile(restoreTemp, output.path);
  await verifyOutputState({ ...output, expected: output.prior });
}

async function writeOutputsAtomically(assetsDir, manifestText, noticesText, io = {}) {
  const suffix = `${process.pid}-${randomUUID()}.tmp`;
  const replaceFile = io.replaceFile ?? rename;
  const outputs = [
    { name: "manifest.json", label: "Native lock manifest", next: Buffer.from(manifestText), path: resolve(assetsDir, "manifest.json") },
    { name: "THIRD_PARTY_NOTICES.txt", label: "Native dependency notices", next: Buffer.from(noticesText), path: resolve(assetsDir, "THIRD_PARTY_NOTICES.txt") }
  ];
  for (const output of outputs) {
    const snapshot = await optionalOutputSnapshot(output.path, output.label);
    output.prior = snapshot.bytes;
    output.priorMode = snapshot.mode;
  }
  const temporaryPaths = [];
  try {
    for (const output of outputs) {
      output.temp = resolve(assetsDir, `.${output.name}.${suffix}`);
      temporaryPaths.push(output.temp);
      await writeFile(output.temp, output.next, { flag: "wx", mode: 0o644 });
      await chmod(output.temp, 0o644);
      const prepared = await readRegularUnlinkedFile(output.temp, `Prepared ${output.label}`);
      if (!prepared.equals(output.next)) throw new Error("Prepared native output bytes could not be verified.");
    }
  } catch {
    const cleanupFailures = await cleanupTemporaryFiles(temporaryPaths);
    if (cleanupFailures.length > 0) throw new Error("Native output preparation cleanup failed; filesystem state is unproven.");
    throw new Error("Native output preparation failed before replacement.");
  }

  try {
    for (const output of outputs) await replaceFile(output.temp, output.path);
    for (const output of outputs) await verifyOutputState({ ...output, expected: output.next });
  } catch {
    const restorationFailures = [];
    for (const output of [...outputs].reverse()) {
      try {
        await restoreOutput(output, replaceFile, temporaryPaths);
      } catch (error) {
        restorationFailures.push(error);
      }
    }
    const cleanupFailures = await cleanupTemporaryFiles(temporaryPaths);
    if (restorationFailures.length > 0 || cleanupFailures.length > 0) {
      throw new Error("Native output restoration failed after replacement error; filesystem state is unproven.");
    }
    throw new Error("Native output replacement failure; prior outputs were restored.");
  }

  const cleanupFailures = await cleanupTemporaryFiles(temporaryPaths);
  if (cleanupFailures.length > 0) throw new Error("Native output cleanup failed after replacement; filesystem state is unproven.");
}

export async function generateNativeLockManifest({ assetsDir, metadata, io }) {
  const resolvedAssets = resolve(assetsDir);
  const resolvedMetadata = metadata ?? await readLockedCargoMetadata();
  const notices = buildThirdPartyNotices(resolvedMetadata);
  const artifacts = await inspectNativeArtifacts(resolvedAssets);
  const manifest = {
    schemaVersion: 1,
    addonAbiVersion: 1,
    nodeApiVersion: 9,
    rustToolchain: "1.97.1",
    artifacts
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeOutputsAtomically(resolvedAssets, manifestText, notices, io);
  return manifest;
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const args = parseManifestArguments(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      await generateNativeLockManifest(args);
      console.log("TokenGraph native lock manifest and notices generated.");
    }
  } catch (error) {
    console.error(`TokenGraph native lock manifest generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
