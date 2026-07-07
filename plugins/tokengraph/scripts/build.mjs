#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
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

await chmod(resolve(pluginRoot, "dist", "index.js"), 0o755);
