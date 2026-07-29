#!/usr/bin/env node
import { renderReleaseNotes } from "./release-note-contract.mjs";

function fail(message) {
  console.error(`TokenGraph release-note renderer failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0) fail("release version is required.");
  if (argv.length !== 2 || argv[0] !== "--version") {
    fail("usage: node scripts/render-release-notes.mjs --version <x.y.z>");
  }
  return argv[1];
}

try {
  process.stdout.write(renderReleaseNotes(parseArgs(process.argv.slice(2))));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
