import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { TARGETS } from "./generate-native-lock-manifest.mjs";

const SKILL_DIRECTORIES = [
  "architecture-consistency-checker",
  "context-compression",
  "graph-context-retrieval",
  "memory-curator",
  "regression-detector",
  "release-packaging-auditor",
  "root-cause-debugger",
  "token-budget-optimizer",
  "tokengraph"
];

export const INSTALLABLE_ASSET_PATHS = Object.freeze([
  "grammars/tree-sitter-go.wasm",
  "grammars/tree-sitter-java.wasm",
  "grammars/tree-sitter-python.wasm",
  "grammars/tree-sitter-rust.wasm",
  "grammars/web-tree-sitter.wasm",
  "native-lock/THIRD_PARTY_NOTICES.txt",
  "native-lock/manifest.json",
  ...TARGETS.map((target) => `native-lock/${target.id}/${target.file}`)
].sort());

export const INSTALLABLE_PLUGIN_PATHS = Object.freeze([
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".mcp.claude.json",
  ".mcp.json",
  ...INSTALLABLE_ASSET_PATHS.map((path) => `assets/${path}`),
  "dist/cli.js",
  "dist/hooks.js",
  "dist/index.js",
  "dist/polyglot-worker.js",
  "dist/typescript-worker.cjs",
  "hooks/hooks.json",
  "LICENSE",
  "NOTICE",
  "package.json",
  "README.md",
  ...SKILL_DIRECTORIES.map((directory) => `skills/${directory}/SKILL.md`)
].sort());

async function assertDirectory(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be an unlinked directory.`);
  }
}

export async function listRegularTree(root, label, base = root) {
  await assertDirectory(root, label);
  const files = [];
  for (const name of (await readdir(root)).sort((left, right) => left.localeCompare(right))) {
    const path = resolve(root, name);
    const relativePath = relative(base, path).split(sep).join("/");
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} contains a linked entry: ${relativePath}.`);
    }
    if (stats.isDirectory()) {
      files.push(...await listRegularTree(path, label, base));
    } else if (stats.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`${label} contains a non-regular entry: ${relativePath}.`);
    }
  }
  return files;
}

async function assertRegularFile(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be an unlinked regular file.`);
  }
}

function assertExactPaths(files, expectedPaths, label) {
  const expected = new Set(expectedPaths);
  const unexpected = files.find((file) => !expected.has(file));
  if (unexpected) throw new Error(`${label} contains an unlisted entry: ${unexpected}.`);
  const missing = expectedPaths.find((file) => !files.includes(file));
  if (missing) throw new Error(`${label} is missing required entry: ${missing}.`);
  if (files.length !== expectedPaths.length) {
    throw new Error(`${label} must match the exact installable entry allowlist.`);
  }
}

export async function assertExactInstallableAssets(root, label) {
  assertExactPaths(await listRegularTree(root, label), INSTALLABLE_ASSET_PATHS, label);
}

export async function assertExactInstallablePlugin(root, label) {
  assertExactPaths(await listRegularTree(root, label), INSTALLABLE_PLUGIN_PATHS, label);
}

export async function assertExactInstallableSourceInputs(pluginRoot, repoRoot) {
  const sourceTrees = [
    [".claude-plugin", ["plugin.json"]],
    [".codex-plugin", ["plugin.json"]],
    ["assets", INSTALLABLE_ASSET_PATHS],
    ["hooks", ["hooks.json"]],
    ["skills", SKILL_DIRECTORIES.map((directory) => `${directory}/SKILL.md`)]
  ];
  for (const [directory, expected] of sourceTrees) {
    const label = `Source installable ${directory}`;
    assertExactPaths(await listRegularTree(resolve(pluginRoot, directory), label), expected, label);
  }
  for (const path of [
    ".mcp.claude.json",
    ".mcp.json",
    "dist/cli.js",
    "dist/hooks.js",
    "dist/index.js",
    "dist/polyglot-worker.js",
    "dist/typescript-worker.cjs",
    "package.json"
  ]) {
    await assertRegularFile(resolve(pluginRoot, path), `Source installable ${path}`);
  }
  for (const path of ["LICENSE", "NOTICE"]) {
    await assertRegularFile(resolve(repoRoot, path), `Source installable ${path}`);
  }
}
