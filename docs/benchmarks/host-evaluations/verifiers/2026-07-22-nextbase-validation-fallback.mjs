#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

function runNode(args, cwd = root) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`node ${args[0]} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

const testPath = resolve(root, "apps", "web", "src", "utils", "effect-bridge.test.ts");
const testSource = await readFile(testPath, "utf8");
if (!/new ValidationError\(\{(?=[^}]*\bfield\s*:)(?=[^}]*\bmessage\s*:\s*['"]['"])[^}]*\}\)/s.test(testSource) ||
    !testSource.includes("Validation failed")) {
  throw new Error("Fielded empty-message validation regression coverage is missing.");
}

const dynamicContract = `
import { getErrorMessage } from "./apps/web/src/utils/effect-bridge.ts";
import { ValidationError } from "./apps/web/src/utils/effect-errors.ts";
const actual = getErrorMessage(new ValidationError({ field: "email", message: "" }));
if (actual !== "email: Validation failed") throw new Error("unexpected validation fallback");
`;
await runNode([resolve(root, "node_modules", "tsx", "dist", "cli.mjs"), "--eval", dynamicContract]);
await runNode([
  resolve(root, "node_modules", "vitest", "vitest.mjs"),
  "run", "--root", "apps/web/src", "utils/effect-bridge.test.ts"
]);
await runNode([
  resolve(root, "node_modules", "typescript", "bin", "tsc"),
  "-p", "apps/web/tsconfig.json", "--noEmit"
]);
