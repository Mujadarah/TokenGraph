import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVED_LICENSE_EXPRESSIONS,
  TARGETS,
  buildThirdPartyNotices,
  generateNativeLockManifest,
  readLockedCargoMetadata
// @ts-expect-error Executable JavaScript modules intentionally have no declaration emit.
} from "../scripts/generate-native-lock-manifest.mjs";
import {
  buildEnvironmentForTarget,
  buildNativeLockAddon,
  installBuiltAddon,
  parseBuildArguments
// @ts-expect-error Executable JavaScript modules intentionally have no declaration emit.
} from "../scripts/build-native-lock-addon.mjs";
import {
  validateNativeLockAssets
// @ts-expect-error Executable JavaScript modules intentionally have no declaration emit.
} from "../scripts/validate-native-lock-addon.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

const LICENSES = [
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "MIT",
  "MIT OR Apache-2.0",
  "Apache-2.0 OR MIT",
  "ISC",
  "Unlicense OR MIT",
  "(MIT OR Apache-2.0) AND Unicode-3.0",
  "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT"
] as const;

const EXPECTED_TARGETS = [
  { id: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", rustTarget: "aarch64-apple-darwin", file: "tokengraph-lock.darwin-arm64.node", osFloor: "macos-11.0" },
  { id: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", rustTarget: "x86_64-apple-darwin", file: "tokengraph-lock.darwin-x64.node", osFloor: "macos-11.0" },
  { id: "linux-arm64-gnu", platform: "linux", arch: "arm64", libc: "glibc", rustTarget: "aarch64-unknown-linux-gnu", file: "tokengraph-lock.linux-arm64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "linux-x64-gnu", platform: "linux", arch: "x64", libc: "glibc", rustTarget: "x86_64-unknown-linux-gnu", file: "tokengraph-lock.linux-x64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "win32-arm64", platform: "win32", arch: "arm64", libc: "none", rustTarget: "aarch64-pc-windows-msvc", file: "tokengraph-lock.win32-arm64.node", osFloor: "windows-10" },
  { id: "win32-x64", platform: "win32", arch: "x64", libc: "none", rustTarget: "x86_64-pc-windows-msvc", file: "tokengraph-lock.win32-x64.node", osFloor: "windows-10-server-2016" }
] as const;

type MetadataPackage = {
  id: string;
  name: string;
  version: string;
  source: string | null;
  license?: unknown;
  license_file?: string | null;
};

type NativeTarget = {
  id: string;
  platform: string;
  arch: string;
  libc: string;
  rustTarget: string;
  file: string;
  osFloor: string;
};

const canonicalWindowsTarget = TARGETS.find((entry: NativeTarget) => entry.id === "win32-x64")!;
const { osFloor: _omittedOsFloor, ...targetMissingOsFloor } = canonicalWindowsTarget;
const FORGED_TARGETS = [
  ["platform", { ...canonicalWindowsTarget, platform: "linux" }],
  ["file path", { ...canonicalWindowsTarget, file: "..\\..\\escape.node" }],
  ["architecture", { ...canonicalWindowsTarget, arch: "arm64" }],
  ["libc", { ...canonicalWindowsTarget, libc: "glibc" }],
  ["OS floor", { ...canonicalWindowsTarget, osFloor: "windows-10" }],
  ["id", { ...canonicalWindowsTarget, id: "win32-arm64" }],
  ["Rust triple", { ...canonicalWindowsTarget, rustTarget: "aarch64-pc-windows-msvc" }],
  ["missing field", targetMissingOsFloor],
  ["extra field", { ...canonicalWindowsTarget, unexpected: "field" }]
] as const;

function accessorTarget(onRead: (field: keyof NativeTarget) => void) {
  const target: Record<string, unknown> = {};
  for (const field of ["id", "platform", "arch", "libc", "rustTarget", "file", "osFloor"] as const) {
    Object.defineProperty(target, field, {
      configurable: true,
      enumerable: true,
      get() {
        onRead(field);
        return canonicalWindowsTarget[field];
      }
    });
  }
  return target;
}

type CargoMetadataFixture = {
  packages: MetadataPackage[];
  resolve: { root: string; nodes: Array<{ id: string; dependencies: string[] }> };
  workspace_root?: string;
  target_directory?: string;
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function temporaryDirectory(label: string) {
  const root = await mkdtemp(resolve(tmpdir(), `tokengraph-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function metadataForLicenses(licenses: readonly unknown[]): CargoMetadataFixture {
  const packages = licenses.map((license, index) => ({
    id: `registry+https://example.invalid#index-${index}@1.0.${index}`,
    name: `dependency-${String(index).padStart(2, "0")}`,
    version: `1.0.${index}`,
    source: "registry+https://github.com/rust-lang/crates.io-index",
    license
  }));
  return {
    packages,
    resolve: {
      root: packages[0]!.id,
      nodes: packages.map((entry, index) => ({
        id: entry.id,
        dependencies: index + 1 < packages.length ? [packages[index + 1]!.id] : []
      }))
    },
    workspace_root: "C:\\must-not-appear",
    target_directory: "C:\\must-not-appear\\target"
  };
}

function binaryFixture(platform: string, arch: string) {
  if (platform === "win32") {
    const bytes = Buffer.alloc(128);
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(64, 0x3c);
    bytes.write("PE\0\0", 64, "binary");
    bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68);
    return bytes;
  }
  if (platform === "linux") {
    const bytes = Buffer.alloc(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    bytes.writeUInt16LE(arch === "arm64" ? 0xb7 : 0x3e, 18);
    return bytes;
  }
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}

async function writeSixTargetFixture(root: string) {
  for (const target of TARGETS) {
    const directory = resolve(root, target.id);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, target.file), binaryFixture(target.platform, target.arch));
  }
}

async function generateFixture(root: string, metadata = metadataForLicenses(LICENSES)) {
  await writeSixTargetFixture(root);
  await generateNativeLockManifest({ assetsDir: root, metadata });
  return JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as {
    schemaVersion: number;
    addonAbiVersion: number;
    nodeApiVersion: number;
    rustToolchain: string;
    artifacts: Array<Record<string, unknown>>;
  };
}

describe("native lock package commands", () => {
  it("registers the three exact package commands", async () => {
    const packageJson = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      "native:build": "node scripts/build-native-lock-addon.mjs",
      "native:manifest": "node scripts/generate-native-lock-manifest.mjs",
      "native:validate": "node scripts/validate-native-lock-addon.mjs"
    });
  });

  it("accepts only the exact six Rust targets and requires an output", () => {
    expect(TARGETS).toEqual(EXPECTED_TARGETS);
    expect(parseBuildArguments(["--target", "x86_64-pc-windows-msvc", "--out", "build"])).toEqual({
      target: expect.objectContaining({ id: "win32-x64" }),
      out: resolve("build")
    });
    expect(() => parseBuildArguments(["--target", "x86_64-unknown-linux-musl", "--out", "build"])).toThrow(/unsupported native target/i);
    expect(() => parseBuildArguments(["--target", "x86_64-pc-windows-msvc"])).toThrow(/--out/i);
    expect(() => parseBuildArguments(["--target", "x86_64-pc-windows-msvc", "--out", "build", "--out", "other"])).toThrow(/only be provided once/i);
  });

  it("pins deterministic target-specific Rust flags", () => {
    const epoch = "1786233600";
    const checkout = resolve("safe-checkout");
    const userProfile = resolve("private-build-user");
    const cargoHome = resolve("private-cargo-home");
    const windows = buildEnvironmentForTarget(
      TARGETS.find((entry: NativeTarget) => entry.id === "win32-x64")!,
      checkout,
      epoch,
      resolve(tmpdir(), "cargo-target"),
      { userProfile, cargoHome }
    );
    expect(windows.SOURCE_DATE_EPOCH).toBe(epoch);
    expect(windows.CARGO_INCREMENTAL).toBe("0");
    expect(windows.RUSTUP_TOOLCHAIN).toBe("1.97.1");
    expect(windows.RUSTFLAGS).toContain(`--remap-path-prefix=${checkout}=/tokengraph`);
    expect(windows.RUSTFLAGS).toContain(`--remap-path-prefix=${userProfile}=/tokengraph-build-user`);
    expect(windows.RUSTFLAGS).toContain(`--remap-path-prefix=${cargoHome}=/tokengraph-cargo`);
    expect(windows.RUSTFLAGS).toContain("-Cstrip=symbols");
    expect(windows.RUSTFLAGS).toContain("-Clink-arg=/Brepro");
    expect(windows.RUSTFLAGS).toContain("-Ctarget-feature=+crt-static");
    expect(windows.CARGO_TARGET_DIR).toBe(resolve(tmpdir(), "cargo-target"));

    for (const id of ["darwin-arm64", "linux-arm64-gnu"]) {
      const environment = buildEnvironmentForTarget(
        TARGETS.find((entry: NativeTarget) => entry.id === id)!,
        checkout,
        epoch,
        resolve(tmpdir(), `${id}-cargo-target`),
        { userProfile, cargoHome }
      );
      expect(environment.RUSTFLAGS).toContain(`--remap-path-prefix=${userProfile}=/tokengraph-build-user`);
      expect(environment.RUSTFLAGS).toContain(`--remap-path-prefix=${cargoHome}=/tokengraph-cargo`);
      expect(environment.RUSTFLAGS).toContain(`--remap-path-prefix=${checkout}=/tokengraph`);
    }

    const mac = buildEnvironmentForTarget(TARGETS.find((entry: NativeTarget) => entry.id === "darwin-arm64")!, checkout, epoch, resolve(tmpdir(), "cargo-target-mac"));
    expect(mac.MACOSX_DEPLOYMENT_TARGET).toBe("11.0");
    expect(mac.RUSTFLAGS).toContain("-Clink-arg=-mmacosx-version-min=11.0");
    expect(mac.RUSTFLAGS).not.toContain("-no_uuid");
    expect(mac.RUSTFLAGS).not.toContain("-random_uuid");
  });

  it.each(FORGED_TARGETS)("rejects a forged %s before deriving build flags", (_label, target) => {
    const epoch = "1786233600";
    const checkout = resolve("safe-checkout");
    const cargoTarget = resolve(tmpdir(), "cargo-target-forged");
    expect(() => buildEnvironmentForTarget(target, checkout, epoch, cargoTarget)).toThrow(/unsupported native target configuration/i);
  });

  it("accepts an exact copied canonical target record", () => {
    const epoch = "1786233600";
    const checkout = resolve("safe-checkout");
    const cargoTarget = resolve(tmpdir(), "cargo-target-canonical-copy");
    expect(buildEnvironmentForTarget({ ...canonicalWindowsTarget }, checkout, epoch, cargoTarget).RUSTFLAGS).toContain("-Clink-arg=/Brepro");
  });

  it("rejects accessor-backed target fields without invoking a throwing getter", () => {
    const invoked: string[] = [];
    const target = accessorTarget((field) => {
      invoked.push(field);
      throw new Error("target getter executed");
    });
    let failure: unknown;
    try {
      buildEnvironmentForTarget(target, resolve("safe-checkout"), "1786233600", resolve(tmpdir(), "cargo-target-accessor"));
    } catch (error) {
      failure = error;
    }
    expect({
      message: failure instanceof Error ? failure.message : undefined,
      invoked
    }).toEqual({
      message: "Unsupported native target configuration.",
      invoked: []
    });
  });

  it("rejects accessor-backed build targets before invoking getters or spawning Cargo", async () => {
    const root = await temporaryDirectory("accessor-build-target");
    const out = resolve(root, "output");
    const missingCargo = resolve(root, "must-not-be-spawned-cargo.exe");
    const invoked: string[] = [];
    const target = accessorTarget((field) => { invoked.push(field); });
    const originalCargo = process.env.CARGO;
    process.env.CARGO = missingCargo;
    let failure: unknown;
    try {
      await buildNativeLockAddon({ target, out });
    } catch (error) {
      failure = error;
    } finally {
      if (originalCargo === undefined) delete process.env.CARGO;
      else process.env.CARGO = originalCargo;
    }
    expect({
      unsupported: failure instanceof Error && /unsupported native target configuration/i.test(failure.message),
      spawnAttempted: (failure as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
      invoked,
      outputCreated: await lstat(out).then(() => true, () => false)
    }).toEqual({ unsupported: true, spawnAttempted: false, invoked: [], outputCreated: false });
  });

  it("rejects accessor-backed install targets before invoking getters or mutating files", async () => {
    const root = await temporaryDirectory("accessor-install-target");
    const source = resolve(root, "source.dll");
    const outRoot = resolve(root, "output");
    const sentinel = resolve(root, "sentinel.txt");
    const priorSentinel = Buffer.from("sentinel-before");
    await writeFile(source, Buffer.from("new-addon-bytes"));
    await writeFile(sentinel, priorSentinel);
    const invoked: string[] = [];
    const target = accessorTarget((field) => {
      invoked.push(field);
      writeFileSync(sentinel, `getter:${field}`);
    });
    let failure: unknown;
    try {
      await installBuiltAddon({ source, outRoot, target });
    } catch (error) {
      failure = error;
    }
    expect({
      unsupported: failure instanceof Error && /unsupported native target configuration/i.test(failure.message),
      invoked,
      sentinel: await readFile(sentinel, "utf8"),
      outputCreated: await lstat(outRoot).then(() => true, () => false)
    }).toEqual({ unsupported: true, invoked: [], sentinel: priorSentinel.toString("utf8"), outputCreated: false });
  });

  it("rejects a forged build target before attempting to spawn Cargo or create output", async () => {
    const root = await temporaryDirectory("forged-build-target");
    const out = resolve(root, "output");
    const missingCargo = resolve(root, "must-not-be-spawned-cargo.exe");
    const originalCargo = process.env.CARGO;
    process.env.CARGO = missingCargo;
    try {
      await expect(buildNativeLockAddon({ target: { ...canonicalWindowsTarget, platform: "linux" }, out })).rejects.toThrow(/unsupported native target configuration/i);
    } finally {
      if (originalCargo === undefined) delete process.env.CARGO;
      else process.env.CARGO = originalCargo;
    }
    expect(await lstat(out).catch(() => undefined)).toBeUndefined();
  });

  it("rejects an escaped addon destination before touching the sentinel or output root", async () => {
    // @ts-expect-error Executable JavaScript modules intentionally have no declaration emit.
    const buildModule = await import("../scripts/build-native-lock-addon.mjs");
    const root = await temporaryDirectory("forged-addon-destination");
    const source = resolve(root, "source.dll");
    const outRoot = resolve(root, "output");
    const escaped = resolve(root, "escape.node");
    const prior = Buffer.from("escape-sentinel");
    await writeFile(source, Buffer.from("new-addon-bytes"));
    await writeFile(escaped, prior);

    await expect(buildModule.installBuiltAddon({
      source,
      outRoot,
      target: { ...canonicalWindowsTarget, file: "..\\..\\escape.node" }
    })).rejects.toThrow(/unsupported native target configuration/i);
    expect(await readFile(escaped)).toEqual(prior);
    expect(await lstat(outRoot).catch(() => undefined)).toBeUndefined();
  });

  it("runs the manifest and validation command interfaces against six fixtures", async () => {
    const root = await temporaryDirectory("command-interface");
    await writeSixTargetFixture(root);
    const generated = spawnSync(process.execPath, [
      resolve(pluginRoot, "scripts", "generate-native-lock-manifest.mjs"),
      "--assets", root
    ], { cwd: pluginRoot, encoding: "utf8", env: process.env, windowsHide: true });
    expect(generated.error).toBeUndefined();
    expect(generated.status, generated.stderr).toBe(0);
    const validated = spawnSync(process.execPath, [
      resolve(pluginRoot, "scripts", "validate-native-lock-addon.mjs"),
      "--assets", root
    ], { cwd: pluginRoot, encoding: "utf8", env: process.env, windowsHide: true });
    expect(validated.error).toBeUndefined();
    expect(validated.status, validated.stderr).toBe(0);
    expect(validated.stdout).toContain("validated (6 artifacts)");
  });

  it("preserves the prior addon when destination replacement fails", async () => {
    // @ts-expect-error Executable JavaScript modules intentionally have no declaration emit.
    const buildModule = await import("../scripts/build-native-lock-addon.mjs");
    expect(buildModule.installBuiltAddon).toBeTypeOf("function");
    const root = await temporaryDirectory("build-replace-failure");
    const source = resolve(root, "source.dll");
    const outRoot = resolve(root, "output");
    const target = TARGETS.find((entry: NativeTarget) => entry.id === "win32-x64")!;
    const targetDirectory = resolve(outRoot, target.id);
    const destination = resolve(targetDirectory, target.file);
    const prior = Buffer.from("prior-addon-bytes");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(source, Buffer.from("new-addon-bytes"));
    await writeFile(destination, prior);

    await expect(buildModule.installBuiltAddon({
      source,
      outRoot,
      target,
      io: { replaceFile: async () => { throw new Error("deterministic replace failure"); } }
    })).rejects.toThrow(/replacement failure/i);
    expect(await readFile(destination)).toEqual(prior);
    expect((await readdir(targetDirectory)).filter((entry) => /tmp|backup/i.test(entry))).toEqual([]);
  });

  it("restores the prior addon when post-replacement verification fails", async () => {
    // @ts-expect-error Executable JavaScript modules intentionally have no declaration emit.
    const buildModule = await import("../scripts/build-native-lock-addon.mjs");
    expect(buildModule.installBuiltAddon).toBeTypeOf("function");
    const root = await temporaryDirectory("build-post-verify-failure");
    const source = resolve(root, "source.dll");
    const outRoot = resolve(root, "output");
    const target = TARGETS.find((entry: NativeTarget) => entry.id === "win32-x64")!;
    const targetDirectory = resolve(outRoot, target.id);
    const destination = resolve(targetDirectory, target.file);
    const prior = Buffer.from("prior-addon-bytes");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(source, Buffer.from("new-addon-bytes"));
    await writeFile(destination, prior);

    await expect(buildModule.installBuiltAddon({
      source,
      outRoot,
      target,
      io: { afterReplace: async () => { throw new Error("deterministic post-verify failure"); } }
    })).rejects.toThrow(/replacement failure/i);
    expect(await readFile(destination)).toEqual(prior);
    expect((await readdir(targetDirectory)).filter((entry) => /tmp|backup/i.test(entry))).toEqual([]);
  });
});

describe("native lock manifest generation", () => {
  it("emits the exact sorted NativeLockManifestV1 schema", async () => {
    const root = await temporaryDirectory("manifest");
    const manifest = await generateFixture(root);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      addonAbiVersion: 1,
      nodeApiVersion: 9,
      rustToolchain: "1.97.1",
      artifacts: expect.any(Array)
    });
    expect(manifest.artifacts.map((entry) => entry.id)).toEqual([
      "darwin-arm64", "darwin-x64", "linux-arm64-gnu",
      "linux-x64-gnu", "win32-arm64", "win32-x64"
    ]);
    expect(await readFile(resolve(root, "manifest.json"), "utf8")).toMatch(/\n$/);
  });

  it("accepts all nine exact license expressions and emits deterministic path-free notices", () => {
    expect(APPROVED_LICENSE_EXPRESSIONS).toEqual(LICENSES);
    const metadata = metadataForLicenses(LICENSES);
    const first = buildThirdPartyNotices(metadata);
    const second = buildThirdPartyNotices(structuredClone(metadata));
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
    for (const license of LICENSES) expect(first).toContain(`License: ${license}`);
    expect(first).not.toContain("must-not-appear");
    expect(first).not.toContain("Generated at");
  });

  it("accepts the real complete locked dependency closure", async () => {
    const metadata = await readLockedCargoMetadata();
    const notices = buildThirdPartyNotices(metadata);
    expect(notices).toContain("tokengraph-lock 0.1.0");
    expect(notices).toContain("libloading 0.9.0");
    expect(notices).toContain("unicode-ident 1.0.24");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["non-string", 42],
    ["GPL", "GPL-3.0-only"],
    ["LicenseRef", "LicenseRef-Proprietary"],
    ["standalone Unlicense", "Unlicense"],
    ["standalone Unicode", "Unicode-3.0"],
    ["AND combination", "MIT AND Apache-2.0"],
    ["unknown in OR", "MIT OR Unknown-1.0"],
    ["whitespace", "MIT  OR Apache-2.0"],
    ["order", "Apache-2.0 OR Unlicense"],
    ["parentheses", "(MIT OR Apache-2.0)"],
    ["case", "mit"]
  ])("rejects the %s license without license_file fallback", (_label, license) => {
    const metadata = metadataForLicenses([license]);
    metadata.packages[0]!.license_file = "LICENSE";
    if (license === undefined) delete metadata.packages[0]!.license;
    expect(() => buildThirdPartyNotices(metadata)).toThrow(/license policy/i);
  });

  it("sorts notices by name, version, then source", () => {
    const metadata = metadataForLicenses(["MIT", "Apache-2.0", "ISC"]);
    metadata.packages[0] = { ...metadata.packages[0]!, id: "z", name: "same", version: "2.0.0", source: "registry+https://github.com/rust-lang/crates.io-index" };
    metadata.packages[1] = { ...metadata.packages[1]!, id: "a", name: "same", version: "1.0.0", source: "registry+https://github.com/rust-lang/crates.io-index" };
    metadata.packages[2] = { ...metadata.packages[2]!, id: "b", name: "same", version: "1.0.0", source: null };
    metadata.resolve.nodes = [
      { id: "a", dependencies: ["z"] },
      { id: "b", dependencies: ["a"] },
      { id: "z", dependencies: [] }
    ];
    metadata.resolve.root = "b";
    const notices = buildThirdPartyNotices(metadata);
    expect(notices.indexOf("same 1.0.0\nSource: registry+https://github.com/rust-lang/crates.io-index")).toBeLessThan(notices.indexOf("same 1.0.0\nSource: workspace"));
    expect(notices.indexOf("same 1.0.0\nSource: workspace")).toBeLessThan(notices.indexOf("same 2.0.0\nSource: registry+https://github.com/rust-lang/crates.io-index"));
  });

  it("leaves no partial outputs when validation fails", async () => {
    const root = await temporaryDirectory("atomic");
    await writeSixTargetFixture(root);
    await writeFile(resolve(root, "manifest.json"), "previous manifest\n");
    await writeFile(resolve(root, "THIRD_PARTY_NOTICES.txt"), "previous notices\n");
    await expect(generateNativeLockManifest({ assetsDir: root, metadata: metadataForLicenses(["GPL-3.0-only"]) })).rejects.toThrow(/license policy/i);
    expect(await readFile(resolve(root, "manifest.json"), "utf8")).toBe("previous manifest\n");
    expect(await readFile(resolve(root, "THIRD_PARTY_NOTICES.txt"), "utf8")).toBe("previous notices\n");
    expect((await readdir(root)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  it("rolls back both fixed outputs when the second replacement fails", async () => {
    const root = await temporaryDirectory("paired-rollback");
    const metadata = metadataForLicenses(LICENSES);
    await generateFixture(root, metadata);
    const manifestPath = resolve(root, "manifest.json");
    const noticesPath = resolve(root, "THIRD_PARTY_NOTICES.txt");
    const priorManifest = await readFile(manifestPath);
    const priorNotices = await readFile(noticesPath);
    const target = TARGETS[0]!;
    const artifactPath = resolve(root, target.id, target.file);
    await writeFile(artifactPath, Buffer.concat([await readFile(artifactPath), Buffer.from([0])]));
    let replacements = 0;
    const replaceFile = async (source: string, destination: string) => {
      replacements += 1;
      if (replacements === 2) throw new Error("deterministic second replacement failure");
      await rename(source, destination);
    };

    await expect(generateNativeLockManifest({ assetsDir: root, metadata, io: { replaceFile } })).rejects.toThrow(/replacement failure/i);
    expect(await readFile(manifestPath)).toEqual(priorManifest);
    expect(await readFile(noticesPath)).toEqual(priorNotices);
    expect((await readdir(root)).filter((entry) => /(?:tmp|backup)/i.test(entry))).toEqual([]);
  });

  it("reports unproven filesystem state when paired-output restoration also fails", async () => {
    const root = await temporaryDirectory("paired-unproven");
    const metadata = metadataForLicenses(LICENSES);
    await generateFixture(root, metadata);
    const target = TARGETS[0]!;
    const artifactPath = resolve(root, target.id, target.file);
    await writeFile(artifactPath, Buffer.concat([await readFile(artifactPath), Buffer.from([0])]));
    let replacements = 0;
    const replaceFile = async (source: string, destination: string) => {
      replacements += 1;
      if (replacements >= 2) throw new Error("deterministic replacement and restoration failure");
      await rename(source, destination);
    };

    await expect(generateNativeLockManifest({ assetsDir: root, metadata, io: { replaceFile } })).rejects.toThrow(/filesystem state is unproven/i);
    expect((await readdir(root)).filter((entry) => /(?:tmp|backup)/i.test(entry))).toEqual([]);
  });

  it("rejects an unsafe fixed-output type before changing its paired output", async () => {
    const root = await temporaryDirectory("paired-preflight-type");
    await writeSixTargetFixture(root);
    const noticesPath = resolve(root, "THIRD_PARTY_NOTICES.txt");
    const priorNotices = Buffer.from("prior notices\n");
    await writeFile(noticesPath, priorNotices);
    await mkdir(resolve(root, "manifest.json"));

    await expect(generateNativeLockManifest({ assetsDir: root, metadata: metadataForLicenses(LICENSES) })).rejects.toThrow(/regular file/i);
    expect(await readFile(noticesPath)).toEqual(priorNotices);
    expect((await readdir(root)).filter((entry) => /(?:tmp|backup)/i.test(entry))).toEqual([]);
  });

  it("rejects local, credentialed, encoded, and unreviewed dependency sources without leaking them", () => {
    const rejectedSources = [
      "git+file:///C:/Users/private/native-lock",
      "registry+file:///home/private/registry",
      "git+https://user:secret@example.invalid/repository",
      "registry+https://example.invalid/C:/Users/private/index",
      "registry+https://example.invalid/%2Fhome%2Fprivate/index",
      "C:\\Users\\private\\dependency",
      "/home/private/dependency",
      "//server/private/dependency",
      "registry+https://example.invalid/unreviewed-index"
    ];
    for (const source of rejectedSources) {
      const metadata = metadataForLicenses(["MIT"]);
      metadata.packages[0]!.source = source;
      let failure: unknown;
      try {
        buildThirdPartyNotices(metadata);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/source policy/i);
      expect((failure as Error).message).not.toContain(source);
      expect((failure as Error).message).not.toMatch(/private|secret/i);
    }
  });

  it("preserves prior outputs when dependency source policy fails", async () => {
    const root = await temporaryDirectory("source-policy-atomic");
    const metadata = metadataForLicenses(LICENSES);
    await generateFixture(root, metadata);
    const manifestPath = resolve(root, "manifest.json");
    const noticesPath = resolve(root, "THIRD_PARTY_NOTICES.txt");
    const priorManifest = await readFile(manifestPath);
    const priorNotices = await readFile(noticesPath);
    metadata.packages[0]!.source = "git+file:///C:/Users/private/dependency";
    await expect(generateNativeLockManifest({ assetsDir: root, metadata })).rejects.toThrow(/source policy/i);
    expect(await readFile(manifestPath)).toEqual(priorManifest);
    expect(await readFile(noticesPath)).toEqual(priorNotices);
  });

  it("rejects a non-root local path dependency instead of labeling it workspace", () => {
    const metadata = metadataForLicenses(["MIT", "Apache-2.0"]);
    metadata.packages[1]!.source = null;
    expect(() => buildThirdPartyNotices(metadata)).toThrow(/source policy/i);
  });

  it("rejects a zero-byte physical artifact before writing outputs", async () => {
    const root = await temporaryDirectory("zero-artifact");
    await writeSixTargetFixture(root);
    const target = TARGETS[0]!;
    await writeFile(resolve(root, target.id, target.file), Buffer.alloc(0));
    await expect(generateNativeLockManifest({ assetsDir: root, metadata: metadataForLicenses(LICENSES) })).rejects.toThrow(/nonempty/i);
    await expect(readFile(resolve(root, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(root, "THIRD_PARTY_NOTICES.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native lock asset validation", () => {
  async function validFixture() {
    const root = await temporaryDirectory("validate");
    const metadata = metadataForLicenses(LICENSES);
    await generateFixture(root, metadata);
    return { root, metadata };
  }

  it("validates exact hashes, byte lengths, binary targets, and regenerated notices", async () => {
    const { root, metadata } = await validFixture();
    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).resolves.toMatchObject({ artifactCount: 6 });
  });

  it.each([
    ["missing target", async (root: string) => rm(resolve(root, "darwin-x64"), { recursive: true })],
    ["extra node", async (root: string) => writeFile(resolve(root, "win32-x64", "extra.node"), binaryFixture("win32", "x64"))],
    ["extra executable", async (root: string) => writeFile(resolve(root, "helper.exe"), "MZ")],
    ["tampered byte", async (root: string) => writeFile(resolve(root, "linux-x64-gnu", "tokengraph-lock.linux-x64.node"), Buffer.from("not ELF"))]
  ])("rejects %s", async (_label, mutate) => {
    const { root, metadata } = await validFixture();
    await mutate(root);
    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).rejects.toThrow();
  });

  it.each([
    ["wrong relative path", (manifest: any) => { manifest.artifacts[0].path = "../escape.node"; }],
    ["duplicate id", (manifest: any) => { manifest.artifacts[1].id = manifest.artifacts[0].id; }],
    ["uppercase hash", (manifest: any) => { manifest.artifacts[0].sha256 = "A".repeat(64); }],
    ["zero bytes", (manifest: any) => { manifest.artifacts[0].bytes = 0; }],
    ["unsafe absolute path", (manifest: any) => { manifest.artifacts[0].path = resolve("absolute.node"); }],
    ["unsupported libc", (manifest: any) => { manifest.artifacts[0].libc = "musl"; }],
    ["ABI mismatch", (manifest: any) => { manifest.addonAbiVersion = 2; }],
    ["schema mismatch", (manifest: any) => { manifest.schemaVersion = 2; }],
    ["extra artifact", (manifest: any) => { manifest.artifacts.push({ ...manifest.artifacts[0], id: "other" }); }]
  ])("rejects manifest %s", async (_label, mutate) => {
    const { root, metadata } = await validFixture();
    const manifestPath = resolve(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    mutate(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).rejects.toThrow();
  });

  it.each([
    ["tampering", (text: string) => text.replace("License: MIT", "License: GPL-3.0-only")],
    ["omission", (text: string) => text.split("\n\n").slice(1).join("\n\n")],
    ["duplication", (text: string) => `${text}${text}`],
    ["order drift", (text: string) => text.split("\n\n").reverse().join("\n\n")]
  ])("rejects notice %s", async (_label, mutate) => {
    const { root, metadata } = await validFixture();
    const noticesPath = resolve(root, "THIRD_PARTY_NOTICES.txt");
    await writeFile(noticesPath, mutate(await readFile(noticesPath, "utf8")));
    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).rejects.toThrow(/notices/i);
  });

  it("rejects linked artifacts", async () => {
    const { root, metadata } = await validFixture();
    const target = TARGETS[0]!;
    const artifact = resolve(root, target.id, target.file);
    const external = await temporaryDirectory("linked-source");
    const real = resolve(external, "real.node");
    await writeFile(real, await readFile(artifact));
    await rm(artifact);
    await symlink(real, artifact, "file");
    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).rejects.toThrow(/link|allowlist|regular/i);
  });

  it("rejects an executable addon mode even when bytes and manifest match", async () => {
    const root = await temporaryDirectory("executable-mode");
    await generateFixture(root);

    await expect(validateNativeLockAssets({
      assetsDir: root,
      metadata: metadataForLicenses(LICENSES),
      runtime: {
        artifactMode: (target: NativeTarget) => target.id === "linux-x64-gnu" ? 0o755 : 0o644
      }
    })).rejects.toThrow(/mode|executable|permission/i);
  });

  it("rejects a wrong-target binary even when its hash and byte length are regenerated", async () => {
    const root = await temporaryDirectory("wrong-target");
    const metadata = metadataForLicenses(LICENSES);
    await writeSixTargetFixture(root);
    const target = TARGETS.find((entry: NativeTarget) => entry.id === "win32-x64")!;
    await writeFile(resolve(root, target.id, target.file), binaryFixture("win32", "arm64"));
    await generateNativeLockManifest({ assetsDir: root, metadata });
    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).rejects.toThrow(/wrong PE architecture/i);
  });

  it.each([
    ["UTF-8 Windows profile", "win32-x64", Buffer.from("C:\\Users\\private-build-user\\.cargo\\registry\\source.rs\0")],
    ["UTF-8 Windows workflow", "win32-x64", Buffer.from("D:\\a\\TokenGraph\\TokenGraph\\native\\lock-addon\\src\\lib.rs\0")],
    ["UTF-8 quoted Windows workflow", "win32-arm64", Buffer.from("\"D:\\a\\TokenGraph\\TokenGraph\\native\\lock-addon\\src\\lib.rs\"\0")],
    ["UTF-8 UNC", "win32-arm64", Buffer.from("\\\\build-server\\share\\cargo\\registry\\source.rs\0")],
    ["UTF-8 forward-slash UNC", "win32-x64", Buffer.from("//build-server/share/cargo/registry/source.rs\0")],
    ["UTF-8 quoted forward-slash UNC", "win32-arm64", Buffer.from("\"//build-server/share/cargo/registry/source.rs\"\0")],
    ["UTF-8 punctuation UNC", "win32-arm64", Buffer.from("\\\\build-server\\#share\\cargo\\registry\\source.rs\0")],
    ["UTF-8 extended UNC", "win32-arm64", Buffer.from("\\\\?\\UNC\\build-server\\share\\cargo\\registry\\source.rs\0")],
    ["UTF-8 punctuation extended UNC", "win32-x64", Buffer.from("\\\\?\\UNC\\build-server\\#share\\cargo\\registry\\source.rs\0")],
    ["UTF-8 drive root", "win32-x64", Buffer.from("C:\\\0")],
    ["UTF-16LE Windows profile", "win32-x64", Buffer.from("C:\\Users\\private-build-user\\.cargo\\registry\\source.rs\0", "utf16le")],
    ["UTF-16LE Windows workflow", "win32-x64", Buffer.from("D:\\a\\TokenGraph\\TokenGraph\\native\\lock-addon\\src\\lib.rs\0", "utf16le")],
    ["UTF-16LE forward-slash UNC", "win32-arm64", Buffer.from("//build-server/#share/cargo/registry/source.rs\0", "utf16le")],
    ["UTF-16LE drive root", "win32-x64", Buffer.from("C:\\\0", "utf16le")],
    ["UTF-8 macOS profile", "darwin-x64", Buffer.from("/Users/private-build-user/.cargo/registry/source.rs\0")],
    ["UTF-8 Linux temporary root", "linux-x64-gnu", Buffer.from("/tmp/private-cargo-home/registry/source.rs\0")],
    ["UTF-8 Linux temporary root only", "linux-arm64-gnu", Buffer.from("/tmp/\0")],
    ["UTF-16LE Linux temporary root only", "linux-x64-gnu", Buffer.from("/tmp/\0", "utf16le")]
  ])("rejects a machine-local %s path in %s even when its hash and byte length are regenerated", async (_kind, targetId, embeddedPath) => {
    const root = await temporaryDirectory("machine-path");
    const metadata = metadataForLicenses(LICENSES);
    await writeSixTargetFixture(root);
    const target = TARGETS.find((entry: NativeTarget) => entry.id === targetId)!;
    const artifactPath = resolve(root, target.id, target.file);
    await writeFile(artifactPath, Buffer.concat([
      binaryFixture(target.platform, target.arch),
      embeddedPath
    ]));
    await generateNativeLockManifest({ assetsDir: root, metadata });

    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).rejects.toThrow(/machine-local|profile path/i);
  });

  it("does not mistake an incomplete Windows verbatim namespace marker for a UNC build path", async () => {
    const root = await temporaryDirectory("verbatim-unc-marker");
    const metadata = metadataForLicenses(LICENSES);
    await writeSixTargetFixture(root);
    const target = TARGETS.find((entry: NativeTarget) => entry.id === "win32-x64")!;
    const artifactPath = resolve(root, target.id, target.file);
    await writeFile(artifactPath, Buffer.concat([
      binaryFixture(target.platform, target.arch),
      Buffer.from("\\\\?\\UNC\\not-a-complete-path\\")
    ]));
    await generateNativeLockManifest({ assetsDir: root, metadata });

    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).resolves.toEqual({
      artifactCount: 6,
      loadedCurrent: false
    });
  });

  it.each([
    ["HTTPS URL", Buffer.from("https://github.com/Mujadarah/TokenGraph\0")],
    ["UTF-16LE HTTPS URL", Buffer.from("https://github.com/Mujadarah/TokenGraph\0", "utf16le")],
    ["embedded double slash", Buffer.from("prefix//server/share/suffix\0")],
    ["file URL", Buffer.from("file:////server/share/suffix\0")]
  ])("does not mistake a %s for a forward-slash UNC build path", async (_kind, embeddedText) => {
    const root = await temporaryDirectory("non-unc-marker");
    const metadata = metadataForLicenses(LICENSES);
    await writeSixTargetFixture(root);
    const target = TARGETS.find((entry: NativeTarget) => entry.id === "linux-arm64-gnu")!;
    const artifactPath = resolve(root, target.id, target.file);
    await writeFile(artifactPath, Buffer.concat([
      binaryFixture(target.platform, target.arch),
      embeddedText
    ]));
    await generateNativeLockManifest({ assetsDir: root, metadata });

    await expect(validateNativeLockAssets({ assetsDir: root, metadata })).resolves.toEqual({
      artifactCount: 6,
      loadedCurrent: false
    });
  });

  it("rejects replacement after the validated byte snapshot", async () => {
    const { root, metadata } = await validFixture();
    const target = TARGETS.find((entry: NativeTarget) => entry.id === "linux-x64-gnu")!;
    const artifactPath = resolve(root, target.id, target.file);
    const replacementRoot = await temporaryDirectory("snapshot-replacement");
    const replacementPath = resolve(replacementRoot, target.file);
    const replacementBytes = Buffer.concat([await readFile(artifactPath), Buffer.from([0])]);
    await writeFile(replacementPath, replacementBytes);
    let replaced = false;

    await expect(validateNativeLockAssets({
      assetsDir: root,
      metadata,
      runtime: {
        afterArtifactSnapshot: async (snapshotTarget: NativeTarget) => {
          if (!replaced && snapshotTarget.id === target.id) {
            try {
              await rename(replacementPath, artifactPath);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(code ?? "")) throw error;
              // Windows keeps the verified handle non-delete-shareable. A
              // same-entry size mutation exercises the same final snapshot
              // identity check without weakening that platform protection.
              await writeFile(artifactPath, replacementBytes);
            }
            replaced = true;
          }
        }
      }
    })).rejects.toThrow(/identity|replaced/i);
    expect(replaced).toBe(true);
  });

  it("loads only the selected current target and checks ABI and implementation", async () => {
    const { root, metadata } = await validFixture();
    const loadModule = vi.fn((_modulePath: string) => ({
      abiVersion: 1,
      implementation: () => "lockfileex",
      tryAcquireAnchor: () => ({})
    }));
    await validateNativeLockAssets({
      assetsDir: root,
      metadata,
      loadCurrent: true,
      runtime: { platform: "win32", arch: "x64", loadModule }
    });
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(loadModule.mock.calls[0]![0]).toBe(resolve(root, "win32-x64", "tokengraph-lock.win32-x64.node"));
  });

  it("rejects a current addon ABI mismatch", async () => {
    const { root, metadata } = await validFixture();
    await expect(validateNativeLockAssets({
      assetsDir: root,
      metadata,
      loadCurrent: true,
      runtime: {
        platform: "win32",
        arch: "x64",
        loadModule: () => ({ abiVersion: 2, implementation: () => "lockfileex", tryAcquireAnchor: () => ({}) })
      }
    })).rejects.toThrow(/ABI/i);
  });

  it.runIf(process.env.TOKENGRAPH_NATIVE_CURRENT_ASSET)("loads and validates the real current-target addon", async () => {
    const root = await temporaryDirectory("real-current");
    const metadata = await readLockedCargoMetadata();
    await writeSixTargetFixture(root);
    const target = TARGETS.find((entry: NativeTarget) => entry.platform === process.platform && entry.arch === process.arch);
    expect(target).toBeDefined();
    const realBytes = await readFile(resolve(process.env.TOKENGRAPH_NATIVE_CURRENT_ASSET!));
    await writeFile(resolve(root, target!.id, target!.file), realBytes);
    await generateNativeLockManifest({ assetsDir: root, metadata });
    const result = spawnSync(process.execPath, [
      resolve(pluginRoot, "scripts", "validate-native-lock-addon.mjs"),
      "--assets", root,
      "--load-current"
    ], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: process.env,
      windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("validated (6 artifacts)");
  });

  it("records lowercase SHA-256 for exact bytes", async () => {
    const root = await temporaryDirectory("hash");
    const manifest = await generateFixture(root);
    const target = TARGETS[0]!;
    const bytes = await readFile(resolve(root, target.id, target.file));
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(manifest.artifacts[0]!.sha256).toBe(expected);
  });
});
