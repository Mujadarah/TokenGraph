#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const defaultOutRoot = resolve(repoRoot, "artifacts");

function usage() {
  return [
    "Usage: node scripts/package-plugin.mjs [--out <directory>] [--json]",
    "",
    "Builds a distributable TokenGraph plugin folder containing compiled dist output",
    "without requiring dist/ to be committed to the source repository."
  ].join("\n");
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.\n${usage()}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    outRoot: defaultOutRoot,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--out") {
      args.outRoot = resolve(readOptionValue(argv, ++index, "--out"));
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertReadable(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing at ${path}. Run pnpm build before packaging.`);
  }
}

async function copyRequiredPath(source, destination) {
  await assertReadable(source, relative(pluginRoot, source) || source);
  await cp(source, destination, { recursive: true, force: true });
}

async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path, base));
    } else if (entry.isFile()) {
      files.push(relative(base, path).split(sep).join("/"));
    }
  }
  return files;
}

async function runPackage() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = await readJson(resolve(pluginRoot, "package.json"));
  const manifest = await readJson(resolve(pluginRoot, ".codex-plugin", "plugin.json"));
  const version = packageJson.version;
  const packageName = `tokengraph-${version}`;
  const packageDir = resolve(args.outRoot, packageName);
  const marketplacePath = resolve(args.outRoot, ".agents", "plugins", "marketplace.json");

  if (manifest.version?.split("+", 1)[0] !== version) {
    throw new Error(`Plugin manifest base version ${manifest.version} does not match package version ${version}.`);
  }

  await assertReadable(resolve(pluginRoot, "dist", "index.js"), "built MCP entry");
  await assertReadable(resolve(pluginRoot, "dist", "server.js"), "built MCP server");

  await rm(packageDir, { recursive: true, force: true });
  await mkdir(args.outRoot, { recursive: true });

  await copyRequiredPath(resolve(pluginRoot, ".codex-plugin"), resolve(packageDir, ".codex-plugin"));
  await copyRequiredPath(resolve(pluginRoot, "dist"), resolve(packageDir, "dist"));
  await copyRequiredPath(resolve(pluginRoot, "skills"), resolve(packageDir, "skills"));
  await copyRequiredPath(resolve(pluginRoot, ".mcp.json"), resolve(packageDir, ".mcp.json"));
  await copyRequiredPath(resolve(pluginRoot, "README.md"), resolve(packageDir, "README.md"));
  await copyRequiredPath(resolve(pluginRoot, "package.json"), resolve(packageDir, "package.json"));
  await copyRequiredPath(resolve(repoRoot, "LICENSE"), resolve(packageDir, "LICENSE"));

  const packageStats = await stat(packageDir);
  if (!packageStats.isDirectory()) {
    throw new Error(`Package output is not a directory: ${packageDir}`);
  }

  const marketplace = {
    name: "tokengraph-release",
    interface: {
      displayName: "TokenGraph Release"
    },
    plugins: [
      {
        name: "tokengraph",
        source: {
          source: "local",
          path: `./${packageName}`
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        },
        category: "Productivity"
      }
    ]
  };
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

  return {
    status: "ok",
    version,
    packageDir,
    marketplacePath,
    files: await listFiles(packageDir)
  };
}

runPackage()
  .then((report) => {
    const args = parseArgs(process.argv.slice(2));
    if (args.json) {
      console.log(JSON.stringify(report));
      return;
    }
    console.log(`TokenGraph plugin package created at ${report.packageDir}`);
    console.log(`Marketplace file created at ${report.marketplacePath}`);
    console.log(`Files packaged: ${report.files.length}`);
  })
  .catch((error) => {
    console.error(`TokenGraph package failed: ${error.message}`);
    process.exit(1);
  });
