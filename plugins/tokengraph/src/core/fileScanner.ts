import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";

import * as ignorePackage from "ignore";
import type { Ignore } from "ignore";

import type { CodeFile, CodeGraph, CodeSymbol, Exclusion, FileKind, FileScanMetadata, ImportEdge } from "./types.js";
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
const createIgnore = (("default" in ignorePackage ? ignorePackage.default : ignorePackage) as unknown) as () => Ignore;
export interface ScanBudget {
  maxFiles?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
  onFileContent?: (file: { path: string; language: string; content: string }) => void;
}

interface WalkState {
  budget: Required<Omit<ScanBudget, "onFileContent">>;
  directories: number;
  totalBytes: number;
  onFileContent?: (file: { path: string; language: string; content: string }) => void;
}

export interface ProjectFileMetadataScan {
  files: FileScanMetadata[];
  exclusions: Exclusion[];
  scanSignature: string;
}

export interface ParsedProjectFile {
  file: CodeFile;
  imports: ImportEdge[];
  symbols: CodeSymbol[];
  content: string;
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
  return /(^|[/.])(test|spec)\.[jt]sx?$/.test(path) || /(^|\/)(__tests__|tests)\//.test(path);
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
  if ((extension === ".js" || extension === ".mjs") && /\b(?:return|=>)\s*\(?\s*<[A-Z_a-z][A-Za-z0-9.:-]*(\s|>|\/)/.test(content)) return "react-component";
  return "module";
}

function extractImports(filePath: string, content: string): ImportEdge[] {
  const imports: ImportEdge[] = [];
  const importPattern = /^\s*import(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/gm;
  const sideEffectPattern = /^\s*import\s+["']([^"']+)["']/gm;
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [importPattern, sideEffectPattern, requirePattern, dynamicImportPattern]) {
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
  const lines = maskCodeStringsAndComments(content).split(/\r?\n/);
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

function maskCodeStringsAndComments(content: string): string {
  let masked = "";
  let state: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (state === "line-comment") {
      if (char === "\n") {
        state = "code";
        masked += char;
      } else {
        masked += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        masked += "  ";
        index += 1;
        state = "code";
      } else {
        masked += char === "\n" ? char : " ";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === "\\") {
        masked += " ";
        if (next) {
          masked += next === "\n" ? "\n" : " ";
          index += 1;
        }
        continue;
      }
      if (char === quote) {
        state = "code";
      }
      masked += char === "\n" ? char : " ";
      continue;
    }
    if (char === "/" && next === "/") {
      masked += "  ";
      index += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      masked += "  ";
      index += 1;
      state = "block-comment";
      continue;
    }
    if (char === "'") state = "single";
    if (char === '"') state = "double";
    if (char === "`") state = "template";
    masked += state === "code" ? char : " ";
  }
  return masked;
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
    [/\b(export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Z_a-z][$\w]*)/g, "function"],
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
  const basePaths = source.startsWith("@/") || source.startsWith("~/")
    ? [source.slice(2), normalize(join("src", source.slice(2)))]
    : source.startsWith(".")
      ? [normalize(join(dirname(fromFile), source))]
      : [];
  if (!basePaths.length) {
    return [];
  }
  return basePaths.flatMap((basePath) => candidatePathsForBase(root, basePath));
}

function candidatePathsForBase(root: string, basePath: string): string[] {
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
    delete edge.resolvedPath;
    const resolvedPath = candidateImportPaths(root, edge.filePath, edge.source).find((candidate) => indexedPaths.has(candidate));
    if (resolvedPath) {
      edge.resolvedPath = resolvedPath;
    }
  }
}

export function resolveProjectImports(root: string, graph: CodeGraph): void {
  resolveLocalImports(root, graph);
}

function budgetFromOptions(options?: ScanBudget): Required<Omit<ScanBudget, "onFileContent">> {
  return {
    maxFiles: options?.maxFiles ?? DEFAULT_SCAN_BUDGET.maxFiles,
    maxDirectories: options?.maxDirectories ?? DEFAULT_SCAN_BUDGET.maxDirectories,
    maxDepth: options?.maxDepth ?? DEFAULT_SCAN_BUDGET.maxDepth,
    maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_SCAN_BUDGET.maxTotalBytes
  };
}

function addUnreadable(graph: CodeGraph, path: string): void {
  graph.exclusions.push({ path: path || ".", reason: "unreadable" });
}

async function walk(root: string, current: string, graph: CodeGraph, ignoreMatcher: Ignore, state: WalkState, depth: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    addUnreadable(graph, normalizePath(relative(root, current)));
    return;
  }
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
    let fileStat;
    try {
      fileStat = await stat(absolute);
    } catch {
      addUnreadable(graph, relativePath);
      continue;
    }
    if (graph.files.length >= state.budget.maxFiles || state.totalBytes + fileStat.size > state.budget.maxTotalBytes) {
      graph.exclusions.push({ path: relativePath, reason: "budget" });
      continue;
    }
    if (fileStat.size > MAX_INDEXED_BYTES) {
      graph.exclusions.push({ path: relativePath, reason: "large-file" });
      continue;
    }
    let content;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      addUnreadable(graph, relativePath);
      continue;
    }
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
    state.onFileContent?.({ path: relativePath, language: file.language, content });

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
  await walk(root, root, graph, ignoreMatcher, { budget: budgetFromOptions(options), directories: 0, totalBytes: 0, onFileContent: options?.onFileContent }, 0);
  graph.files.sort((a, b) => a.path.localeCompare(b.path));
  resolveLocalImports(root, graph);
  graph.symbols.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
  graph.imports.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.source.localeCompare(b.source));
  graph.exclusions.sort((a, b) => a.path.localeCompare(b.path));
  return graph;
}

export async function scanProjectSignature(root: string, options?: ScanBudget): Promise<string> {
  return (await scanProjectFileMetadata(root, options)).scanSignature;
}

export async function scanProjectFileMetadata(root: string, options?: ScanBudget): Promise<ProjectFileMetadataScan> {
  const ignoreMatcher = await loadRootIgnore(root);
  const rows: Array<Record<string, unknown>> = [];
  const files: FileScanMetadata[] = [];
  const exclusions: Exclusion[] = [];
  const budget = budgetFromOptions(options);
  let directories = 0;
  let fileCount = 0;
  let totalBytes = 0;

  async function walkSignature(current: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      rows.push({ path: normalizePath(relative(root, current)), reason: "unreadable" });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relativePath = normalizePath(relative(root, absolute));
      if (entry.name === ".tokengraph") continue;
      const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (relativePath && ignoreMatcher.ignores(ignorePath)) {
        rows.push({ path: relativePath, reason: "ignored" });
        exclusions.push({ path: relativePath, reason: "ignored" });
        continue;
      }
      const exclusionReason = exclusionForName(entry.name);
      if (exclusionReason) {
        rows.push({ path: relativePath, reason: exclusionReason });
        exclusions.push({ path: relativePath, reason: exclusionReason });
        continue;
      }
      if (entry.name.startsWith(".")) {
        rows.push({ path: relativePath, reason: "hidden" });
        exclusions.push({ path: relativePath, reason: "hidden" });
        continue;
      }
      if (entry.isDirectory()) {
        if (depth + 1 > budget.maxDepth || directories >= budget.maxDirectories) {
          rows.push({ path: relativePath, reason: "budget" });
          exclusions.push({ path: relativePath, reason: "budget" });
          continue;
        }
        directories += 1;
        await walkSignature(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        rows.push({ path: relativePath, reason: "unsupported" });
        exclusions.push({ path: relativePath, reason: "unsupported" });
        continue;
      }
      let fileStat;
      try {
        fileStat = await stat(absolute, { bigint: true });
      } catch {
        rows.push({ path: relativePath, reason: "unreadable" });
        exclusions.push({ path: relativePath, reason: "unreadable" });
        continue;
      }
      const size = Number(fileStat.size);
      if (fileCount >= budget.maxFiles || totalBytes + size > budget.maxTotalBytes) {
        rows.push({ path: relativePath, reason: "budget" });
        exclusions.push({ path: relativePath, reason: "budget" });
        continue;
      }
      if (size > MAX_INDEXED_BYTES) {
        rows.push({ path: relativePath, reason: "large-file" });
        exclusions.push({ path: relativePath, reason: "large-file" });
        continue;
      }
      let content;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        rows.push({ path: relativePath, reason: "unreadable" });
        exclusions.push({ path: relativePath, reason: "unreadable" });
        continue;
      }
      if (content.includes("\u0000")) {
        rows.push({ path: relativePath, reason: "binary" });
        exclusions.push({ path: relativePath, reason: "binary" });
        continue;
      }
      const metadata = {
        path: relativePath,
        size,
        mtimeNs: fileStat.mtimeNs.toString(),
        ctimeNs: fileStat.ctimeNs.toString(),
        contentHash: hashText(content),
        language: languageForExtension(extension),
        extension,
        route: nextRouteForPath(relativePath),
        isTest: isTestPath(relativePath)
      };
      rows.push({ path: relativePath, size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs, contentHash: metadata.contentHash });
      files.push(metadata);
      fileCount += 1;
      totalBytes += size;
    }
  }

  await walkSignature(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  exclusions.sort((a, b) => a.path.localeCompare(b.path));
  return { files, exclusions, scanSignature: hashText(JSON.stringify(rows)) };
}

export async function scanProjectFile(root: string, metadata: FileScanMetadata): Promise<ParsedProjectFile | undefined> {
  let content;
  try {
    content = await readFile(join(root, metadata.path), "utf8");
  } catch {
    return undefined;
  }
  if (content.includes("\u0000")) {
    return undefined;
  }
  const file: CodeFile = {
    path: metadata.path,
    kind: detectFileKind(metadata.path, metadata.extension, content),
    language: metadata.language,
    size: metadata.size,
    estimatedTokens: estimateTokens(content),
    contentHash: hashText(content),
    route: metadata.route,
    isTest: metadata.isTest
  };
  return {
    file,
    imports: CODE_EXTENSIONS.has(metadata.extension) ? extractImports(metadata.path, content) : [],
    symbols: CODE_EXTENSIONS.has(metadata.extension) ? extractSymbols(metadata.path, content) : [],
    content
  };
}

export function isSupportedCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(basename(path)).toLowerCase());
}
