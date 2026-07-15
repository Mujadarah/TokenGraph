import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const TREE_SITTER_RUNTIME = "web-tree-sitter@0.26.11" as const;

export const PINNED_GRAMMARS = {
  python: { version: "v0.25.0", asset: "tree-sitter-python.wasm" },
  go: { version: "v0.25.0", asset: "tree-sitter-go.wasm" },
  rust: { version: "v0.24.2", asset: "tree-sitter-rust.wasm" },
  java: { version: "v0.23.5", asset: "tree-sitter-java.wasm" }
} as const;

export type PolyglotLanguage = keyof typeof PINNED_GRAMMARS;

export interface PolyglotParseResult {
  language: PolyglotLanguage;
  runtime: typeof TREE_SITTER_RUNTIME;
  grammarVersion: string;
  sourceHash: string;
  symbols: string[];
  workspaceExecution: false;
  parser: "tree-sitter" | "heuristic";
  degradedReason?: string;
  errorNodeCount?: number;
  symbolDetails?: Array<{ name: string; kind: "function" | "class" | "type"; startLine: number; endLine: number; signature: string }>;
}

export interface PolyglotParseLimits {
  maxBytes?: number;
  maxSymbols?: number;
  maxNodes?: number;
  timeoutMs?: number;
}

export function assertStandalonePolyglot(options: { workspaceExecution?: boolean } = {}): void {
  if (options.workspaceExecution === true) throw new Error("Polyglot parser execution must remain standalone and cannot execute workspace code.");
}

export async function assertGrammarAssets(assetRoot: string): Promise<void> {
  for (const grammar of Object.values(PINNED_GRAMMARS)) await access(resolve(assetRoot, grammar.asset));
}

export async function loadGrammarAsset(assetRoot: string, language: PolyglotLanguage): Promise<Uint8Array> {
  assertStandalonePolyglot();
  const content = await readFile(resolve(assetRoot, PINNED_GRAMMARS[language].asset));
  if (!content.length) throw new Error(`Empty WASM grammar asset for ${language}.`);
  return content;
}

async function defaultAssetRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../../assets/grammars"), resolve(here, "../assets/grammars")];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, PINNED_GRAMMARS.python.asset));
      return candidate;
    } catch {
      // Try the next self-contained package layout.
    }
  }
  throw new Error("No bundled Tree-sitter grammar assets were found.");
}

async function bundledWorkerPath(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "polyglot-worker.js"), resolve(here, "../../dist/polyglot-worker.js")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the source-tree build location after the bundled location.
    }
  }
  throw new Error("The bundled polyglot parser worker is missing.");
}

function symbolNodes(language: PolyglotLanguage): string[] {
  if (language === "python") return ["function_definition", "class_definition"];
  if (language === "go") return ["function_declaration", "method_declaration", "type_declaration"];
  if (language === "rust") return ["function_item", "struct_item", "enum_item", "trait_item"];
  return ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "method_declaration", "constructor_declaration"];
}

const POLYGLOT_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { createHash } = require("node:crypto");
  const { join } = require("node:path");
  const heuristicSymbols = (language, source) => {
    const keyword = language === "python" ? "def|class" : language === "go" ? "func|type" : language === "rust" ? "fn|struct|enum|trait" : "class|interface|enum|record|public\\\\s+class";
    return [...source.matchAll(new RegExp("\\\\b(?:" + keyword + ")\\\\s+([A-Za-z_][A-Za-z0-9_]*)", "g"))].map((match) => match[1]).sort();
  };
  const nodeName = (node) => node.childForFieldName("name")?.text ?? node.childForFieldName("declarator")?.childForFieldName("name")?.text;
  const nodeKind = (language, node) => {
    if (language === "python") return node.type === "class_definition" ? "class" : "function";
    if (language === "go") return node.type.includes("function") || node.type.includes("method") ? "function" : "type";
    if (language === "rust") return node.type === "function_item" ? "function" : node.type === "struct_item" ? "class" : "type";
    return node.type.includes("method") || node.type.includes("constructor") ? "function" : node.type.includes("class") ? "class" : "type";
  };
  (async () => {
    const web = await import("web-tree-sitter");
    await web.Parser.init({ locateFile: (file) => join(workerData.assetRoot, file) });
    const languageParser = await web.Language.load(join(workerData.assetRoot, workerData.grammar.asset));
    const parser = new web.Parser();
    parser.setLanguage(languageParser);
    const tree = parser.parse(workerData.source);
    if (!tree) throw new Error("Tree-sitter returned no syntax tree.");
    if (tree.rootNode.descendantCount > workerData.limits.maxNodes) throw new Error("AST node limit exceeded.");
    const nodes = tree.rootNode.descendantsOfType(workerData.symbolNodes);
    let symbolDetails = nodes.map((node) => {
      const name = nodeName(node);
      return name ? { name, kind: nodeKind(workerData.language, node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, signature: node.text.split(/\\r?\\n/, 1)[0]?.trim() ?? name } : undefined;
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name) || a.startLine - b.startLine);
    const errorNodeCount = tree.rootNode.descendantsOfType("ERROR").length;
    const degradedReason = symbolDetails.length > workerData.limits.maxSymbols ? "symbol limit exceeded" : undefined;
    symbolDetails = symbolDetails.slice(0, workerData.limits.maxSymbols);
    tree.delete();
    parser.delete();
    parentPort.postMessage({ ok: true, result: { symbols: symbolDetails.map((symbol) => symbol.name), symbolDetails, parser: "tree-sitter", errorNodeCount, degradedReason } });
  })().catch((error) => {
    const degradedReason = error instanceof Error ? error.message : String(error);
    const symbols = heuristicSymbols(workerData.language, workerData.source).slice(0, workerData.limits.maxSymbols);
    parentPort.postMessage({ ok: true, result: { symbols, parser: "heuristic", degradedReason } });
  });
`;

export async function parsePolyglotSource(language: PolyglotLanguage, source: string, assetRoot?: string, options: PolyglotParseLimits = {}): Promise<PolyglotParseResult> {
  assertStandalonePolyglot();
  const grammar = PINNED_GRAMMARS[language];
  const normalized = source.replace(/\r\n?/g, "\n");
  const root = assetRoot ?? await defaultAssetRoot();
  const workerPath = await bundledWorkerPath();
  const limits = {
    maxBytes: options.maxBytes ?? 512 * 1024,
    maxSymbols: options.maxSymbols ?? 10_000,
    maxNodes: options.maxNodes ?? 250_000,
    timeoutMs: options.timeoutMs ?? 2_000
  };
  if (Buffer.byteLength(normalized, "utf8") > limits.maxBytes) throw new Error("AST parsed file byte limit exceeded.");
  const parsed = await new Promise<Pick<PolyglotParseResult, "symbols" | "symbolDetails" | "parser" | "errorNodeCount" | "degradedReason">>((resolvePromise, reject) => {
    const worker = new Worker(workerPath, { workerData: { language, source: normalized, assetRoot: root, grammar, symbolNodes: symbolNodes(language), limits } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("AST parser worker timed out."));
    }, limits.timeoutMs);
    worker.once("message", (message: { ok: boolean; result?: Pick<PolyglotParseResult, "symbols" | "symbolDetails" | "parser" | "errorNodeCount" | "degradedReason">; message?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok && message.result) resolvePromise(message.result);
      else reject(new Error(message.message ?? "AST parser worker failed."));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return {
    language,
    runtime: TREE_SITTER_RUNTIME,
    grammarVersion: grammar.version,
    sourceHash: createHash("sha256").update(normalized).digest("hex"),
    symbols: parsed.symbols,
    workspaceExecution: false,
    parser: parsed.parser,
    ...(parsed.symbolDetails ? { symbolDetails: parsed.symbolDetails } : {}),
    ...(parsed.errorNodeCount ? { errorNodeCount: parsed.errorNodeCount } : {}),
    ...(parsed.degradedReason ? { degradedReason: parsed.degradedReason } : {})
  };
}
