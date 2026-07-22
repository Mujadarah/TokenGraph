#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function runNode(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
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

const testSource = await readFile(resolve(root, "src", "tests", "map-constructor.ts"), "utf8");
const requiredCoverage = [
  /new Map\(\)\s+satisfies\s+Map<string,\s*boolean>/,
  /:\s*Map<string,\s*boolean>\s*=\s*new Map\(\)/,
  /\b[A-Za-z_$][\w$]*\(new Map\(\)\)/,
  /new Map\(\[\s*\[/s
];
if (requiredCoverage.some((pattern) => !pattern.test(testSource))) {
  throw new Error("Map constructor regression coverage is incomplete.");
}

const typescriptPath = resolve(root, "node_modules", "typescript", "lib", "typescript.js");
const ts = (await import(pathToFileURL(typescriptPath).href)).default;
const virtualPath = resolve(root, ".tokengraph-controller", "map-constructor-contract.ts");
const entrypointPath = resolve(root, "src", "entrypoints", "map-constructor.d.ts");
const virtualSource = `
function expectsBooleanMap(map: Map<string, boolean>): Map<string, boolean> { return map; }
const argument = expectsBooleanMap(new Map());
const assigned: Map<string, boolean> = new Map();
const satisfied = new Map() satisfies Map<string, boolean>;
const populated = new Map([["foo", 1], ["bar", 2]]);
const bare = new Map();
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Argument = Expect<Equal<typeof argument, Map<string, boolean>>>;
type Assigned = Expect<Equal<typeof assigned, Map<string, boolean>>>;
type Satisfied = Expect<Equal<typeof satisfied, Map<string, boolean>>>;
type Populated = Expect<Equal<typeof populated, Map<string, number>>>;
type Bare = Expect<Equal<typeof bare, Map<unknown, unknown>>>;
`;
const options = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  noEmit: true,
  skipLibCheck: false
};
const host = ts.createCompilerHost(options);
const originalFileExists = host.fileExists.bind(host);
const originalReadFile = host.readFile.bind(host);
const originalGetSourceFile = host.getSourceFile.bind(host);
const sameVirtualPath = (path) => path.replaceAll("\\", "/").toLowerCase() === virtualPath.replaceAll("\\", "/").toLowerCase();
host.fileExists = (path) => sameVirtualPath(path) || originalFileExists(path);
host.readFile = (path) => sameVirtualPath(path) ? virtualSource : originalReadFile(path);
host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => sameVirtualPath(path)
  ? ts.createSourceFile(path, virtualSource, languageVersion, true)
  : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
const program = ts.createProgram({ rootNames: [entrypointPath, virtualPath], options, host });
const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (errors.length > 0) {
  const summary = errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join(" | ");
  throw new Error(`Map constructor contextual-generic contract failed: ${summary}`);
}

await runNode([resolve(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--noEmit"]);
