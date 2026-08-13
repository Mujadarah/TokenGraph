#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { TARGETS, readRegularUnlinkedFile } from "./generate-native-lock-manifest.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryPrefix = "tokengraph-native-lock-build-";
const targetRecordFields = Object.freeze(["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor"]);

function canonicalTargetRecord(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("Unsupported native target configuration.");
  }
  // Ordinary property descriptors are inspected without evaluating accessors.
  // Proxy ownKeys/getOwnPropertyDescriptor traps are executable caller code and
  // are outside this in-process validation boundary.
  const ownKeys = Reflect.ownKeys(target);
  if (ownKeys.length !== targetRecordFields.length ||
      ownKeys.some((key) => typeof key !== "string" || !targetRecordFields.includes(key))) {
    throw new Error("Unsupported native target configuration.");
  }
  const values = new Map();
  for (const field of targetRecordFields) {
    const descriptor = Object.getOwnPropertyDescriptor(target, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        typeof descriptor.value !== "string") {
      throw new Error("Unsupported native target configuration.");
    }
    values.set(field, descriptor.value);
  }
  const canonical = TARGETS.find((entry) =>
    targetRecordFields.every((field) => values.get(field) === entry[field]));
  if (!canonical) throw new Error("Unsupported native target configuration.");
  return canonical;
}

function usage() {
  return "Usage: node scripts/build-native-lock-addon.mjs --target <rust-target> --out <directory>";
}

function requireOptionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.\n${usage()}`);
  return value;
}

export function parseBuildArguments(argv) {
  let targetName;
  let out;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--target") {
      if (targetName !== undefined) throw new Error("--target may only be provided once.");
      targetName = requireOptionValue(argv, ++index, "--target");
      continue;
    }
    if (argument === "--out") {
      if (out !== undefined) throw new Error("--out may only be provided once.");
      out = resolve(requireOptionValue(argv, ++index, "--out"));
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    throw new Error(`Unknown argument: ${argument}\n${usage()}`);
  }
  if (targetName === undefined) throw new Error(`--target is required.\n${usage()}`);
  if (out === undefined) throw new Error(`--out is required.\n${usage()}`);
  const target = TARGETS.find((entry) => entry.rustTarget === targetName);
  if (!target) throw new Error(`Unsupported native target: ${targetName}.`);
  return { target, out };
}

function targetFlags(target, checkoutRoot) {
  const flags = [
    `--remap-path-prefix=${checkoutRoot}=/tokengraph`,
    "-Cstrip=symbols"
  ];
  if (target.platform === "win32") {
    flags.push("-Clink-arg=/Brepro", "-Ctarget-feature=+crt-static");
  } else if (target.platform === "darwin") {
    flags.push("-Clink-arg=-mmacosx-version-min=11.0");
  }
  return flags;
}

export function buildEnvironmentForTarget(target, checkoutRoot, sourceDateEpoch, cargoTargetDir) {
  target = canonicalTargetRecord(target);
  if (!/^\d+$/u.test(sourceDateEpoch)) throw new Error("SOURCE_DATE_EPOCH must be an integer timestamp.");
  const flags = targetFlags(target, resolve(checkoutRoot));
  const environment = {
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    CARGO_INCREMENTAL: "0",
    CARGO_TARGET_DIR: resolve(cargoTargetDir),
    RUSTUP_TOOLCHAIN: "1.97.1",
    RUSTFLAGS: flags.join(" "),
    CARGO_ENCODED_RUSTFLAGS: flags.join("\u001f")
  };
  if (target.platform === "darwin") environment.MACOSX_DEPLOYMENT_TARGET = "11.0";
  return environment;
}

async function commitTimestamp() {
  const { stdout } = await execFileAsync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: pluginRoot,
    encoding: "utf8",
    windowsHide: true
  });
  const timestamp = stdout.trim();
  if (!/^\d+$/u.test(timestamp)) throw new Error("Repository commit timestamp is unavailable.");
  return timestamp;
}

function builtLibraryName(target) {
  if (target.platform === "win32") return "tokengraph_lock.dll";
  if (target.platform === "darwin") return "libtokengraph_lock.dylib";
  return "libtokengraph_lock.so";
}

async function ensureUnlinkedDirectory(path, label, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path).catch(() => undefined);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be an unlinked directory.`);
  }
}

function assertTaskOwnedTemporaryDirectory(path) {
  const temporaryRoot = resolve(tmpdir());
  const candidate = resolve(path);
  const fromRoot = relative(temporaryRoot, candidate);
  if (fromRoot.startsWith("..") || fromRoot.includes(sep) || !basename(candidate).startsWith(temporaryPrefix)) {
    throw new Error("Refusing to remove an unverified native build directory.");
  }
  return candidate;
}

async function optionalInstalledBytes(path) {
  const stats = await lstat(path).catch(() => undefined);
  return stats === undefined ? null : readRegularUnlinkedFile(path, "Native addon output");
}

async function cleanupInstallTemps(paths) {
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

async function restoreInstalledAddon({ destination, prior, priorMode, next, replaceFile, targetDirectory, temporaryPaths }) {
  const current = await optionalInstalledBytes(destination);
  if (prior === null) {
    if (current === null) return;
    if (!current.equals(next)) throw new Error("Native addon output state is unproven.");
    await rm(destination);
    if (await optionalInstalledBytes(destination) !== null) throw new Error("Native addon output absence could not be proven.");
    return;
  }
  if (current?.equals(prior)) return;
  const restoreTemp = resolve(targetDirectory, `.native-addon.${process.pid}-${randomUUID()}.restore.tmp`);
  temporaryPaths.push(restoreTemp);
  await writeFile(restoreTemp, prior, { flag: "wx", mode: priorMode ?? 0o600 });
  await chmod(restoreTemp, priorMode ?? 0o600);
  await replaceFile(restoreTemp, destination);
  const restored = await readRegularUnlinkedFile(destination, "Restored native addon output");
  if (!restored.equals(prior)) throw new Error("Native addon output restoration could not be proven.");
}

export async function installBuiltAddon({ source, outRoot, target, io = {} }) {
  target = canonicalTargetRecord(target);
  const sourceStats = await lstat(source).catch(() => undefined);
  // Cargo hard-links final profile artifacts from `deps`; the installed copy
  // below is independently created and must have link count one.
  if (!sourceStats || !sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.size <= 0) {
    throw new Error("Cargo did not produce the expected native library.");
  }
  const sourceBytes = await readFile(source);
  if (sourceBytes.length !== sourceStats.size) throw new Error("Cargo native library changed while reading.");
  await ensureUnlinkedDirectory(outRoot, "Native build output root", true);
  for (const entry of await readdir(outRoot, { withFileTypes: true })) {
    const target = TARGETS.find((candidate) => candidate.id === entry.name);
    if (!target || !entry.isDirectory()) {
      throw new Error(`Native build output contains an unlisted target directory: ${entry.name}.`);
    }
    const entryStats = await lstat(resolve(outRoot, entry.name));
    if (entryStats.isSymbolicLink()) throw new Error(`Native build output target ${entry.name} is linked.`);
  }
  const targetDirectory = resolve(outRoot, target.id);
  await ensureUnlinkedDirectory(targetDirectory, `Native target output ${target.id}`, true);
  const entries = await readdir(targetDirectory);
  if (entries.some((entry) => entry !== target.file)) {
    throw new Error(`Native target output ${target.id} contains an unlisted entry.`);
  }
  const destination = resolve(targetDirectory, target.file);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error("Refusing to replace an unsafe native addon output.");
  }
  const prior = existing ? await readRegularUnlinkedFile(destination, "Existing native addon output") : null;
  const priorMode = existing ? existing.mode & 0o777 : null;
  const temporaryDestination = resolve(targetDirectory, `.${target.file}.${process.pid}-${randomUUID()}.tmp`);
  const temporaryPaths = [temporaryDestination];
  const replaceFile = io.replaceFile ?? rename;
  try {
    await copyFile(source, temporaryDestination, constants.COPYFILE_EXCL);
    await chmod(temporaryDestination, 0o644);
    const prepared = await readRegularUnlinkedFile(temporaryDestination, "Prepared native addon output");
    if (!prepared.equals(sourceBytes)) throw new Error("Prepared native addon bytes could not be verified.");
  } catch {
    const cleanupFailures = await cleanupInstallTemps(temporaryPaths);
    if (cleanupFailures.length > 0) throw new Error("Native addon preparation cleanup failed; filesystem state is unproven.");
    throw new Error("Native addon preparation failed before replacement.");
  }

  try {
    await replaceFile(temporaryDestination, destination);
    if (io.afterReplace) await io.afterReplace(destination);
    const installed = await readRegularUnlinkedFile(destination, "Installed native addon output");
    if (!installed.equals(sourceBytes)) throw new Error("Installed native addon bytes could not be verified.");
  } catch {
    let restorationFailure;
    try {
      await restoreInstalledAddon({
        destination,
        prior,
        priorMode,
        next: sourceBytes,
        replaceFile,
        targetDirectory,
        temporaryPaths
      });
    } catch (error) {
      restorationFailure = error;
    }
    const cleanupFailures = await cleanupInstallTemps(temporaryPaths);
    if (restorationFailure || cleanupFailures.length > 0) {
      throw new Error("Native addon restoration failed after replacement error; filesystem state is unproven.");
    }
    throw new Error("Native addon replacement failure; prior output was restored.");
  }

  const cleanupFailures = await cleanupInstallTemps(temporaryPaths);
  if (cleanupFailures.length > 0) throw new Error("Native addon cleanup failed after replacement; filesystem state is unproven.");
  return destination;
}

export async function buildNativeLockAddon({ target, out }) {
  target = canonicalTargetRecord(target);
  const cargoTargetDirectory = await mkdtemp(resolve(tmpdir(), temporaryPrefix));
  try {
    const sourceDateEpoch = await commitTimestamp();
    const overlay = buildEnvironmentForTarget(target, pluginRoot, sourceDateEpoch, cargoTargetDirectory);
    const environment = { ...process.env, ...overlay };
    delete environment.RUSTC_WRAPPER;
    delete environment.RUSTC_WORKSPACE_WRAPPER;
    const cargo = process.env.CARGO ?? "cargo";
    await new Promise((resolvePromise, rejectPromise) => {
      const child = execFile(cargo, [
        "build",
        "--release",
        "--locked",
        "--manifest-path", "native/lock-addon/Cargo.toml",
        "--target", target.rustTarget
      ], {
        cwd: pluginRoot,
        env: environment,
        windowsHide: true
      }, (error) => error ? rejectPromise(error) : resolvePromise());
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    });
    const source = resolve(cargoTargetDirectory, target.rustTarget, "release", builtLibraryName(target));
    return await installBuiltAddon({ source, outRoot: resolve(out), target });
  } finally {
    const verified = assertTaskOwnedTemporaryDirectory(cargoTargetDirectory);
    await rm(verified, { recursive: true, force: true });
  }
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const args = parseBuildArguments(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      await buildNativeLockAddon(args);
      console.log(`TokenGraph native lock addon built for ${args.target.id}.`);
    }
  } catch (error) {
    console.error(`TokenGraph native lock build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
