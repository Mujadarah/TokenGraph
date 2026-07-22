#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const pluginRoot = resolve(process.cwd(), "plugins", "tokengraph");

function nodeInvocation(args) {
  return { command: process.execPath, args };
}

function runNode(args) {
  const invocation = nodeInvocation(args);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: pluginRoot,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`node ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

const vitest = resolve(pluginRoot, "node_modules", "vitest", "vitest.mjs");
const tsc = resolve(pluginRoot, "node_modules", "typescript", "bin", "tsc");
await Promise.all([access(vitest), access(tsc)]);
await runNode([vitest, "run", "tests/routing-artifact.test.ts", "tests/retrieval.test.ts", "--configLoader", "runner"]);
await runNode([tsc, "-p", "tsconfig.json", "--noEmit"]);
await runNode([tsc, "-p", "tsconfig.test.json", "--noEmit"]);
