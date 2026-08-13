#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TARGETS,
  assertNativeAssetLayout,
  buildThirdPartyNotices,
  parseManifestArguments,
  readLockedCargoMetadata,
  readRegularUnlinkedFile,
  withRegularUnlinkedFileSnapshot
} from "./generate-native-lock-manifest.mjs";

const require = createRequire(import.meta.url);

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has an unexpected schema.`);
  }
}

function assertManifest(manifest) {
  exactKeys(manifest, ["schemaVersion", "addonAbiVersion", "nodeApiVersion", "rustToolchain", "artifacts"], "Native lock manifest");
  if (manifest.schemaVersion !== 1 || manifest.addonAbiVersion !== 1 || manifest.nodeApiVersion !== 9 || manifest.rustToolchain !== "1.97.1") {
    throw new Error("Native lock manifest ABI or toolchain metadata is unsupported.");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== TARGETS.length) {
    throw new Error("Native lock manifest must contain exactly six artifacts.");
  }
  const artifactKeys = ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor", "path", "bytes", "sha256"];
  for (let index = 0; index < TARGETS.length; index += 1) {
    const target = TARGETS[index];
    const artifact = manifest.artifacts[index];
    exactKeys(artifact, artifactKeys, `Native lock artifact ${index}`);
    for (const key of ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor"]) {
      if (artifact[key] !== target[key]) throw new Error(`Native lock artifact ${index} has invalid ${key} metadata.`);
    }
    if (artifact.path !== `${target.id}/${target.file}`) {
      throw new Error(`Native lock artifact ${target.id} has an unsafe or incorrect relative path.`);
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      throw new Error(`Native lock artifact ${target.id} has an invalid byte length.`);
    }
    if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      throw new Error(`Native lock artifact ${target.id} has an invalid SHA-256.`);
    }
  }
  return manifest;
}

function assertBinaryMagic(target, bytes) {
  if (target.platform === "win32") {
    if (bytes.length < 70 || bytes.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Native artifact ${target.id} is not a PE binary.`);
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 6 > bytes.length || bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
      throw new Error(`Native artifact ${target.id} has invalid PE magic.`);
    }
    const expectedMachine = target.arch === "arm64" ? 0xaa64 : 0x8664;
    if (bytes.readUInt16LE(peOffset + 4) !== expectedMachine) {
      throw new Error(`Native artifact ${target.id} has the wrong PE architecture.`);
    }
    return;
  }
  if (target.platform === "linux") {
    if (bytes.length < 20 || !bytes.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))) {
      throw new Error(`Native artifact ${target.id} is not a supported ELF64 binary.`);
    }
    const expectedMachine = target.arch === "arm64" ? 0xb7 : 0x3e;
    if (bytes.readUInt16LE(18) !== expectedMachine) {
      throw new Error(`Native artifact ${target.id} has the wrong ELF architecture.`);
    }
    return;
  }
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`Native artifact ${target.id} is not a supported Mach-O 64-bit binary.`);
  }
  const expectedCpu = target.arch === "arm64" ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(4) !== expectedCpu) {
    throw new Error(`Native artifact ${target.id} has the wrong Mach-O architecture.`);
  }
}

function assertNoMachineLocalPath(bytes) {
  const searchable = bytes.toString("latin1");
  if (/(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/|\/root\/|\/tmp\/|\/workspace\/)[^\0\r\n\t ]+/iu.test(searchable)) {
    throw new Error("Native artifact contains a machine-local build path.");
  }
}

function atLeastGlibc228(version) {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 28);
}

function currentTarget(runtime) {
  const platform = runtime.platform;
  const arch = runtime.arch;
  if (platform === "linux") {
    const glibc = runtime.glibcVersionRuntime ?? process.report?.getReport?.().header?.glibcVersionRuntime;
    if (!atLeastGlibc228(glibc)) throw new Error("Current Linux runtime is not verified glibc 2.28 or newer.");
  }
  const target = TARGETS.find((entry) => entry.platform === platform && entry.arch === arch);
  if (!target) throw new Error("Current platform is not supported by the native lock addon.");
  return target;
}

async function assertExactAssetEntries(assetsDir) {
  const expected = new Set([...TARGETS.map((target) => target.id), "manifest.json", "THIRD_PARTY_NOTICES.txt"]);
  const entries = await readdir(assetsDir, { withFileTypes: true });
  if (entries.length !== expected.size) throw new Error("Native assets directory allowlist is incomplete or contains extras.");
  for (const entry of entries) {
    if (!expected.has(entry.name)) throw new Error(`Native assets contain an unlisted entry: ${entry.name}.`);
    const stats = await lstat(resolve(assetsDir, entry.name));
    if (stats.isSymbolicLink()) throw new Error(`Native assets contain a linked entry: ${entry.name}.`);
  }
}

export async function validateNativeLockAssets({ assetsDir, metadata, loadCurrent = false, runtime = {} }) {
  const resolvedAssets = resolve(assetsDir);
  await assertExactAssetEntries(resolvedAssets);
  const manifestBytes = await readRegularUnlinkedFile(resolve(resolvedAssets, "manifest.json"), "Native lock manifest");
  let manifest;
  try {
    manifest = assertManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Native lock manifest is not valid JSON.");
    throw error;
  }
  await assertNativeAssetLayout(resolvedAssets);
  for (let index = 0; index < TARGETS.length; index += 1) {
    const target = TARGETS[index];
    const expected = manifest.artifacts[index];
    const artifactPath = resolve(resolvedAssets, target.id, target.file);
    await withRegularUnlinkedFileSnapshot(artifactPath, `Native artifact ${target.id}`, (bytes) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (expected.bytes !== bytes.length || expected.sha256 !== sha256) {
        throw new Error(`Native artifact ${target.id} failed byte-length or SHA-256 validation.`);
      }
      assertBinaryMagic(target, bytes);
      assertNoMachineLocalPath(bytes);
    }, {
      afterSnapshot: runtime.afterArtifactSnapshot ? () => runtime.afterArtifactSnapshot(target) : undefined
    });
  }
  const resolvedMetadata = metadata ?? await readLockedCargoMetadata();
  const expectedNotices = buildThirdPartyNotices(resolvedMetadata);
  const actualNotices = await readRegularUnlinkedFile(resolve(resolvedAssets, "THIRD_PARTY_NOTICES.txt"), "Native dependency notices");
  if (actualNotices.toString("utf8") !== expectedNotices) {
    throw new Error("Native dependency notices do not match the locked dependency closure.");
  }
  if (loadCurrent) {
    const target = currentTarget({
      platform: runtime.platform ?? process.platform,
      arch: runtime.arch ?? process.arch,
      glibcVersionRuntime: runtime.glibcVersionRuntime
    });
    const path = resolve(resolvedAssets, target.id, target.file);
    const loadModule = runtime.loadModule ?? ((modulePath) => require(modulePath));
    const addon = loadModule(path);
    if (!addon || addon.abiVersion !== 1) throw new Error("Current native lock addon ABI is not version 1.");
    const expectedImplementation = target.platform === "win32" ? "lockfileex" : "flock";
    if (typeof addon.implementation !== "function" || addon.implementation() !== expectedImplementation) {
      throw new Error("Current native lock addon implementation does not match its target.");
    }
    if (typeof addon.tryAcquireAnchor !== "function") {
      throw new Error("Current native lock addon acquisition export is missing.");
    }
  }
  return { artifactCount: TARGETS.length, loadedCurrent: loadCurrent };
}

function usage() {
  return "Usage: node scripts/validate-native-lock-addon.mjs --assets <directory> [--load-current]";
}

function parseValidationArguments(argv) {
  const forwarded = [];
  let loadCurrent = false;
  for (const argument of argv) {
    if (argument === "--load-current") {
      if (loadCurrent) throw new Error("--load-current may only be provided once.");
      loadCurrent = true;
    } else {
      forwarded.push(argument);
    }
  }
  const parsed = parseManifestArguments(forwarded);
  return { ...parsed, loadCurrent };
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const args = parseValidationArguments(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      const result = await validateNativeLockAssets(args);
      console.log(`TokenGraph native lock assets validated (${result.artifactCount} artifacts).`);
    }
  } catch (error) {
    console.error(`TokenGraph native lock validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
