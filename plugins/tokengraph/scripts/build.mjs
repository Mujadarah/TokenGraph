#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

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

async function normalizeBundle(path) {
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace(/[ \t]+$/gm, ""));
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

await Promise.all([
  normalizeBundle(resolve(pluginRoot, "dist", "index.js")),
  normalizeBundle(resolve(pluginRoot, "dist", "hooks.js")),
  normalizeBundle(resolve(pluginRoot, "dist", "cli.js"))
]);

// Release entry points are executable on POSIX hosts; Windows ignores this mode.
await chmod(resolve(pluginRoot, "dist", "index.js"), 0o755);
await chmod(resolve(pluginRoot, "dist", "hooks.js"), 0o755);
await chmod(resolve(pluginRoot, "dist", "cli.js"), 0o755);
