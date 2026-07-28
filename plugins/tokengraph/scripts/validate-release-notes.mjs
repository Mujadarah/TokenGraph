#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { normalizeReleaseNotes, renderReleaseNotes } from "./release-note-contract.mjs";

function fail(message) {
  console.error(`TokenGraph release-note validation failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let file;
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") {
      file = argv[++index];
    } else if (argument === "--version") {
      version = argv[++index];
    } else {
      fail("usage: node scripts/validate-release-notes.mjs --file <release-notes.md> --version <x.y.z>");
    }
  }
  if (!file) fail("release notes file is required.");
  if (!version) fail("release version is required.");
  return { file, version };
}

const { file, version } = parseArgs(process.argv.slice(2));
const notes = normalizeReleaseNotes(await readFile(file, "utf8"));
const expected = renderReleaseNotes(version);
if (notes !== expected) {
  fail(`artifact does not exactly match the canonical release notes for version ${version}.`);
}

console.log("TokenGraph release-note contract passed.");
