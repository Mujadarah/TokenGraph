import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";

import type { Ignore } from "ignore";

import type { CodeFile, CodeGraph, CodeSymbol, Exclusion, FileKind, ImportEdge } from "./types.js";
import { estimateTokens } from "./token.js";

const DEPENDENCY_DIRS = new Set(["node_modules", "vendor", "bower_components"]);
const BUILD_DIRS = new Set([".next", "dist", "build", "out", "coverage", ".turbo", ".cache", ".parcel-cache"]);
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sql", ".md", ".mdx"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SECRET_FILE_PATTERNS = [/^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_rsa$/i, /^id_ed25519$/i];
const MAX_INDEXED_BYTES = 512 * 1024;
const DEFAULT_SCAN_BUDGET = {
  maxFiles: 5000,
  maxDirectories: 1000,
  maxDepth: 32,
  maxTotalBytes: 50 * 1024 * 1024
};
const createIgnore = createRequire(import.meta.url)("ignore") as () => Ignore;

export interface ScanBudget {
  maxFiles?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
}

interface WalkState {
  budget: Required<ScanBudget>;
  directories: number;
  totalBytes: number;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function exclusionForName(name: string): Exclusion["reason"] | undefined {
  if (DEPENDENCY_DIRS.has(name)) return "dependency";
  if (BUILD_DIRS.has(name)) return "build-output";
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))) return "secret";
  return undefined;
}

async function loadRootIgnore(root: string): Promise<Ignore> {
  const matcher = createIgnore();
  try {
    matcher.add(await readFile(join(root, ".gitignore"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return matcher;
}

function languageForExtension(extension: string): string {
  switch (extension) {
    case ".tsx":
      return "tsx";
    case ".ts":
      return "typescript";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".sql":
      return "sql";
    case ".md":
    case ".mdx":
      return "markdown";
    default:
      return "text";
  }
}

function isTestPath(path: string): boolean {
  return /(^|[/.])(test|spec)\.[jt]sx?$/.test(path) || /(__tests__|tests)\//.test(path);
}

function nextRouteForPath(path: string): string | undefined {
  const parts = path.split("/");
  const fileName = parts.at(-1) ?? "";
  if (path.startsWith("app/")) {
    if (!/^(page|route|layout)\.[jt]sx?$/.test(fileName)) {
      return undefined;
    }
    const routeParts = parts.slice(1, -1).filter((part) => !part.startsWith("("));
    return `/${routeParts.join("/")}`.replace(/\/$/, "") || "/";
  }
  if (!path.startsWith("pages/") || !/\.[jt]sx?$/.test(fileName) || fileName.startsWith("_")) {
    return undefined;
  }
  const routeParts = parts.slice(1);
  const leaf = routeParts.at(-1);
  if (!leaf) return undefined;
  routeParts[routeParts.length - 1] = leaf.replace(/\.[jt]sx?$/, "");
  if (routeParts.at(-1) === "index") {
    routeParts.pop();
  }
  return `/${routeParts.join("/")}`.replace(/\/$/, "") || "/";
}

function detectFileKind(path: string, extension: string, content: string): FileKind {
  if (isTestPath(path)) return "test";
  if (extension === ".sql") return "sql";
  if (extension === ".md" || extension === ".mdx") return "doc";
  if (nextRouteForPath(path)) return "next-route";
  if (extension === ".tsx" || extension === ".jsx") return "react-component";
  if ((extension === ".js" || extension === ".mjs") && /<[A-Z_a-z][A-Za-z0-9.:-]*(\s|>|\/)/.test(content)) return "react-component";
  return "module";
}

function extractImports(filePath: string, content: string): ImportEdge[] {
  const imports: ImportEdge[] = [];
  const importPattern = /\bimport(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
  const sideEffectPattern = /\bimport\s+["']([^"']+)["']/g;
  const requirePattern = /\brequire\(["']([^"']+)["']\)/g;
  for (const pattern of [importPattern, sideEffectPattern, requirePattern]) {
    for (const match of content.matchAll(pattern)) {
      imports.push({ filePath, source: match[1] });
    }
  }
  return imports;
}

function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function declarationEndLine(content: string, startLine: number): number {
  const lines = content.split(/\r?\n/);
  let braceDepth = 0;
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index];
    braceDepth += (line.match(/\{/g) ?? []).length;
    braceDepth -= (line.match(/\}/g) ?? []).length;
    if (index === startLine - 1 && braceDepth <= 0) {
      return startLine;
    }
    if (index > startLine - 1 && braceDepth <= 0 && /[};]\s*$/.test(line.trim())) {
      return index + 1;
    }
  }
  return startLine;
}

function isLikelyComponent(filePath: string, name: string, content: string, matchIndex: number): boolean {
  if (!/\.[jt]sx$/.test(filePath) || !/^[A-Z]/.test(name)) {
    return false;
  }
  const nearby = content.slice(matchIndex, Math.min(content.length, matchIndex + 500));
  return /return\s*\(?\s*</.test(nearby) || /=>\s*\(?\s*</.test(nearby) || /<[A-Z_a-z][A-Za-z0-9.:-]*\b/.test(nearby);
}

function extractSymbols(filePath: string, content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const patterns: Array<[RegExp, CodeSymbol["kind"]]> = [
    [/\b(export\s+default\s+|export\s+)?function\s+([A-Z_a-z][$\w]*)/g, "function"],
    [/\b(export\s+)?class\s+([A-Z_a-z][$\w]*)/g, "class"],
    [/\b(export\s+)?(?:const|let|var)\s+([A-Z_a-z][$\w]*)/g, "const"],
    [/\b(export\s+)?type\s+([A-Z_a-z][$\w]*)/g, "type"],
    [/\b(export\s+)?interface\s+([A-Z_a-z][$\w]*)/g, "interface"]
  ];
  for (const [pattern, baseKind] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[2];
      const exported = Boolean(match[1]);
      const startLine = lineForIndex(content, match.index ?? 0);
      const kind = isLikelyComponent(filePath, name, content, match.index ?? 0) ? "component" : baseKind;
      symbols.push({ name, kind, filePath, exported, startLine, endLine: declarationEndLine(content, startLine) });
    }
  }
  return symbols;
}

function candidateImportPaths(root: string, fromFile: string, source: string): string[] {
  const basePath = source.startsWith("@/")
    ? source.slice(2)
    : source.startsWith("~/")
      ? source.slice(2)
      : source.startsWith(".")
        ? normalize(join(dirname(fromFile), source))
        : "";
  if (!basePath) {
    return [];
  }
  const normalized = normalizePath(basePath);
  const extension = extname(normalized);
  const emittedJavaScriptCandidates =
    extension === ".js"
      ? [normalized, normalized.replace(/\.js$/, ".ts"), normalized.replace(/\.js$/, ".tsx")]
      : extension === ".jsx"
        ? [normalized, normalized.replace(/\.jsx$/, ".tsx")]
        : extension === ".mjs" || extension === ".cjs"
          ? [normalized, normalized.replace(/\.[cm]js$/, ".ts")]
          : undefined;
  const candidates = emittedJavaScriptCandidates ?? (extension ? [normalized] : [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}.mjs`,
    `${normalized}.cjs`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.jsx`
  ]);
  return candidates.map((candidate) => normalizePath(relative(root, join(root, candidate))));
}

function resolveLocalImports(root: string, graph: CodeGraph): void {
  const indexedPaths = new Set(graph.files.map((file) => file.path));
  for (const edge of graph.imports) {
    const resolvedPath = candidateImportPaths(root, edge.filePath, edge.source).find((candidate) => indexedPaths.has(candidate));
    if (resolvedPath) {
      edge.resolvedPath = resolvedPath;
    }
  }
}

function budgetFromOptions(options?: ScanBudget): Required<ScanBudget> {
  return {
    maxFiles: options?.maxFiles ?? DEFAULT_SCAN_BUDGET.maxFiles,
    maxDirectories: options?.maxDirectories ?? DEFAULT_SCAN_BUDGET.maxDirectories,
    maxDepth: options?.maxDepth ?? DEFAULT_SCAN_BUDGET.maxDepth,
    maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_SCAN_BUDGET.maxTotalBytes
  };
}

async function walk(root: string, current: string, graph: CodeGraph, ignoreMatcher: Ignore, state: WalkState, depth: number): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const relativePath = normalizePath(relative(root, absolute));
    if (entry.name === ".tokengraph") {
      continue;
    }
    const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath;
    if (relativePath && ignoreMatcher.ignores(ignorePath)) {
      graph.exclusions.push({ path: relativePath, reason: "ignored" });
      continue;
    }
    const exclusionReason = exclusionForName(entry.name);
    if (exclusionReason) {
      graph.exclusions.push({ path: relativePath, reason: exclusionReason });
      continue;
    }
    if (entry.name.startsWith(".")) {
      graph.exclusions.push({ path: relativePath, reason: "hidden" });
      continue;
    }
    if (entry.isDirectory()) {
      if (depth + 1 > state.budget.maxDepth || state.directories >= state.budget.maxDirectories) {
        graph.exclusions.push({ path: relativePath, reason: "budget" });
        continue;
      }
      state.directories += 1;
      await walk(root, absolute, graph, ignoreMatcher, state, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      graph.exclusions.push({ path: relativePath, reason: "unsupported" });
      continue;
    }
    const fileStat = await stat(absolute);
    if (graph.files.length >= state.budget.maxFiles || state.totalBytes + fileStat.size > state.budget.maxTotalBytes) {
      graph.exclusions.push({ path: relativePath, reason: "budget" });
      continue;
    }
    if (fileStat.size > MAX_INDEXED_BYTES) {
      graph.exclusions.push({ path: relativePath, reason: "large-file" });
      continue;
    }
    const content = await readFile(absolute, "utf8");
    if (content.includes("\u0000")) {
      graph.exclusions.push({ path: relativePath, reason: "binary" });
      continue;
    }

    const kind = detectFileKind(relativePath, extension, content);
    const file: CodeFile = {
      path: relativePath,
      kind,
      language: languageForExtension(extension),
      size: fileStat.size,
      estimatedTokens: estimateTokens(content),
      contentHash: hashText(content),
      route: nextRouteForPath(relativePath),
      isTest: isTestPath(relativePath)
    };
    graph.files.push(file);
    state.totalBytes += fileStat.size;

    if (CODE_EXTENSIONS.has(extension)) {
      graph.imports.push(...extractImports(relativePath, content));
      graph.symbols.push(...extractSymbols(relativePath, content));
    }
  }
}

export async function scanProject(root: string, options?: ScanBudget): Promise<CodeGraph> {
  const ignoreMatcher = await loadRootIgnore(root);
  const graph: CodeGraph = {
    root,
    files: [],
    symbols: [],
    imports: [],
    exclusions: []
  };
  await walk(root, root, graph, ignoreMatcher, { budget: budgetFromOptions(options), directories: 0, totalBytes: 0 }, 0);
  graph.files.sort((a, b) => a.path.localeCompare(b.path));
  resolveLocalImports(root, graph);
  graph.symbols.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
  graph.imports.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.source.localeCompare(b.source));
  graph.exclusions.sort((a, b) => a.path.localeCompare(b.path));
  return graph;
}

export function isSupportedCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(basename(path)).toLowerCase());
}
