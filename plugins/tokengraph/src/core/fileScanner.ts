import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

import type { Ignore } from "ignore";

import type { CodeFile, CodeGraph, CodeSymbol, Exclusion, FileKind, ImportEdge } from "./types.js";
import { estimateTokens } from "./token.js";

const DEPENDENCY_DIRS = new Set(["node_modules", "vendor", "bower_components"]);
const BUILD_DIRS = new Set([".next", "dist", "build", "out", "coverage", ".turbo", ".cache", ".parcel-cache"]);
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sql", ".md", ".mdx"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SECRET_FILE_PATTERNS = [/^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_rsa$/i, /^id_ed25519$/i];
const MAX_INDEXED_BYTES = 512 * 1024;
const createIgnore = createRequire(import.meta.url)("ignore") as () => Ignore;

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
  if (!path.startsWith("app/")) {
    return undefined;
  }
  const parts = path.split("/");
  const fileName = parts.at(-1) ?? "";
  if (!/^(page|route|layout)\.[jt]sx?$/.test(fileName)) {
    return undefined;
  }
  const routeParts = parts.slice(1, -1).filter((part) => !part.startsWith("("));
  return `/${routeParts.join("/")}`.replace(/\/$/, "") || "/";
}

function detectFileKind(path: string, extension: string, content: string): FileKind {
  if (isTestPath(path)) return "test";
  if (extension === ".sql") return "sql";
  if (extension === ".md" || extension === ".mdx") return "doc";
  if (nextRouteForPath(path)) return "next-route";
  if (extension === ".tsx" || extension === ".jsx" || /<[A-Z][A-Za-z0-9]*\b/.test(content)) return "react-component";
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
      symbols.push({ name, kind: baseKind, filePath, exported });
    }
  }
  return symbols;
}

async function walk(root: string, current: string, graph: CodeGraph, ignoreMatcher: Ignore): Promise<void> {
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
      await walk(root, absolute, graph, ignoreMatcher);
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

    if (CODE_EXTENSIONS.has(extension)) {
      graph.imports.push(...extractImports(relativePath, content));
      graph.symbols.push(...extractSymbols(relativePath, content));
    }
  }
}

export async function scanProject(root: string): Promise<CodeGraph> {
  const ignoreMatcher = await loadRootIgnore(root);
  const graph: CodeGraph = {
    root,
    files: [],
    symbols: [],
    imports: [],
    exclusions: []
  };
  await walk(root, root, graph, ignoreMatcher);
  graph.files.sort((a, b) => a.path.localeCompare(b.path));
  graph.symbols.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
  graph.imports.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.source.localeCompare(b.source));
  graph.exclusions.sort((a, b) => a.path.localeCompare(b.path));
  return graph;
}

export function isSupportedCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(basename(path)).toLowerCase());
}
