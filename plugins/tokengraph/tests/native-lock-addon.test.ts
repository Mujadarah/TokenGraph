import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeLockError,
  loadNativeLockAddon,
  type NativeLockAddonRuntime,
  type NativeLockErrorCode
} from "../src/core/nativeLockAddon.js";

const TARGETS = [
  { id: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", rustTarget: "aarch64-apple-darwin", file: "tokengraph-lock.darwin-arm64.node", osFloor: "macos-11.0" },
  { id: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", rustTarget: "x86_64-apple-darwin", file: "tokengraph-lock.darwin-x64.node", osFloor: "macos-11.0" },
  { id: "linux-arm64-gnu", platform: "linux", arch: "arm64", libc: "glibc", rustTarget: "aarch64-unknown-linux-gnu", file: "tokengraph-lock.linux-arm64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "linux-x64-gnu", platform: "linux", arch: "x64", libc: "glibc", rustTarget: "x86_64-unknown-linux-gnu", file: "tokengraph-lock.linux-x64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "win32-arm64", platform: "win32", arch: "arm64", libc: "none", rustTarget: "aarch64-pc-windows-msvc", file: "tokengraph-lock.win32-arm64.node", osFloor: "windows-10" },
  { id: "win32-x64", platform: "win32", arch: "x64", libc: "none", rustTarget: "x86_64-pc-windows-msvc", file: "tokengraph-lock.win32-x64.node", osFloor: "windows-10-server-2016" }
] as const;

type Target = (typeof TARGETS)[number];
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(label: string): Promise<string> {
  const physicalTemporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(join(physicalTemporaryDirectory, `tokengraph-native-loader-${label}-`));
  roots.push(root);
  return root;
}

function validRawAddon(implementation: "lockfileex" | "flock" = "lockfileex") {
  return {
    abiVersion: 1,
    implementation: () => implementation,
    tryAcquireAnchor: vi.fn(() => ({
      protectCompatibilityDirectory: vi.fn(),
      releaseCompatibilityDirectory: vi.fn(),
      release: vi.fn()
    }))
  };
}

function expectedImplementation(target: Target): "lockfileex" | "flock" {
  return target.platform === "win32" ? "lockfileex" : "flock";
}

async function makeFixture(options: {
  label?: string;
  selectedId?: Target["id"];
  selectedBytes?: Buffer;
  moduleLayout?: "source" | "dist";
} = {}) {
  const root = await temporaryDirectory(options.label ?? "fixture");
  const assetsRoot = resolve(root, "assets", "native-lock");
  const selectedId = options.selectedId ?? "win32-x64";
  const artifacts = [];
  for (const target of TARGETS) {
    const bytes = target.id === selectedId
      ? (options.selectedBytes ?? Buffer.from(`fixture-${target.id}`))
      : Buffer.from(`fixture-${target.id}`);
    const artifactPath = resolve(assetsRoot, target.id, target.file);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes);
    artifacts.push({
      ...target,
      path: `${target.id}/${target.file}`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  const manifest = {
    schemaVersion: 1,
    addonAbiVersion: 1,
    nodeApiVersion: 9,
    rustToolchain: "1.97.1",
    artifacts
  };
  const manifestPath = resolve(assetsRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const stagingBase = resolve(root, "staging");
  await mkdir(stagingBase, { mode: 0o700 });
  const selected = TARGETS.find((target) => target.id === selectedId)!;
  const selectedPath = resolve(assetsRoot, selected.id, selected.file);
  const modulePath = options.moduleLayout === "source"
    ? resolve(root, "src", "core", "nativeLockAddon.ts")
    : resolve(root, "dist", "index.js");
  return { root, assetsRoot, manifest, manifestPath, selected, selectedPath, modulePath, stagingBase };
}

function fakeRuntime(fixture: Fixture, overrides: Partial<NativeLockAddonRuntime> = {}): NativeLockAddonRuntime {
  const target = fixture.selected;
  return {
    assetsRoot: fixture.assetsRoot,
    tempDirectory: fixture.stagingBase,
    platform: target.platform,
    arch: target.arch,
    ...(target.platform === "linux" ? { glibcVersionRuntime: "2.28" } : {}),
    loadModule: () => validRawAddon(expectedImplementation(target)),
    ...overrides
  };
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

it.runIf(process.platform === "win32")("creates real-addon fixtures beneath the physical temporary directory", async () => {
  const originalTemp = process.env.TEMP;
  const originalTmp = process.env.TMP;
  const outer = await temporaryDirectory("junction-temp");
  const physical = resolve(outer, "physical");
  const alias = resolve(outer, "alias");
  await mkdir(physical);
  await symlink(physical, alias, "junction");
  process.env.TEMP = alias;
  process.env.TMP = alias;
  try {
    const fixture = await makeFixture({ label: "physical-temp" });
    roots.splice(roots.indexOf(fixture.root), 1);
    expect(fixture.root).toBe(await realpath(fixture.root));
  } finally {
    if (originalTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP;
    else process.env.TMP = originalTmp;
  }
});

async function replaceSelectedSource(fixture: Fixture, bytes: Buffer): Promise<void> {
  const replacement = resolve(fixture.root, `replacement-${createHash("sha256").update(bytes).digest("hex")}.node`);
  await writeFile(replacement, bytes);
  await rename(replacement, fixture.selectedPath);
  const artifact = fixture.manifest.artifacts.find((entry) => entry.id === fixture.selected.id)!;
  artifact.bytes = bytes.length;
  artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
}

async function writeStaleStagingRoot(
  fixture: Fixture,
  options: {
    pid: number;
    suffix: string;
    ageSeconds: number;
    pidText?: string;
    subset?: "empty" | "marker-only" | "staged-only" | "marker-and-partial-staged" | "complete";
    unexpectedEntry?: boolean;
    malformedMarker?: boolean;
    linkedAddon?: boolean;
  }
) {
  const root = resolve(fixture.stagingBase, `tokengraph-native-addon-v1-${options.pidText ?? options.pid}-${options.suffix}`);
  await mkdir(root, { mode: 0o700 });
  const bytes = Buffer.from(`stale-${options.pid}-${options.suffix}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const addonFile = `win32-x64-${sha256}.node`;
  const addonPath = resolve(root, addonFile);
  const subset = options.subset ?? "complete";
  if (["staged-only", "marker-and-partial-staged", "complete"].includes(subset)) {
    const stagedBytes = subset === "marker-and-partial-staged" ? bytes.subarray(0, Math.max(1, bytes.length - 3)) : bytes;
    if (options.linkedAddon) {
      const source = resolve(fixture.root, `linked-stale-${options.suffix}.node`);
      await writeFile(source, stagedBytes);
      await link(source, addonPath);
    } else {
      await writeFile(addonPath, stagedBytes, { mode: 0o400 });
    }
    await chmod(addonPath, 0o400);
  }
  const markerPath = resolve(root, "owner.json");
  if (["marker-only", "marker-and-partial-staged", "complete"].includes(subset)) {
    await writeFile(markerPath, options.malformedMarker ? "not-json\n" : `${JSON.stringify({
      schemaVersion: 1,
      pid: options.pid,
      targetId: "win32-x64",
      sha256,
      addonFile
    })}\n`, { mode: 0o400 });
    await chmod(markerPath, 0o400);
  }
  if (options.unexpectedEntry) await writeFile(resolve(root, "unexpected.txt"), "preserve");
  const timestamp = new Date(Date.now() - options.ageSeconds * 1000);
  await utimes(root, timestamp, timestamp);
  return { root, addonPath, markerPath, addonFile, sha256 };
}

async function expectNativeFailure(
  promise: Promise<unknown>,
  code: NativeLockErrorCode,
  forbidden: string[] = []
): Promise<NativeLockError> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativeLockError);
  expect(failure).toMatchObject({ code, retriable: code === "LOCK_BUSY" });
  for (const value of forbidden) expect((failure as Error).message).not.toContain(value);
  return failure as NativeLockError;
}

async function makeStagingResidueWritable(stagingBase: string): Promise<void> {
  for (const rootName of await readdir(stagingBase)) {
    const root = resolve(stagingBase, rootName);
    for (const entryName of await readdir(root).catch(() => [])) {
      await chmod(resolve(root, entryName), 0o600).catch(() => undefined);
    }
    await chmod(root, 0o700).catch(() => undefined);
  }
}

describe("native lock target selection", () => {
  it("selects Linux x64 only for a verified glibc 2.28 runtime", async () => {
    const fixture = await makeFixture({ selectedId: "linux-x64-gnu" });
    const addon = await loadNativeLockAddon(fakeRuntime(fixture));
    expect(addon.targetId).toBe("linux-x64-gnu");
    expect(addon.implementation).toBe("flock");
  });

  it.each([
    ["an absent libc identity", undefined],
    ["a musl identity", "musl"],
    ["glibc below the Node 22 floor", "2.27"],
    ["an unparseable glibc identity", "glibc-2.28"]
  ])("rejects Linux with %s", async (_label, glibcVersionRuntime) => {
    const fixture = await makeFixture({ selectedId: "linux-x64-gnu" });
    await expectNativeFailure(
      loadNativeLockAddon(fakeRuntime(fixture, { glibcVersionRuntime })),
      "ADDON_UNSUPPORTED",
      [fixture.root]
    );
  });

  it("rejects an unsupported architecture without consulting assets", async () => {
    const privateRoot = resolve(await temporaryDirectory("unsupported"), "private-workspace");
    await expectNativeFailure(loadNativeLockAddon({
      assetsRoot: privateRoot,
      platform: "win32",
      arch: "ia32",
      loadModule: () => validRawAddon()
    }), "ADDON_UNSUPPORTED", [privateRoot]);
  });

  it.each(["source", "dist"] as const)("resolves the %s bundled asset layout from the module URL", async (moduleLayout) => {
    const fixture = await makeFixture({ label: moduleLayout, moduleLayout });
    const loadedPaths: string[] = [];
    const addon = await loadNativeLockAddon({
      platform: "win32",
      arch: "x64",
      moduleUrl: pathToFileURL(fixture.modulePath),
      loadModule: (modulePath) => {
        loadedPaths.push(modulePath);
        return validRawAddon();
      }
    });
    expect(addon.targetId).toBe("win32-x64");
    expect(loadedPaths).toHaveLength(1);
    expect(loadedPaths[0]).not.toBe(fixture.selectedPath);
    expect(loadedPaths[0]).toContain(`${fixture.selected.id}-`);
  });
});

describe("native lock package integrity", () => {
  it("reports a missing manifest without exposing its absolute path", async () => {
    const root = await temporaryDirectory("missing-manifest");
    await expectNativeFailure(loadNativeLockAddon({
      assetsRoot: root,
      platform: "win32",
      arch: "x64",
      loadModule: () => validRawAddon()
    }), "ADDON_MISSING", [root, resolve(root, "manifest.json")]);
  });

  it.each([
    ["wrong schema", (manifest: any) => { manifest.schemaVersion = 2; }],
    ["an extra field", (manifest: any) => { manifest.privatePath = "C:\\private\\manifest"; }],
    ["wrong target metadata", (manifest: any) => { manifest.artifacts[5].rustTarget = "wrong-target"; }],
    ["an unsafe relative path", (manifest: any) => { manifest.artifacts[5].path = "../escape.node"; }]
  ])("rejects %s with a privacy-safe integrity error", async (_label, mutate) => {
    const fixture = await makeFixture({ label: "schema" });
    mutate(fixture.manifest);
    await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest)}\n`);
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture)), "ADDON_INTEGRITY", [fixture.root, "C:\\private"]);
  });

  it("rejects a linked addon before loading it", async () => {
    const fixture = await makeFixture({ label: "linked" });
    const external = resolve(fixture.root, "untrusted.node");
    const bytes = await readFile(fixture.selectedPath);
    await writeFile(external, bytes);
    await rm(fixture.selectedPath);
    await link(external, fixture.selectedPath);
    const loadModule = vi.fn(() => validRawAddon());
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, { loadModule })), "ADDON_INTEGRITY", [fixture.root]);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("rejects identity replacement during hashing before loading", async () => {
    const fixture = await makeFixture({ label: "identity" });
    const replacement = resolve(fixture.root, "replacement.node");
    await writeFile(replacement, await readFile(fixture.selectedPath));
    const loadModule = vi.fn(() => validRawAddon());
    let changed = false;
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule,
      afterArtifactRead: async () => {
        if (changed) return;
        changed = true;
        try {
          await rename(replacement, fixture.selectedPath);
        } catch (error) {
          if (!new Set(["EPERM", "EACCES", "EBUSY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await appendFile(fixture.selectedPath, Buffer.from([0]));
        }
      }
    })), "ADDON_INTEGRITY", [fixture.root]);
    expect(changed).toBe(true);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it.each([
    ["byte length", (manifest: any) => { manifest.artifacts[5].bytes += 1; }],
    ["SHA-256", (manifest: any) => { manifest.artifacts[5].sha256 = "0".repeat(64); }]
  ])("rejects a %s mismatch", async (_label, mutate) => {
    const fixture = await makeFixture({ label: "mismatch" });
    mutate(fixture.manifest);
    await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest)}\n`);
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture)), "ADDON_INTEGRITY", [fixture.root]);
  });

  it("rejects an oversized physical addon before reading or loading it", async () => {
    const fixture = await makeFixture({ label: "oversized" });
    await truncate(fixture.selectedPath, 64 * 1024 * 1024 + 1);
    fixture.manifest.artifacts[5].bytes = 64 * 1024 * 1024 + 1;
    await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest)}\n`);
    const loadModule = vi.fn(() => validRawAddon());
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, { loadModule })), "ADDON_INTEGRITY", [fixture.root]);
    expect(loadModule).not.toHaveBeenCalled();
  });
});

describe("private native addon staging and provenance", () => {
  it("loads only a private staged path whose bytes and hash match the verified source", async () => {
    const fixture = await makeFixture({ label: "staged-bytes" });
    const sourceBytes = await readFile(fixture.selectedPath);
    let loadedPath = "";
    let loadedBytes = Buffer.alloc(0);
    await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: (modulePath) => {
        loadedPath = modulePath;
        loadedBytes = readFileSync(modulePath);
        return validRawAddon();
      }
    }));
    expect(loadedPath).not.toBe(fixture.selectedPath);
    expect(dirname(loadedPath)).not.toBe(dirname(fixture.selectedPath));
    expect(loadedBytes).toEqual(sourceBytes);
    expect(createHash("sha256").update(loadedBytes).digest("hex")).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
    expect(await readdir(fixture.stagingBase)).toEqual([]);
  });

  it("loads the verified staged snapshot when the bundled source is swapped before loading", async () => {
    const fixture = await makeFixture({ label: "source-swap" });
    const verifiedBytes = await readFile(fixture.selectedPath);
    const replacementBytes = Buffer.from("replacement-must-not-execute");
    let hookCalled = false;
    let loadedBytes = Buffer.alloc(0);
    await loadNativeLockAddon(fakeRuntime(fixture, {
      beforeStagedLoad: async () => {
        hookCalled = true;
        const replacement = resolve(fixture.root, "swapped-source.node");
        await writeFile(replacement, replacementBytes);
        await rename(replacement, fixture.selectedPath);
      },
      loadModule: (modulePath) => {
        loadedBytes = readFileSync(modulePath);
        return validRawAddon();
      }
    }));
    expect(hookCalled).toBe(true);
    expect(loadedBytes).toEqual(verifiedBytes);
    expect(loadedBytes).not.toEqual(replacementBytes);
  });

  it("detects staged tampering and never calls the loader", async () => {
    const fixture = await makeFixture({ label: "staged-tamper" });
    const loadModule = vi.fn(() => validRawAddon());
    let stagedPath = "";
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, {
      beforeStagedLoad: async (context) => {
        stagedPath = context.stagedPath;
        await appendFile(context.stagedPath, "tamper");
      },
      loadModule
    })), "ADDON_INTEGRITY", [fixture.root]);
    expect(stagedPath).not.toBe("");
    expect(loadModule).not.toHaveBeenCalled();
    expect(await readdir(fixture.stagingBase)).toEqual([]);
  });

  it("isolates successful caches by injected loader provenance", async () => {
    const fixture = await makeFixture({ label: "provenance" });
    const firstLoader = vi.fn(() => validRawAddon());
    const secondLoader = vi.fn(() => validRawAddon());
    const first = await loadNativeLockAddon(fakeRuntime(fixture, { loadModule: firstLoader }));
    const second = await loadNativeLockAddon(fakeRuntime(fixture, { loadModule: secondLoader }));
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });

  it("shares one in-flight load and immutable wrapper for concurrent equal identities", async () => {
    const fixture = await makeFixture({ label: "same-inflight" });
    const loadModule = vi.fn(() => validRawAddon());
    const runtime = fakeRuntime(fixture, { loadModule });
    const [first, second, third] = await Promise.all([
      loadNativeLockAddon(runtime),
      loadNativeLockAddon(runtime),
      loadNativeLockAddon(runtime)
    ]);
    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("retries a transient Windows staging chmod while still requiring read-only files", async () => {
    const fixture = await makeFixture({ label: "transient-staging-chmod" });
    let chmodCalls = 0;
    const stagingIo = {
      makeReadOnly: async (path: string, mode: number) => {
        chmodCalls += 1;
        if (chmodCalls === 1) {
          throw Object.assign(new Error("transient staging chmod"), { code: "EPERM" });
        }
        await chmod(path, mode);
      }
    } as NativeLockAddonRuntime["stagingIo"];

    await expect(loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => validRawAddon(),
      stagingIo
    }))).resolves.toMatchObject({ targetId: "win32-x64" });
    expect(chmodCalls).toBe(3);
  });

  it.each([
    ["persistent Windows-transient", "EPERM", 3],
    ["nontransient", "EIO", 1]
  ])("fails closed after a %s staging chmod error", async (_label, code, expectedCalls) => {
    const fixture = await makeFixture({ label: `failed-staging-chmod-${code.toLowerCase()}` });
    let chmodCalls = 0;
    const stagingIo = {
      makeReadOnly: async () => {
        chmodCalls += 1;
        throw Object.assign(new Error("staging chmod failed"), { code });
      }
    } as NativeLockAddonRuntime["stagingIo"];

    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => validRawAddon(),
      stagingIo
    })), "ADDON_INTEGRITY", [fixture.root]);
    expect(chmodCalls).toBe(expectedCalls);
    expect(await readdir(fixture.stagingBase)).toEqual([]);
  });

  it("fails a concurrent different identity while the original staged load remains valid", async () => {
    const fixture = await makeFixture({ label: "different-inflight" });
    const reachedStage = deferred();
    const releaseLoad = deferred();
    let hookCalls = 0;
    const loadModule = vi.fn(() => validRawAddon());
    const runtime = fakeRuntime(fixture, {
      beforeStagedLoad: async () => {
        hookCalls += 1;
        reachedStage.resolve();
        await releaseLoad.promise;
      },
      loadModule
    });
    const first = loadNativeLockAddon(runtime);
    await Promise.race([
      reachedStage.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("staging hook was not reached")), 500))
    ]);
    await replaceSelectedSource(fixture, Buffer.from("different-inflight-identity"));
    await expectNativeFailure(loadNativeLockAddon(runtime), "ADDON_INTEGRITY", [fixture.root]);
    releaseLoad.resolve();
    await expect(first).resolves.toMatchObject({ targetId: "win32-x64" });
    expect(hookCalls).toBe(1);
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("shares a failed in-flight load, clears it, and permits a clean retry", async () => {
    const fixture = await makeFixture({ label: "failed-inflight" });
    let calls = 0;
    const loadModule = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error(`private failure ${fixture.root}`);
      return validRawAddon();
    });
    const runtime = fakeRuntime(fixture, { loadModule });
    const firstPair = await Promise.allSettled([
      loadNativeLockAddon(runtime),
      loadNativeLockAddon(runtime)
    ]);
    expect(firstPair.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(loadModule).toHaveBeenCalledTimes(1);
    await expect(loadNativeLockAddon(runtime)).resolves.toMatchObject({ targetId: "win32-x64" });
    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it("cleans an exact partial staging root after a pre-success loader failure", async () => {
    const fixture = await makeFixture({ label: "failure-cleanup" });
    let stagedPath = "";
    const failure = await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: (modulePath) => {
        stagedPath = modulePath;
        throw new Error(`loader exposed ${modulePath}`);
      }
    })), "ADDON_ABI", [fixture.root]);
    expect(stagedPath).not.toBe("");
    expect(stagedPath).not.toBe(fixture.selectedPath);
    expect(failure.message).not.toContain(stagedPath);
    expect(await readdir(fixture.stagingBase)).toEqual([]);
  });

  it("permits a new staging load after transient post-dlopen cleanup is fully recovered", async () => {
    const fixture = await makeFixture({ label: "transient-cleanup-recovery" });
    const firstLoader = vi.fn(() => validRawAddon());
    const secondLoader = vi.fn(() => validRawAddon());
    const retryReached = deferred();
    const releaseRetry = deferred();
    const queuedSourceRead = deferred();
    const queuedReachedStage = deferred();
    let unlinkAttempts = 0;
    const firstRuntime = fakeRuntime(fixture, {
      loadModule: firstLoader,
      stagingIo: {
        unlink: async (path) => {
          unlinkAttempts += 1;
          if (unlinkAttempts === 1) {
            throw Object.assign(new Error("transient cleanup block"), { code: "EPERM" });
          }
          if (unlinkAttempts === 2) {
            retryReached.resolve();
            await releaseRetry.promise;
          }
          await unlink(path);
        }
      }
    });

    const firstFailure = expectNativeFailure(loadNativeLockAddon(firstRuntime), "ADDON_INTEGRITY", [fixture.root]);
    await retryReached.promise;
    expect(unlinkAttempts).toBe(2);

    const queued = loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: secondLoader,
      afterArtifactRead: () => { queuedSourceRead.resolve(); },
      beforeStagedLoad: () => { queuedReachedStage.resolve(); }
    }));
    await queuedSourceRead.promise;
    let stagedWhileRetryBlocked = false;
    void queuedReachedStage.promise.then(() => { stagedWhileRetryBlocked = true; });
    for (let turn = 0; turn < 100 && !stagedWhileRetryBlocked; turn += 1) {
      await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    }
    const reachedStageWhileRetryBlocked = stagedWhileRetryBlocked;
    const queuedLoaderCallsWhileRetryBlocked = secondLoader.mock.calls.length;
    const rootsWhileRetryBlocked = await readdir(fixture.stagingBase);

    releaseRetry.resolve();
    await firstFailure;
    await expect(queued).resolves.toMatchObject({ targetId: "win32-x64" });
    expect(reachedStageWhileRetryBlocked).toBe(false);
    expect(queuedLoaderCallsWhileRetryBlocked).toBe(0);
    expect(rootsWhileRetryBlocked).toHaveLength(1);
    expect(unlinkAttempts).toBeGreaterThanOrEqual(2);
    expect(await readdir(fixture.stagingBase)).toEqual([]);
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).toHaveBeenCalledTimes(1);
  });

  it("poisons the shared staging slot when cleanup is unproven before dlopen", async () => {
    const fixture = await makeFixture({ label: "poison-before-dlopen" });
    const loadModule = vi.fn(() => validRawAddon());
    const runtime = fakeRuntime(fixture, {
      beforeStagedLoad: () => { throw new Error("pre-dlopen failure"); },
      loadModule,
      stagingIo: {
        unlink: async () => { throw Object.assign(new Error("cleanup blocked"), { code: "EPERM" }); }
      }
    });
    try {
      await expectNativeFailure(loadNativeLockAddon(runtime), "ADDON_INTEGRITY", [fixture.root]);
      await expectNativeFailure(loadNativeLockAddon(runtime), "ADDON_INTEGRITY", [fixture.root]);
      const otherLoader = vi.fn(() => validRawAddon());
      await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, { loadModule: otherLoader })), "ADDON_INTEGRITY", [fixture.root]);
      expect(loadModule).not.toHaveBeenCalled();
      expect(otherLoader).not.toHaveBeenCalled();
      expect(await readdir(fixture.stagingBase)).toHaveLength(1);
    } finally {
      await makeStagingResidueWritable(fixture.stagingBase);
    }
  });

  it("poisons the shared staging slot when cleanup is unproven after dlopen", async () => {
    const fixture = await makeFixture({ label: "poison-after-dlopen" });
    const loadModule = vi.fn(() => validRawAddon());
    const runtime = fakeRuntime(fixture, {
      loadModule,
      stagingIo: {
        unlink: async () => { throw Object.assign(new Error("cleanup blocked"), { code: "EPERM" }); }
      }
    });
    try {
      await expectNativeFailure(loadNativeLockAddon(runtime), "ADDON_INTEGRITY", [fixture.root]);
      await expectNativeFailure(loadNativeLockAddon(runtime), "ADDON_INTEGRITY", [fixture.root]);
      expect(loadModule).toHaveBeenCalledTimes(1);
      expect(await readdir(fixture.stagingBase)).toHaveLength(1);
    } finally {
      await makeStagingResidueWritable(fixture.stagingBase);
    }
  });
});

describe("bounded stale native staging cleanup", () => {
  it("shares the first stale sweep across loader provenances before either can stage", async () => {
    const fixture = await makeFixture({ label: "shared-sweep" });
    await writeStaleStagingRoot(fixture, { pid: 19_999, suffix: "sweep1", ageSeconds: 3_000 });
    const reachedCleanup = deferred();
    const releaseCleanup = deferred();
    const firstLoader = vi.fn(() => validRawAddon());
    const secondLoader = vi.fn(() => validRawAddon());
    const probeProcess = () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); };
    const first = loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: firstLoader,
      probeProcess,
      beforeStaleCleanup: async () => {
        reachedCleanup.resolve();
        await releaseCleanup.promise;
      }
    }));
    await reachedCleanup.promise;
    const second = loadNativeLockAddon(fakeRuntime(fixture, { loadModule: secondLoader, probeProcess }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(firstLoader).not.toHaveBeenCalled();
    expect(secondLoader).not.toHaveBeenCalled();
    releaseCleanup.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).toHaveBeenCalledTimes(1);
  });

  it("reclaims every exact dead-owner crash-safe subset and partial-cleanup residue", async () => {
    const fixture = await makeFixture({ label: "stale-subsets" });
    const candidates = [
      await writeStaleStagingRoot(fixture, { pid: 19_101, suffix: "empty1", ageSeconds: 1_000, subset: "empty" }),
      await writeStaleStagingRoot(fixture, { pid: 19_102, suffix: "marker", ageSeconds: 900, subset: "marker-only" }),
      await writeStaleStagingRoot(fixture, { pid: 19_103, suffix: "staged", ageSeconds: 800, subset: "staged-only" }),
      await writeStaleStagingRoot(fixture, { pid: 19_104, suffix: "partia", ageSeconds: 700, subset: "marker-and-partial-staged" }),
      await writeStaleStagingRoot(fixture, { pid: 19_105, suffix: "residu", ageSeconds: 600 })
    ];
    await unlink(candidates[4]!.addonPath);
    const probeProcess = vi.fn(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });

    await loadNativeLockAddon(fakeRuntime(fixture, { probeProcess }));

    expect(probeProcess).toHaveBeenCalledTimes(candidates.length);
    expect(await readdir(fixture.stagingBase)).toEqual([]);
  });

  it("preserves a zero-padded noncanonical PID root without probing it", async () => {
    const fixture = await makeFixture({ label: "stale-zero-pid" });
    const candidate = await writeStaleStagingRoot(fixture, {
      pid: 19_201,
      pidText: "00019201",
      suffix: "zeropd",
      ageSeconds: 1_000
    });
    const probeProcess = vi.fn(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });

    await loadNativeLockAddon(fakeRuntime(fixture, { probeProcess }));

    expect(probeProcess).not.toHaveBeenCalled();
    expect((await lstat(candidate.root)).isDirectory()).toBe(true);
  });

  it.runIf(process.platform === "win32")("normalizes only validated dead-owner readonly entries before stale unlink", async () => {
    const fixture = await makeFixture({ label: "stale-readonly" });
    const candidate = await writeStaleStagingRoot(fixture, { pid: 19_301, suffix: "rdonly", ageSeconds: 1_000 });
    const normalized = new Set<string>();
    const stagingIo = {
      chmod: async (path: string, mode: number) => {
        normalized.add(path);
        await chmod(path, mode);
      },
      unlink: async (path: string) => {
        if ((path === candidate.addonPath || path === candidate.markerPath) && !normalized.has(path)) {
          throw Object.assign(new Error("readonly"), { code: "EPERM" });
        }
        await unlink(path);
      }
    } as NativeLockAddonRuntime["stagingIo"];

    await loadNativeLockAddon(fakeRuntime(fixture, {
      probeProcess: () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); },
      stagingIo
    }));

    expect(normalized).toEqual(new Set([candidate.addonPath, candidate.markerPath]));
    expect(await readdir(fixture.stagingBase)).toEqual([]);
  });

  it("examines only the 32 oldest exact safe dead-PID roots", async () => {
    const fixture = await makeFixture({ label: "stale-bound" });
    const roots = [];
    for (let index = 0; index < 34; index += 1) {
      roots.push(await writeStaleStagingRoot(fixture, {
        pid: 20_000 + index,
        suffix: index.toString().padStart(6, "0"),
        ageSeconds: 2_000 - index
      }));
    }
    const probeProcess = vi.fn((pid: number) => {
      throw Object.assign(new Error(`dead private pid ${pid}`), { code: "ESRCH" });
    });
    await loadNativeLockAddon(fakeRuntime(fixture, { probeProcess }));
    expect(probeProcess).toHaveBeenCalledTimes(32);
    expect((await readdir(fixture.stagingBase)).sort()).toEqual([
      roots[32]!.root.split(/[\\/]/u).at(-1),
      roots[33]!.root.split(/[\\/]/u).at(-1)
    ].sort());
  });

  it("preserves alive, indeterminate, malformed, unexpected, linked, replaced, and sharing-blocked roots", async () => {
    const fixture = await makeFixture({ label: "stale-preserve" });
    const alive = await writeStaleStagingRoot(fixture, { pid: 31_001, suffix: "alive1", ageSeconds: 900 });
    const denied = await writeStaleStagingRoot(fixture, { pid: 31_002, suffix: "denied", ageSeconds: 800 });
    const indeterminate = await writeStaleStagingRoot(fixture, { pid: 31_003, suffix: "indetr", ageSeconds: 700 });
    const malformed = await writeStaleStagingRoot(fixture, { pid: 31_004, suffix: "malfrm", ageSeconds: 600, malformedMarker: true });
    const unexpected = await writeStaleStagingRoot(fixture, { pid: 31_005, suffix: "unexpt", ageSeconds: 500, unexpectedEntry: true });
    const linked = await writeStaleStagingRoot(fixture, { pid: 31_006, suffix: "linked", ageSeconds: 400, linkedAddon: true });
    const replaced = await writeStaleStagingRoot(fixture, { pid: 31_007, suffix: "replac", ageSeconds: 300 });
    const sharing = await writeStaleStagingRoot(fixture, { pid: 31_008, suffix: "sharin", ageSeconds: 200 });
    let replacementInjected = false;
    const probedPids: number[] = [];
    const probeProcess = (pid: number) => {
      probedPids.push(pid);
      if (pid === 31_001) return;
      if (pid === 31_002) throw Object.assign(new Error(`private denied pid ${pid}`), { code: "EPERM" });
      if (pid === 31_003) throw Object.assign(new Error(`private unknown pid ${pid}`), { code: "EINVAL" });
      throw Object.assign(new Error(`dead pid ${pid}`), { code: "ESRCH" });
    };
    await loadNativeLockAddon(fakeRuntime(fixture, {
      probeProcess,
      beforeStaleCleanup: async (context) => {
        if (context.root === replaced.root && !replacementInjected) {
          replacementInjected = true;
          await appendFile(replaced.addonPath, "replacement");
        }
      },
      stagingIo: {
        unlink: async (path) => {
          if (path === sharing.addonPath) throw Object.assign(new Error(`sharing private ${path}`), { code: "EPERM" });
          await unlink(path);
        }
      }
    }));
    expect(replacementInjected).toBe(true);
    expect(probedPids).toEqual(expect.arrayContaining([31_001, 31_002, 31_003, 31_007, 31_008]));
    for (const candidate of [alive, denied, indeterminate, malformed, unexpected, linked, replaced, sharing]) {
      expect((await lstat(candidate.root)).isDirectory()).toBe(true);
    }
  });
});

describe("native lock addon ABI and lifecycle", () => {
  it.each([
    ["ABI mismatch", () => ({ ...validRawAddon(), abiVersion: 2 })],
    ["wrong implementation", () => validRawAddon("flock")],
    ["missing acquisition export", () => ({ abiVersion: 1, implementation: () => "lockfileex" })]
  ])("rejects %s without leaking module details", async (_label, rawAddon) => {
    const fixture = await makeFixture({ label: "abi" });
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, { loadModule: rawAddon })), "ADDON_ABI", [fixture.root]);
  });

  it("converts a loader throw into a stable privacy-safe error", async () => {
    const fixture = await makeFixture({ label: "loader-throw" });
    const raw = `load failed for ${fixture.selectedPath} with raw OS error 193`;
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => { throw new Error(raw); }
    })), "ADDON_ABI", [fixture.root, raw, "193"]);
  });

  it.runIf(process.platform === "win32")("preserves the original ABI error when a loaded staged DLL is sharing-blocked", async () => {
    const fixture = await makeFixture({ label: "production-abi-sharing" });
    let stagedPath = "";
    let moduleHolder: NodeModule | undefined;
    let isRetained: ((candidate: object) => boolean) | undefined;
    const dlopen = vi.spyOn(process, "dlopen").mockImplementation((holder: object) => {
      moduleHolder = holder as NodeModule;
      moduleHolder.exports = { ...validRawAddon(), abiVersion: 2 };
    });
    try {
      await expectNativeFailure(loadNativeLockAddon({
        assetsRoot: fixture.assetsRoot,
        tempDirectory: fixture.stagingBase,
        platform: "win32",
        arch: "x64",
        beforeStagedLoad: (context) => { stagedPath = context.stagedPath; },
        inspectProductionRetention: (retentionProbe) => { isRetained = retentionProbe; },
        stagingIo: {
          unlink: async (path) => {
            if (path === stagedPath) throw Object.assign(new Error("mapped"), { code: "EPERM" });
            await unlink(path);
          }
        }
      }), "ADDON_ABI", [fixture.root]);
      expect(moduleHolder).toBeDefined();
      expect(isRetained?.(moduleHolder!)).toBe(true);
      expect(stagedPath).not.toBe("");
      expect((await readdir(dirname(stagedPath))).sort()).toEqual([
        "owner.json",
        stagedPath.split(/[\\/]/u).at(-1)
      ].sort());
    } finally {
      dlopen.mockRestore();
      if (stagedPath !== "") {
        await chmod(stagedPath, 0o600).catch(() => undefined);
        await chmod(resolve(dirname(stagedPath), "owner.json"), 0o600).catch(() => undefined);
      }
    }
  });

  it.runIf(process.platform === "win32")("retains the exact production holder and synchronous cleanup preserves a later hardlink", async () => {
    const fixture = await makeFixture({ label: "production-holder-hardlink" });
    let stagedPath = "";
    let moduleHolder: NodeModule | undefined;
    let exitCleanup: NodeJS.ExitListener | undefined;
    const originalOnce = process.once.bind(process);
    const once = vi.spyOn(process, "once").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "exit") {
        exitCleanup = listener as NodeJS.ExitListener;
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once);
    const dlopen = vi.spyOn(process, "dlopen").mockImplementation((holder: object) => {
      moduleHolder = holder as NodeModule;
      moduleHolder.exports = validRawAddon();
    });
    try {
      await expect(loadNativeLockAddon({
        assetsRoot: fixture.assetsRoot,
        tempDirectory: fixture.stagingBase,
        platform: "win32",
        arch: "x64",
        beforeStagedLoad: (context) => { stagedPath = context.stagedPath; },
        stagingIo: {
          unlink: async (path) => {
            if (path === stagedPath) throw Object.assign(new Error("mapped"), { code: "EPERM" });
            await unlink(path);
          }
        }
      })).resolves.toMatchObject({ targetId: "win32-x64" });
      expect(moduleHolder).toBeDefined();
      expect(exitCleanup).toBeTypeOf("function");
      const externalHardlink = resolve(fixture.root, "retained-hardlink.node");
      await link(stagedPath, externalHardlink);

      exitCleanup!(0);

      expect((await lstat(stagedPath)).nlink).toBe(2);
      expect((await readdir(dirname(stagedPath))).sort()).toEqual([
        "owner.json",
        stagedPath.split(/[\\/]/u).at(-1)
      ].sort());
    } finally {
      once.mockRestore();
      dlopen.mockRestore();
      if (stagedPath !== "") {
        await chmod(stagedPath, 0o600).catch(() => undefined);
        await chmod(resolve(dirname(stagedPath), "owner.json"), 0o600).catch(() => undefined);
      }
    }
  });

  it("rejects accessor-backed addon exports without invoking getters", async () => {
    const fixture = await makeFixture({ label: "addon-getters" });
    let getters = 0;
    const rawAddon = {};
    for (const property of ["abiVersion", "implementation", "tryAcquireAnchor"]) {
      Object.defineProperty(rawAddon, property, {
        enumerable: true,
        get: () => {
          getters += 1;
          return property === "abiVersion" ? 1 : vi.fn();
        }
      });
    }
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, { loadModule: () => rawAddon })), "ADDON_ABI");
    expect(getters).toBe(0);
  });

  it("rejects inherited addon exports", async () => {
    const fixture = await makeFixture({ label: "addon-inherited" });
    const rawAddon = Object.create(validRawAddon());
    await expectNativeFailure(loadNativeLockAddon(fakeRuntime(fixture, { loadModule: () => rawAddon })), "ADDON_ABI");
  });

  it.each([
    ["LOCK_BUSY", "LOCK_BUSY", true],
    ["UNSAFE_ANCHOR", "UNSAFE_ANCHOR", false],
    ["unknown native failure", "UNEXPECTED_NATIVE_CODE", false]
  ] as const)("normalizes %s with exact retriability", async (_label, rawCode, retriable) => {
    const fixture = await makeFixture({ label: `native-${rawCode}` });
    const privateMessage = `${rawCode}: raw C:\\private\\anchor.lock pid=4312`;
    const addon = await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => ({
        ...validRawAddon(),
        tryAcquireAnchor: () => { throw Object.assign(new Error(privateMessage), { code: rawCode }); }
      })
    }));
    let failure: unknown;
    try {
      addon.tryAcquireAnchor("C:\\private\\anchor.lock");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NativeLockError);
    expect(failure).toMatchObject({
      code: rawCode === "UNSAFE_ANCHOR" ? "UNSAFE_ANCHOR" : rawCode === "LOCK_BUSY" ? "LOCK_BUSY" : "NATIVE_LOCK_ERROR",
      retriable
    });
    expect((failure as Error).message).not.toMatch(/private|4312|raw/i);
  });

  it("validates and wraps all handle lifecycle methods", async () => {
    const fixture = await makeFixture({ label: "handle" });
    const protectCompatibilityDirectory = vi.fn();
    const releaseCompatibilityDirectory = vi.fn();
    const release = vi.fn();
    const addon = await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => ({
        ...validRawAddon(),
        tryAcquireAnchor: () => ({ protectCompatibilityDirectory, releaseCompatibilityDirectory, release })
      })
    }));
    const handle = addon.tryAcquireAnchor("anchor.lock");
    handle.protectCompatibilityDirectory("compatibility.lock");
    handle.releaseCompatibilityDirectory();
    handle.release();
    expect(protectCompatibilityDirectory).toHaveBeenCalledWith("compatibility.lock");
    expect(releaseCompatibilityDirectory).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(addon)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
  });

  it("rejects an incomplete native handle", async () => {
    const fixture = await makeFixture({ label: "bad-handle" });
    const addon = await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => ({ ...validRawAddon(), tryAcquireAnchor: () => ({ release: () => undefined }) })
    }));
    let failure: unknown;
    try {
      addon.tryAcquireAnchor("anchor.lock");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NativeLockError);
    expect(failure).toMatchObject({ code: "NATIVE_LOCK_ERROR", retriable: false });
  });

  it("rejects accessor-backed handle methods without invoking getters", async () => {
    const fixture = await makeFixture({ label: "handle-getters" });
    let getters = 0;
    const rawHandle = {
      protectCompatibilityDirectory: vi.fn(),
      releaseCompatibilityDirectory: vi.fn()
    };
    Object.defineProperty(rawHandle, "release", {
      get: () => {
        getters += 1;
        return vi.fn();
      }
    });
    const addon = await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => ({ ...validRawAddon(), tryAcquireAnchor: () => rawHandle })
    }));
    expect(() => addon.tryAcquireAnchor("anchor.lock")).toThrow(NativeLockError);
    expect(getters).toBe(0);
  });

  it("resolves prototype data methods and invokes them with the native receiver", async () => {
    const fixture = await makeFixture({ label: "handle-receiver" });
    class RawHandle {
      calls: string[] = [];
      protectCompatibilityDirectory(lockPath: string) { this.calls.push(`protect:${lockPath}`); }
      releaseCompatibilityDirectory() { this.calls.push("compat-release"); }
      release() { this.calls.push("release"); }
    }
    const rawHandle = new RawHandle();
    const addon = await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => ({ ...validRawAddon(), tryAcquireAnchor: () => rawHandle })
    }));
    const handle = addon.tryAcquireAnchor("anchor.lock");
    handle.protectCompatibilityDirectory("compatibility.lock");
    handle.releaseCompatibilityDirectory();
    handle.release();
    expect(rawHandle.calls).toEqual(["protect:compatibility.lock", "compat-release", "release"]);
  });

  it("inspects native error fields without invoking accessors", async () => {
    const fixture = await makeFixture({ label: "error-getters" });
    let getters = 0;
    const nativeFailure = {};
    for (const property of ["code", "reason", "message"]) {
      Object.defineProperty(nativeFailure, property, {
        get: () => {
          getters += 1;
          return "LOCK_BUSY: private path pid=4412";
        }
      });
    }
    const addon = await loadNativeLockAddon(fakeRuntime(fixture, {
      loadModule: () => ({
        ...validRawAddon(),
        tryAcquireAnchor: () => { throw nativeFailure; }
      })
    }));
    let failure: unknown;
    try {
      addon.tryAcquireAnchor("C:\\private\\anchor.lock");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "NATIVE_LOCK_ERROR", retriable: false });
    expect((failure as Error).message).not.toMatch(/private|4412/i);
    expect(getters).toBe(0);
  });

  it("reuses only the same validated identity and never masks replacement", async () => {
    const fixture = await makeFixture({ label: "cache" });
    const loadModule = vi.fn(() => validRawAddon());
    const runtime = fakeRuntime(fixture, { loadModule });
    const first = await loadNativeLockAddon(runtime);
    const second = await loadNativeLockAddon(runtime);
    expect(second).toBe(first);
    expect(loadModule).toHaveBeenCalledTimes(1);

    const replacement = resolve(fixture.root, "cached-replacement.node");
    await writeFile(replacement, await readFile(fixture.selectedPath));
    await rename(replacement, fixture.selectedPath);
    await expectNativeFailure(loadNativeLockAddon(runtime), "ADDON_INTEGRITY", [fixture.root]);
    expect(loadModule).toHaveBeenCalledTimes(1);
  });
});

it.runIf(process.env.TOKENGRAPH_NATIVE_CURRENT_ASSET)("loads the real addon and proves acquire, busy, release, and reacquire", async () => {
  const realAsset = resolve(process.env.TOKENGRAPH_NATIVE_CURRENT_ASSET!);
  const currentTarget = TARGETS.find((target) => target.platform === process.platform && target.arch === process.arch);
  expect(currentTarget).toBeDefined();
  if (currentTarget === undefined) throw new Error("The current native target is unsupported.");
  const glibcVersionRuntime = currentTarget.platform === "linux"
    ? (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header?.glibcVersionRuntime
    : undefined;
  if (currentTarget.platform === "linux" && typeof glibcVersionRuntime !== "string") {
    throw new Error("The current Linux glibc runtime version is unavailable.");
  }
  const fixture = await makeFixture({
    label: "real-addon",
    selectedId: currentTarget.id,
    selectedBytes: await readFile(realAsset)
  });
  // Windows retains a loaded DLL until this Vitest process exits. The
  // controller removes this exact task fixture after the process completes.
  if (process.platform === "win32") roots.splice(roots.indexOf(fixture.root), 1);
  const injectedLoader = vi.fn(() => validRawAddon(expectedImplementation(currentTarget)));
  await loadNativeLockAddon(fakeRuntime(fixture, { loadModule: injectedLoader }));
  expect(injectedLoader).toHaveBeenCalledTimes(1);
  const require = createRequire(import.meta.url);
  require.cache[fixture.selectedPath] = {
    id: fixture.selectedPath,
    filename: fixture.selectedPath,
    loaded: true,
    exports: validRawAddon(),
    children: [],
    paths: []
  } as unknown as NodeModule;
  let addon: Awaited<ReturnType<typeof loadNativeLockAddon>>;
  try {
    addon = await loadNativeLockAddon({
      assetsRoot: fixture.assetsRoot,
      tempDirectory: fixture.stagingBase,
      platform: currentTarget.platform,
      arch: currentTarget.arch,
      ...(currentTarget.platform === "linux" ? {
        glibcVersionRuntime: glibcVersionRuntime as string
      } : {})
    });
  } finally {
    delete require.cache[fixture.selectedPath];
  }
  const retainedRoots = await readdir(fixture.stagingBase);
  if (process.platform === "win32") {
    expect(retainedRoots).toHaveLength(1);
    const retainedRoot = resolve(fixture.stagingBase, retainedRoots[0]!);
    const retainedEntries = (await readdir(retainedRoot)).sort();
    expect(retainedEntries).toHaveLength(2);
    expect(retainedEntries).toContain("owner.json");
    const stagedName = retainedEntries.find((entry) => entry.endsWith(".node"));
    expect(stagedName).toMatch(new RegExp(`^${currentTarget.id}-[0-9a-f]{64}\\.node$`, "u"));
    expect(await readFile(resolve(retainedRoot, stagedName!))).toEqual(await readFile(realAsset));
  } else {
    expect(retainedRoots).toEqual([]);
  }
  const anchorDirectory = resolve(fixture.root, "anchor-domain");
  const anchorPath = resolve(anchorDirectory, "anchor.lock");
  await mkdir(anchorDirectory);

  const first = addon.tryAcquireAnchor(anchorPath);
  let busy: unknown;
  try {
    addon.tryAcquireAnchor(anchorPath);
  } catch (error) {
    busy = error;
  }
  expect(busy).toBeInstanceOf(NativeLockError);
  expect(busy).toMatchObject({ code: "LOCK_BUSY", retriable: true });
  first.release();
  const second = addon.tryAcquireAnchor(anchorPath);
  second.release();
});
