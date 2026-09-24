#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { listRegularTree } from "./installable-plugin-contract.mjs";
import { buildClaudeMarketplace, buildCodexMarketplace, CLAUDE_MARKETPLACE_PATH, CODEX_MARKETPLACE_PATH, marketplaceBytes } from "./marketplace-contract.mjs";

function usage() {
  return "Usage: node scripts/verify-package-parity.mjs --release <release/tokengraph> --archive <bundle.zip>";
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument !== "--release" && argument !== "--archive") {
      throw new Error(`Unknown argument: ${argument}. ${usage()}`);
    }
    const key = argument === "--release" ? "releaseRoot" : "archivePath";
    if (options[key] !== undefined) throw new Error(`${argument} may only be provided once.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[key] = resolve(value);
  }
  if (!options.releaseRoot || !options.archivePath) throw new Error(`Both --release and --archive are required. ${usage()}`);
  return options;
}

function assertSafeArchivePath(path) {
  const segments = path.split("/");
  if (
    path.length === 0 || path.includes("\0") || path.includes("\\") || isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Archive contains an unsafe path: ${path}.`);
  }
}

export async function verifyPackageParity({ releaseRoot, archivePath }) {
  const releaseFiles = (await listRegularTree(releaseRoot, "Committed release plugin")).sort();
  const archive = unzipSync(await readFile(archivePath));
  const payload = new Map();
  const wrappers = new Map();

  for (const [path, bytes] of Object.entries(archive)) {
    assertSafeArchivePath(path);
    if (path === CODEX_MARKETPLACE_PATH || path === CLAUDE_MARKETPLACE_PATH) {
      wrappers.set(path, bytes);
      continue;
    }
    if (!path.startsWith("tokengraph/")) {
      throw new Error(`Archive contains an unlisted entry: ${path}.`);
    }
    const relativePath = path.slice("tokengraph/".length);
    if (!relativePath || relativePath.endsWith("/")) {
      throw new Error(`Archive plugin payload contains a non-file entry: ${path}.`);
    }
    if (payload.has(relativePath)) throw new Error(`Archive plugin payload repeats entry: ${relativePath}.`);
    payload.set(relativePath, bytes);
  }

  const payloadFiles = [...payload.keys()].sort();
  const releaseSet = new Set(releaseFiles);
  const payloadSet = new Set(payloadFiles);
  const unexpected = payloadFiles.find((path) => !releaseSet.has(path));
  if (unexpected) throw new Error(`Archive plugin payload contains an extra file: ${unexpected}.`);
  const missing = releaseFiles.find((path) => !payloadSet.has(path));
  if (missing) throw new Error(`Archive plugin payload is missing release file: ${missing}.`);
  if (payloadFiles.length !== releaseFiles.length) {
    throw new Error("Archive plugin payload and committed release have different file counts.");
  }

  for (const path of releaseFiles) {
    const releaseBytes = await readFile(resolve(releaseRoot, path));
    if (!releaseBytes.equals(Buffer.from(payload.get(path)))) {
      throw new Error(`Archive plugin payload differs from the committed release: ${path}.`);
    }
  }

  const packageJson = JSON.parse(await readFile(resolve(releaseRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(packageJson.version)) {
    throw new Error("Committed release package version is invalid.");
  }
  const expectedWrappers = new Map([
    [CODEX_MARKETPLACE_PATH, marketplaceBytes(buildCodexMarketplace("./tokengraph"))],
    [CLAUDE_MARKETPLACE_PATH, marketplaceBytes(buildClaudeMarketplace(packageJson.version, "./tokengraph"))]
  ]);
  for (const [path, expected] of expectedWrappers) {
    const actual = wrappers.get(path);
    if (!actual || !Buffer.from(actual).equals(expected)) {
      throw new Error(`Archive marketplace wrapper is missing or differs from the canonical source: ${path}.`);
    }
  }

  return { fileCount: releaseFiles.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  Promise.resolve()
    .then(() => verifyPackageParity(parseArgs(process.argv.slice(2))))
    .then(({ fileCount }) => {
      console.log(`Standalone package payload matches the committed release byte-for-byte (${fileCount} files).`);
    })
    .catch((error) => {
      console.error(`Package parity verification failed: ${error.message}`);
      process.exit(1);
    });
}
