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

function isVersionScopedHistoricalSentence(sentence) {
  return /\b(?:in|before|during|as of)\s+v\d+\.\d+\.\d+\b/i.test(sentence)
    || /\bv\d+\.\d+\.\d+\b[\s\S]{0,80}\b(?:was|remained)\s+(?:inactive|disabled)\b/i.test(sentence);
}

const currentSentences = notes
  .split(/(?<=[.!?])\s+/)
  .filter((sentence) => sentence && !isVersionScopedHistoricalSentence(sentence));
const b7Notes = currentSentences.filter((sentence) => /\bB7\b/i.test(sentence)).join(" ");
const routingNotes = currentSentences.filter((sentence) => /\brouting\b/i.test(sentence)).join(" ");
const enforcementNotes = currentSentences.filter((sentence) => /\benforcement\b/i.test(sentence)).join(" ");

if (/\bB7\b[\s\S]{0,180}\b(?:is\s+)?not\s+(?:active|enabled)\s+by\s+default\b/i.test(b7Notes)) {
  fail("B7 must not be described as not active or enabled by default.");
}
if (/\bB7\b[\s\S]{0,180}\b(?:is|remains|remained|was)?\s*(?:inactive|disabled)\b/i.test(b7Notes)) {
  fail("B7 must not be described as inactive or disabled.");
}
if (!/\bB7\b[\s\S]{0,180}\b(?:is\s+)?(?:active|enabled)\s+by\s+default\b/i.test(b7Notes)) {
  fail("B7 must be described as active by default.");
}
if (/\bB7\b[\s\S]{0,220}\b(?:is\s+)?not\s+independent\b[\s\S]{0,120}\brouting\b/i.test(b7Notes)) {
  fail("B7 must not be described as dependent on routing.");
}
if (!/\bB7\b[\s\S]{0,220}\bindependent\b[\s\S]{0,120}\brouting\b/i.test(b7Notes)) {
  fail("B7 must be described as independent of routing.");
}
if (/\brouting\b[\s\S]{0,120}\b(?:is\s+)?not\s+shadow(?:-only| mode)?\b/i.test(routingNotes)) {
  fail("routing must not be described as non-shadow.");
}
if (!/\brouting\b[\s\S]{0,120}\bshadow(?:-only| mode)?\b/i.test(routingNotes)) {
  fail("routing must be described as shadow-only.");
}
if (/\benforcement\b[\s\S]{0,80}\b(?:is\s+)?enabled\b/i.test(enforcementNotes)) {
  fail("enforcement must not be described as enabled.");
}

console.log("TokenGraph release-note contract passed.");
