#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import ts from "typescript";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      stdio: "inherit"
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

function escapeNonAsciiComments(text) {
  const sourceFile = ts.createSourceFile("bundle.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const ranges = [];
  const collectRanges = (comments = []) => {
    for (const comment of comments) {
      ranges.push([comment.pos, comment.end]);
    }
  };
  const visit = (node) => {
    collectRanges(ts.getLeadingCommentRanges(text, node.pos));
    collectRanges(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  ranges.sort((left, right) => left[0] - right[0]);
  const mergedRanges = [];
  for (const range of ranges) {
    const previous = mergedRanges.at(-1);
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      mergedRanges.push([...range]);
    }
  }

  const chunks = [];
  let cursor = 0;
  for (const [start, end] of mergedRanges) {
    chunks.push(text.slice(cursor, start));
    chunks.push(
      text.slice(start, end).replace(/[^\x00-\x7F]/gu, (character) => {
        const codePoint = character.codePointAt(0).toString(16).toUpperCase();
        return codePoint.length <= 4 ? `\\u${codePoint.padStart(4, "0")}` : `\\u{${codePoint}}`;
      })
    );
    cursor = end;
  }

  chunks.push(text.slice(cursor));
  return chunks.join("");
}

async function normalizeBundle(path) {
  const text = escapeNonAsciiComments(await readFile(path, "utf8")).replace(/[ \t]+$/gm, "");
  if (/[^\x00-\x7F]/u.test(text)) {
    throw new Error(`Non-ASCII executable text remains in ${path}`);
  }
  await writeFile(path, text);
}

await run(process.execPath, [resolve(pluginRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);

await build({
  entryPoints: [resolve(pluginRoot, "src", "index.ts")],
  outfile: resolve(pluginRoot, "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent"
});

await build({
  entryPoints: [resolve(pluginRoot, "src", "hooks.ts")],
  outfile: resolve(pluginRoot, "dist", "hooks.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent"
});

await build({
  entryPoints: [resolve(pluginRoot, "src", "cli.ts")],
  outfile: resolve(pluginRoot, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent"
});

await build({
  entryPoints: [resolve(pluginRoot, "src", "polyglotWorker.ts")],
  outfile: resolve(pluginRoot, "dist", "polyglot-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent"
});

await build({
  entryPoints: [resolve(pluginRoot, "src", "typescriptWorker.ts")],
  outfile: resolve(pluginRoot, "dist", "typescript-worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "silent"
});

await Promise.all([
  normalizeBundle(resolve(pluginRoot, "dist", "index.js")),
  normalizeBundle(resolve(pluginRoot, "dist", "hooks.js")),
  normalizeBundle(resolve(pluginRoot, "dist", "cli.js")),
  normalizeBundle(resolve(pluginRoot, "dist", "polyglot-worker.js")),
  normalizeBundle(resolve(pluginRoot, "dist", "typescript-worker.cjs"))
]);

// Release entry points are executable on POSIX hosts; Windows ignores this mode.
// package-plugin.mjs normalizes packaged file permissions for deterministic archives.
await chmod(resolve(pluginRoot, "dist", "index.js"), 0o755);
await chmod(resolve(pluginRoot, "dist", "hooks.js"), 0o755);
await chmod(resolve(pluginRoot, "dist", "cli.js"), 0o755);
await chmod(resolve(pluginRoot, "dist", "polyglot-worker.js"), 0o644);
await chmod(resolve(pluginRoot, "dist", "typescript-worker.cjs"), 0o644);
