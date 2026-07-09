#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const defaultOutRoot = resolve(repoRoot, "artifacts");
const defaultReleaseDir = resolve(repoRoot, "release", "tokengraph");

function usage() {
  return [
    "Usage: node scripts/package-plugin.mjs [--out <directory>] [--release] [--out-release <directory>] [--json]",
    "",
    "Builds a distributable TokenGraph plugin folder containing compiled dist output.",
    "",
    "Default output remains artifacts/tokengraph-<version>/ for local release testing.",
    "--release writes the committed one-click install plugin at release/tokengraph/.",
    "--out-release writes a direct release layout to a custom directory."
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
    release: false,
    releaseDir: defaultReleaseDir,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--out") {
      args.outRoot = resolve(readOptionValue(argv, ++index, "--out"));
    } else if (arg === "--release") {
      args.release = true;
    } else if (arg === "--out-release") {
      args.release = true;
      args.releaseDir = resolve(readOptionValue(argv, ++index, "--out-release"));
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

function buildReleaseReadme(version) {
  return `# TokenGraph Release Plugin

This folder is the installable TokenGraph plugin for normal Codex users.

It includes the compiled MCP runtime under \`dist/\`, the plugin manifest, MCP config, skills, package metadata, and license. A normal user install from the repository marketplace should not require \`pnpm install\`, \`pnpm build\`, TypeScript, or a local dependency install inside this folder.

## Install

Add the repository root as a Codex marketplace source:

\`\`\`powershell
codex plugin marketplace add C:\\path\\to\\TokenGraph
\`\`\`

Then install \`tokengraph\` from that marketplace and start a new Codex thread. The root marketplace points to \`./release/tokengraph\`.

## Runtime

The MCP server starts with:

\`\`\`text
node ./dist/index.js
\`\`\`

The server is local-first. It indexes the selected workspace locally and stores project state under \`.tokengraph/\` in that workspace.

TokenGraph does not require an OpenAI API key, cloud sync, an embeddings service, telemetry, or a paid external API. Token savings are estimates.

## Maintainers

Do not edit generated files in this release folder by hand. Make source changes in \`plugins/tokengraph/\`, then run:

\`\`\`powershell
cd plugins/tokengraph
pnpm build
pnpm package:plugin -- --release
pnpm validate:plugin
\`\`\`

Version: ${version}
`;
}

function buildReleasePackageJson(packageJson) {
  return {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    type: packageJson.type,
    private: true,
    license: packageJson.license,
    bin: packageJson.bin
  };
}

async function writeReleaseMetadata(packageDir, packageJson, version) {
  await writeFile(resolve(packageDir, "README.md"), buildReleaseReadme(version));
  await writeFile(resolve(packageDir, "package.json"), `${JSON.stringify(buildReleasePackageJson(packageJson), null, 2)}\n`);
}

async function copyInstallablePlugin(packageDir, packageJson, version) {
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });

  await copyRequiredPath(resolve(pluginRoot, ".codex-plugin"), resolve(packageDir, ".codex-plugin"));
  await copyRequiredPath(resolve(pluginRoot, "dist"), resolve(packageDir, "dist"));
  await copyRequiredPath(resolve(pluginRoot, "skills"), resolve(packageDir, "skills"));
  await copyRequiredPath(resolve(pluginRoot, ".mcp.json"), resolve(packageDir, ".mcp.json"));
  await copyRequiredPath(resolve(repoRoot, "LICENSE"), resolve(packageDir, "LICENSE"));
  await writeReleaseMetadata(packageDir, packageJson, version);

  const packageStats = await stat(packageDir);
  if (!packageStats.isDirectory()) {
    throw new Error(`Package output is not a directory: ${packageDir}`);
  }
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

  if (args.release) {
    await copyInstallablePlugin(args.releaseDir, packageJson, version);
    return {
      status: "ok",
      mode: "release",
      version,
      releaseDir: args.releaseDir,
      files: await listFiles(args.releaseDir)
    };
  }

  await mkdir(args.outRoot, { recursive: true });
  await copyInstallablePlugin(packageDir, packageJson, version);

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
    mode: "artifact",
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
    if (report.mode === "release") {
      console.log(`TokenGraph release plugin updated at ${report.releaseDir}`);
    } else {
      console.log(`TokenGraph plugin package created at ${report.packageDir}`);
      console.log(`Marketplace file created at ${report.marketplacePath}`);
    }
    console.log(`Files packaged: ${report.files.length}`);
  })
  .catch((error) => {
    console.error(`TokenGraph package failed: ${error.message}`);
    process.exit(1);
  });
