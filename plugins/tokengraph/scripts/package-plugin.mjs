#!/usr/bin/env node
import { access, chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const defaultOutRoot = resolve(repoRoot, "artifacts");
const defaultReleaseDir = resolve(repoRoot, "release", "tokengraph");

function usage() {
  return [
    "Usage: node scripts/package-plugin.mjs [--out <directory>] [--release] [--out-release <directory>] [--json]",
    "",
    "Builds a standalone Codex and Claude Code marketplace bundle containing compiled dist output.",
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

This folder is the installable TokenGraph ${version} plugin for Codex and Claude Code users.

It includes the self-contained Node.js 22 MCP runtime at \`dist/index.js\`, the cross-host lifecycle adapter at \`dist/hooks.js\`, hook and host manifests, MCP configs, skills, package metadata, and license. It requires no dependency installation, TypeScript build, API key, cloud index, or embeddings service.

## Install

Recommended GitHub install for Codex:

\`\`\`powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
\`\`\`

For an extracted release ZIP, add the bundle directory that contains this \`tokengraph/\` folder, not this plugin folder itself:

\`\`\`powershell
codex plugin marketplace add C:\\path\\to\\tokengraph-${version}
codex plugin add tokengraph@tokengraph
\`\`\`

Claude Code GitHub install:

\`\`\`text
/plugin marketplace add Mujadarah/TokenGraph
/plugin install tokengraph@tokengraph
/reload-plugins
\`\`\`

Claude launches through \`\${CLAUDE_PLUGIN_ROOT}\` and forwards \`\${CLAUDE_PROJECT_DIR}\`. Codex must provide MCP Roots or inherit \`TOKENGRAPH_WORKSPACE_ROOT\`. Call \`tokengraph_setup\` before project tools; it diagnoses setup without granting filesystem trust.

## Runtime

The MCP server starts with:

\`\`\`text
node ./dist/index.js
\`\`\`

The server is local-first. It indexes the selected workspace locally and stores project state under \`.tokengraph/\` in that workspace.

TokenGraph stores project state under \`.tokengraph/\` inside the trusted workspace. Token savings are estimates.

The default surface exposes eight compact tools; the opt-in full surface exposes 42. JSON-only successes return one serialized JSON text item, with project-map resource links as the documented exception. Wiki and memory changes use source-linked review-before-apply proposals.

Use \`tokengraph_prepare_context\` when planning is needed. Direct query, compress, recall, and analyze calls may omit \`taskId\`; they start a ledger and return the new id. Reuse that id, then end verified work with compact \`tokengraph_task_report({ taskId })\`. Explicit pause is for unfinished work, and verbose reporting is diagnostic only.

The checked-in routing-lifecycle benchmark passes its strict gate with median net estimated savings of 20.0 tokens, p25 -290.0, 100% constraint preservation and recall, and zero critical false negatives. Fifteen of 30 tasks are non-positive. The execution-inclusive median is -86.0 tokens with 18 of 30 tasks non-positive. Every category remains low-confidence, and these fixture estimates are not provider billing counts.

The PostToolUse/Stop hook stores only a schema-versioned session hash, task id, trusted root, turn id, and timestamp in the host-provided plugin data directory. It never stores prompts, transcripts, or tool payloads. Normal Stop can request one pause-or-complete report or the exact canonical footer; interrupts and API failures are not completion events. Review and trust the hook definition before enabling it, or disable host hooks and call \`tokengraph_task_report\` explicitly.

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
  await mkdir(resolve(packageDir, "dist"), { recursive: true });
  await copyRequiredPath(resolve(pluginRoot, "dist", "index.js"), resolve(packageDir, "dist", "index.js"));
  await copyRequiredPath(resolve(pluginRoot, "dist", "hooks.js"), resolve(packageDir, "dist", "hooks.js"));
  // The build marks the source bundle executable, but release installs launch it
  // with "node", and a copied executable bit flips the committed file mode on
  // filemode-aware systems, breaking the CI reproducibility check.
  await chmod(resolve(packageDir, "dist", "index.js"), 0o644);
  await chmod(resolve(packageDir, "dist", "hooks.js"), 0o644);
  await copyRequiredPath(resolve(pluginRoot, "hooks"), resolve(packageDir, "hooks"));
  await copyRequiredPath(resolve(pluginRoot, "skills"), resolve(packageDir, "skills"));
  await copyRequiredPath(resolve(pluginRoot, ".mcp.json"), resolve(packageDir, ".mcp.json"));
  await copyRequiredPath(resolve(pluginRoot, ".claude-plugin"), resolve(packageDir, ".claude-plugin"));
  await copyRequiredPath(resolve(pluginRoot, ".mcp.claude.json"), resolve(packageDir, ".mcp.claude.json"));
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

function buildCodexMarketplace(pluginPath) {
  return {
    name: "tokengraph",
    interface: { displayName: "TokenGraph" },
    plugins: [{
      name: "tokengraph",
      source: { source: "local", path: pluginPath },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools"
    }]
  };
}

function buildClaudeMarketplace(version, pluginPath) {
  return {
    name: "tokengraph",
    owner: { name: "Mujadarah" },
    metadata: {
      description: "Local-first project context routing for Codex and Claude Code."
    },
    plugins: [{
      name: "tokengraph",
      source: pluginPath,
      version,
      description: "Route coding agents through compact local code, SQL, memory, wiki, and log context.",
      category: "Developer Tools",
      tags: ["mcp", "code-intelligence", "local-first", "context"]
    }]
  };
}

async function writeMarketplace(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeDeterministicArchive(bundleDir, archivePath) {
  const files = await listFiles(bundleDir);
  const entries = {};
  for (const file of files) {
    entries[file] = [await readFile(resolve(bundleDir, file)), { mtime: new Date("1980-01-01T00:00:00.000Z") }];
  }
  await writeFile(archivePath, zipSync(entries, { level: 9, mtime: new Date("1980-01-01T00:00:00.000Z") }));
}

async function runPackage() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = await readJson(resolve(pluginRoot, "package.json"));
  const manifest = await readJson(resolve(pluginRoot, ".codex-plugin", "plugin.json"));
  const version = packageJson.version;
  const packageName = `tokengraph-${version}`;
  const bundleDir = resolve(args.outRoot, packageName);
  const packageDir = resolve(bundleDir, "tokengraph");
  const archivePath = resolve(args.outRoot, `${packageName}.zip`);
  const codexMarketplacePath = resolve(bundleDir, ".agents", "plugins", "marketplace.json");
  const claudeMarketplacePath = resolve(bundleDir, ".claude-plugin", "marketplace.json");

  if (manifest.version?.split("+", 1)[0] !== version) {
    throw new Error(`Plugin manifest base version ${manifest.version} does not match package version ${version}.`);
  }

  await assertReadable(resolve(pluginRoot, "dist", "index.js"), "built MCP entry");
  await assertReadable(resolve(pluginRoot, "dist", "hooks.js"), "built lifecycle hook entry");
  await assertReadable(resolve(pluginRoot, "hooks", "hooks.json"), "lifecycle hook manifest");

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

  await rm(bundleDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(args.outRoot, { recursive: true });
  await copyInstallablePlugin(packageDir, packageJson, version);
  await writeMarketplace(codexMarketplacePath, buildCodexMarketplace("./tokengraph"));
  await writeMarketplace(claudeMarketplacePath, buildClaudeMarketplace(version, "./tokengraph"));
  await writeDeterministicArchive(bundleDir, archivePath);

  return {
    status: "ok",
    mode: "bundle",
    version,
    bundleDir,
    packageDir,
    archivePath,
    codexMarketplacePath,
    claudeMarketplacePath,
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
      console.log(`TokenGraph marketplace bundle created at ${report.bundleDir}`);
      console.log(`TokenGraph release archive created at ${report.archivePath}`);
    }
    console.log(`Files packaged: ${report.files.length}`);
  })
  .catch((error) => {
    console.error(`TokenGraph package failed: ${error.message}`);
    process.exit(1);
  });
