#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assertReleaseVersion } from "./release-note-contract.mjs";

function fail(message) {
  console.error(`TokenGraph release-version validation failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let packagePath;
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package") {
      if (packagePath !== undefined) fail("package path may only be provided once.");
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("package path requires a value.");
      packagePath = value;
    } else if (argument === "--version") {
      if (version !== undefined) fail("release version may only be provided once.");
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("release version requires a value.");
      version = value;
    } else {
      fail("usage: node scripts/validate-release-version.mjs --package <package.json> --version <x.y.z>");
    }
  }
  if (!packagePath) fail("package path is required.");
  if (!version) fail("release version is required.");
  return { packagePath, version };
}

try {
  const { packagePath, version } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  if (!manifest || typeof manifest.version !== "string") fail("package manifest must contain a string version.");
  const packageVersion = assertReleaseVersion(manifest.version);
  const tagVersion = assertReleaseVersion(version);
  if (packageVersion !== tagVersion) {
    fail(`package version ${packageVersion} does not match release tag version ${tagVersion}.`);
  }
  console.log("TokenGraph release tag and package version match.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
