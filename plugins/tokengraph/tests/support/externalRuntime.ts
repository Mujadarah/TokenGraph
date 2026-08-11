import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const HARNESS_PREFIX = "tokengraph-native-test-v2-";
const MANIFEST_NAME = "harness-state.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;

interface IdentityRecord {
  path: string;
  identity: string;
}

interface HarnessState {
  schemaVersion: 1;
  root: IdentityRecord;
  children: {
    build: IdentityRecord;
    runtime: IdentityRecord;
    assets: IdentityRecord;
    staging: IdentityRecord;
  };
  trees: {
    runtime: Record<string, string>;
    assets: Record<string, string>;
  };
}

function exactKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) throw new Error(`${label} fields are invalid.`);
}

function identityOf(stats: Awaited<ReturnType<typeof lstat>>): string {
  const bigintStats = stats as unknown as { dev: bigint; ino: bigint; birthtimeNs: bigint };
  return `${bigintStats.dev}:${bigintStats.ino}:${bigintStats.birthtimeNs}`;
}

async function verifyDirectory(record: IdentityRecord, expectedPath: string, label: string): Promise<void> {
  if (record && typeof record === "object") exactKeys(record, ["path", "identity"], label);
  if (!record || exactString(record.path) !== expectedPath || typeof record.identity !== "string") throw new Error(`${label} record is invalid.`);
  const stats = await lstat(expectedPath, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || identityOf(stats) !== record.identity || await realpath(expectedPath) !== expectedPath) {
    throw new Error(`${label} identity is invalid.`);
  }
}

function exactString(value: unknown): string | undefined {
  return typeof value === "string" && resolve(value) === value && !value.includes("\0") ? value : undefined;
}

async function readOwnedManifest(path: string): Promise<HarnessState> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_MANIFEST_BYTES)) {
    throw new Error("Native lock harness manifest is unsafe.");
  }
  const handle = await open(path, constants.O_RDONLY);
  let text: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (identityOf(opened) !== identityOf(before)) throw new Error("Native lock harness manifest identity changed before read.");
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(path, { bigint: true });
  if (identityOf(after) !== identityOf(before)) throw new Error("Native lock harness manifest identity changed after read.");
  const state = JSON.parse(text) as HarnessState;
  exactKeys(state, ["schemaVersion", "root", "children", "trees"], "Native lock harness manifest");
  if (state.schemaVersion !== 1 || !state.root || !state.children || !state.trees) throw new Error("Native lock harness manifest schema is invalid.");
  exactKeys(state.root, ["path", "identity"], "Native lock harness root");
  exactKeys(state.children, ["build", "runtime", "assets", "staging"], "Native lock harness children");
  exactKeys(state.trees, ["runtime", "assets"], "Native lock harness trees");
  return state;
}

async function treeHashes(directory: string): Promise<Record<string, string>> {
  const result: Array<[string, string]> = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      const before = await lstat(path, { bigint: true });
      if (before.isSymbolicLink()) throw new Error("Native lock harness tree contains a link.");
      if (before.isDirectory()) {
        result.push([`${relativePath}/`, "directory"]);
        await walk(path, relativePath);
        const afterDirectory = await lstat(path, { bigint: true });
        if (identityOf(afterDirectory) !== identityOf(before)) throw new Error("Native lock harness directory identity changed.");
        continue;
      }
      if (!before.isFile() || before.nlink !== 1n) throw new Error("Native lock harness tree contains an unsafe entry.");
      const handle = await open(path, constants.O_RDONLY);
      let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true });
        if (identityOf(opened) !== identityOf(before)) throw new Error("Native lock harness file identity changed before read.");
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const afterFile = await lstat(path, { bigint: true });
      if (identityOf(afterFile) !== identityOf(before)) throw new Error("Native lock harness file identity changed after read.");
      result.push([relativePath, `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`]);
    }
  }
  await walk(directory, "");
  return Object.fromEntries(result);
}

function equalTree(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length && actualEntries.every(([path, hash]) => expected[path] === hash);
}

function treeDifference(actual: Record<string, string>, expected: Record<string, string>): string {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .sort()
    .filter((path) => actual[path] !== expected[path])
    .slice(0, 16)
    .map((path) => `${path}:${actual[path] === undefined ? "missing" : expected[path] === undefined ? "extra" : "changed"}`)
    .join(",");
}

async function verifyTrees(state: HarnessState): Promise<void> {
  const [runtime, assets] = await Promise.all([treeHashes(state.children.runtime.path), treeHashes(state.children.assets.path)]);
  if (!equalTree(runtime, state.trees.runtime)) {
    throw new Error(`Native lock harness runtime bytes differ from the identity record: ${treeDifference(runtime, state.trees.runtime)}`);
  }
  if (!equalTree(assets, state.trees.assets)) {
    throw new Error(`Native lock harness asset bytes differ from the identity record: ${treeDifference(assets, state.trees.assets)}`);
  }
}

let verifiedState: Promise<HarnessState> | undefined;

export function loadHarnessState(): Promise<HarnessState> {
  verifiedState ??= (async () => {
    const manifestValue = process.env.TOKENGRAPH_TEST_HARNESS_MANIFEST;
    const manifestPath = exactString(manifestValue);
    if (!manifestPath || basename(manifestPath) !== MANIFEST_NAME || basename(dirname(manifestPath)) !== "build") {
      throw new Error("Native lock test harness manifest is unavailable.");
    }
    const state = await readOwnedManifest(manifestPath);
    const rootPath = exactString(state.root.path);
    if (!rootPath || dirname(dirname(manifestPath)) !== rootPath || !basename(rootPath).startsWith(HARNESS_PREFIX)) {
      throw new Error("Native lock test harness root is invalid.");
    }
    await verifyDirectory(state.root, rootPath, "Native lock harness root");
    for (const name of ["build", "runtime", "assets", "staging"] as const) {
      await verifyDirectory(state.children[name], join(rootPath, name), `Native lock harness ${name}`);
    }
    if (manifestPath !== join(state.children.build.path, MANIFEST_NAME)) throw new Error("Native lock harness manifest path is invalid.");
    const rootEntries = (await readdir(rootPath)).sort();
    if (rootEntries.join("\0") !== ["assets", "build", "runtime", "staging"].join("\0")) throw new Error("Native lock harness root layout is invalid.");
    if (process.env.TOKENGRAPH_TEST_RUNTIME_ROOT !== state.children.runtime.path ||
        process.env.TOKENGRAPH_TEST_NATIVE_ASSETS !== state.children.assets.path ||
        process.env.TOKENGRAPH_TEST_NATIVE_STAGING !== state.children.staging.path ||
        process.env.TEMP !== state.children.staging.path || process.env.TMP !== state.children.staging.path || process.env.TMPDIR !== state.children.staging.path) {
      throw new Error("Native lock harness environment paths are inconsistent.");
    }
    await verifyTrees(state);
    return state;
  })();
  return verifiedState;
}

const harness = await loadHarnessState();

export async function verifyExternalRuntimeTrees(): Promise<void> {
  await verifyTrees(harness);
}

export interface ExternalPluginMirror {
  readonly root: string;
  readonly serverEntry: string;
  readonly hooksEntry: string;
}

async function copyExactTree(source: string, destination: string, createDestination = true): Promise<void> {
  if (createDestination) await mkdir(destination, { mode: 0o700 });
  for (const name of (await readdir(source)).sort()) {
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    const stats = await lstat(sourcePath, { bigint: true });
    if (stats.isSymbolicLink()) throw new Error("External plugin mirror source contains a link.");
    if (stats.isDirectory()) {
      await copyExactTree(sourcePath, destinationPath);
      continue;
    }
    if (!stats.isFile() || stats.nlink !== 1n) throw new Error("External plugin mirror source contains an unsafe entry.");
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  }
}

export async function createExternalPluginMirror(sourcePluginRoot: string): Promise<ExternalPluginMirror> {
  await verifyExternalRuntimeTrees();
  const sourceRoot = await realpath(sourcePluginRoot);
  const mirrorRoot = await mkdtemp(join(tmpdir(), "tokengraph-external-plugin-"));
  await copyExactTree(externalRuntimeRoot, mirrorRoot, false);
  const copiedRuntime = await treeHashes(mirrorRoot);
  const expectedRuntime = await treeHashes(externalRuntimeRoot);
  if (!equalTree(copiedRuntime, expectedRuntime)) throw new Error("External plugin mirror runtime copy is incomplete.");

  for (const relativePath of [
    [".codex-plugin", "plugin.json"],
    [".claude-plugin", "plugin.json"],
    [".mcp.json"],
    [".mcp.claude.json"]
  ] as const) {
    const sourcePath = join(sourceRoot, ...relativePath);
    const sourceStats = await lstat(sourcePath, { bigint: true });
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.nlink !== 1n) {
      throw new Error("External plugin mirror metadata source is unsafe.");
    }
    const destinationPath = join(mirrorRoot, ...relativePath);
    if (relativePath.length > 1) await mkdir(dirname(destinationPath), { mode: 0o700 });
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    const [sourceBytes, destinationBytes] = await Promise.all([readFile(sourcePath), readFile(destinationPath)]);
    if (!sourceBytes.equals(destinationBytes)) throw new Error("External plugin mirror metadata copy differs from source.");
  }
  return {
    root: mirrorRoot,
    serverEntry: join(mirrorRoot, "dist", "index.js"),
    hooksEntry: join(mirrorRoot, "dist", "hooks.js")
  };
}

export const externalRuntimeRoot = harness.children.runtime.path;
export const externalServerEntry = resolve(externalRuntimeRoot, "dist", "index.js");
export const externalCliEntry = resolve(externalRuntimeRoot, "dist", "cli.js");
export const externalHooksEntry = resolve(externalRuntimeRoot, "dist", "hooks.js");

export function externalRuntimeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const staging = harness.children.staging.path;
  return { ...process.env, ...extra, TEMP: staging, TMP: staging, TMPDIR: staging };
}
