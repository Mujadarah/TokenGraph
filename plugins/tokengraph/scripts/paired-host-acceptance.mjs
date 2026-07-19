#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const pluginRoot = resolve(process.cwd(), "plugins", "tokengraph");

function pnpmInvocation(args) {
  if (process.platform !== "win32") return { command: "pnpm", args };
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is unavailable; cannot locate pnpm.");
  return {
    command: process.execPath,
    args: [resolve(appData, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs"), ...args]
  };
}

function runPnpm(args) {
  const invocation = pnpmInvocation(args);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, { cwd: pluginRoot, stdio: "ignore", windowsHide: true });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`pnpm ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

const dependenciesReady = await Promise.all([
  access(resolve(pluginRoot, "node_modules", "vitest", "vitest.mjs")),
  access(resolve(pluginRoot, "node_modules", "typescript", "bin", "tsc"))
]).then(() => true, () => false);
if (!dependenciesReady) await runPnpm(["install", "--offline", "--frozen-lockfile"]);
await runPnpm(["vitest", "run", "tests/routing-artifact.test.ts", "tests/retrieval.test.ts"]);
await runPnpm(["typecheck"]);
