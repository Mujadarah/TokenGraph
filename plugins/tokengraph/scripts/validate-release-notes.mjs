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
const notes = (file === undefined
  ? await new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { content += chunk; });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", reject);
  })
  : await readFile(file, "utf8")).replace(/\r\n?/g, "\n");

const currentStart = "--- TOKENGRAPH_CURRENT_STATE START ---";
const currentEnd = "--- TOKENGRAPH_CURRENT_STATE END ---";
const historicalStart = "--- TOKENGRAPH_HISTORICAL_STATE START ---";
const historicalEnd = "--- TOKENGRAPH_HISTORICAL_STATE END ---";
const canonicalCurrentFields = [
  "B7_POLYGLOT_INDEXING=active-by-default",
  "B7_ROUTING_PROMOTION=independent",
  "ROUTING_MODE=shadow-only",
  "ENFORCEMENT=disabled"
];

function markerIndexes(text, marker) {
  const indexes = [];
  let index = text.indexOf(marker);
  while (index !== -1) {
    indexes.push(index);
    index = text.indexOf(marker, index + marker.length);
  }
  return indexes;
}

function matchedBlocks(text, startMarker, endMarker, label, requireExactlyOne) {
  const starts = markerIndexes(text, startMarker);
  const ends = markerIndexes(text, endMarker);
  if (requireExactlyOne && (starts.length !== 1 || ends.length !== 1)) {
    fail(`release notes must contain exactly one ${label} block.`);
  }
  if (!requireExactlyOne && starts.length !== ends.length) {
    fail(`${label} blocks must have matching start and end markers.`);
  }

  const blocks = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = ends[index];
    if (end === undefined || end <= start || (index + 1 < starts.length && starts[index + 1] < end)) {
      fail(`${label} blocks must be well-formed and non-overlapping.`);
    }
    blocks.push({ start, end: end + endMarker.length, content: text.slice(start + startMarker.length, end).trim() });
  }
  return blocks;
}

const [currentBlock] = matchedBlocks(notes, currentStart, currentEnd, "current-state", true);
const historicalBlocks = matchedBlocks(notes, historicalStart, historicalEnd, "historical-state", false);
if (currentBlock.content !== canonicalCurrentFields.join("\n")) {
  fail("current-state block must contain exactly the canonical fields.");
}
for (const historicalBlock of historicalBlocks) {
  if (historicalBlock.start < currentBlock.end && currentBlock.start < historicalBlock.end) {
    fail("current-state and historical-state blocks must not overlap.");
  }
}

const stateBlocks = [currentBlock, ...historicalBlocks].sort((left, right) => right.start - left.start);
let notesOutsideStateBlocks = notes;
for (const block of stateBlocks) {
  notesOutsideStateBlocks = `${notesOutsideStateBlocks.slice(0, block.start)}${notesOutsideStateBlocks.slice(block.end)}`;
}
if (/\b(?:B7(?:\b|_)|ROUTING(?:\b|_)|ENFORCEMENT(?:\b|_)|enforced\b)/i.test(notesOutsideStateBlocks)) {
  fail("current B7, routing, or enforcement claims must not appear outside a delimited state block.");
}

console.log("TokenGraph release-note contract passed.");
