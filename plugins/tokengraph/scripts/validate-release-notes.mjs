#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function fail(message) {
  console.error(`TokenGraph release-note validation failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0) return { file: undefined };
  if (argv.length === 2 && argv[0] === "--file") return { file: argv[1] };
  fail("usage: node scripts/validate-release-notes.mjs [--file <release-notes.md>]");
}

const { file } = parseArgs(process.argv.slice(2));
const notes = file === undefined
  ? await new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { content += chunk; });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", reject);
  })
  : await readFile(file, "utf8");

if (/\bB7\b[\s\S]{0,180}\binactive\b/i.test(notes)) {
  fail("B7 must not be described as inactive.");
}
if (!/\bB7\b[\s\S]{0,180}\b(?:active|enabled)\s+by\s+default\b/i.test(notes)) {
  fail("B7 must be described as active by default.");
}
if (!/\bB7\b[\s\S]{0,220}\bindependent\b[\s\S]{0,120}\brouting\b/i.test(notes)) {
  fail("B7 must be described as independent of routing.");
}
if (!/\brouting\b[\s\S]{0,120}\bshadow(?:-only| mode)?\b/i.test(notes)) {
  fail("routing must be described as shadow-only.");
}

console.log("TokenGraph release-note contract passed.");
