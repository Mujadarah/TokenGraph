import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

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
  errorNodeCount?: number;
  symbolDetails?: Array<{ name: string; kind: "function" | "class" | "type"; startLine: number; endLine: number; signature: string }>;
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

let runtimeReady: Promise<void> | undefined;
async function ensureRuntime(assetRoot: string): Promise<void> {
  runtimeReady ??= Parser.init({ locateFile: (file: string) => join(assetRoot, file) });
  await runtimeReady;
}

function heuristicSymbols(language: PolyglotLanguage, source: string): string[] {
  const keyword = language === "python" ? "def|class" : language === "go" ? "func|type" : language === "rust" ? "fn|struct|enum|trait" : "class|interface|enum|record|public\\s+class";
  return [...source.matchAll(new RegExp(`\\b(?:${keyword})\\s+([A-Za-z_][A-Za-z0-9_]*)`, "g"))].map((match) => match[1]!).sort();
}

function symbolNodes(language: PolyglotLanguage): string[] {
  if (language === "python") return ["function_definition", "class_definition"];
  if (language === "go") return ["function_declaration", "method_declaration", "type_declaration"];
  if (language === "rust") return ["function_item", "struct_item", "enum_item", "trait_item"];
  return ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "method_declaration", "constructor_declaration"];
}

function nodeName(node: Node): string | undefined {
  return node.childForFieldName("name")?.text ?? node.childForFieldName("declarator")?.childForFieldName("name")?.text;
}

function nodeKind(language: PolyglotLanguage, node: Node): "function" | "class" | "type" {
  if (language === "python") return node.type === "class_definition" ? "class" : "function";
  if (language === "go") return node.type.includes("function") || node.type.includes("method") ? "function" : "type";
  if (language === "rust") return node.type === "function_item" ? "function" : node.type === "struct_item" ? "class" : "type";
  return node.type.includes("method") || node.type.includes("constructor") ? "function" : node.type.includes("class") ? "class" : "type";
}

export async function parsePolyglotSource(language: PolyglotLanguage, source: string, assetRoot?: string): Promise<PolyglotParseResult> {
  assertStandalonePolyglot();
  const grammar = PINNED_GRAMMARS[language];
  const normalized = source.replace(/\r\n?/g, "\n");
  const root = assetRoot ?? await defaultAssetRoot();
  try {
    await ensureRuntime(root);
    const languageParser = await Language.load(await loadGrammarAsset(root, language));
    const parser = new Parser();
    parser.setLanguage(languageParser);
    const tree = parser.parse(normalized);
    const nodes = tree?.rootNode.descendantsOfType(symbolNodes(language)) ?? [];
    const symbolDetails = nodes.map((node) => {
      const name = nodeName(node);
      return name ? { name, kind: nodeKind(language, node), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, signature: node.text.split(/\r?\n/, 1)[0]?.trim() ?? name } : undefined;
    }).filter((value): value is NonNullable<typeof value> => Boolean(value)).sort((a, b) => a.name.localeCompare(b.name) || a.startLine - b.startLine);
    const symbols = symbolDetails.map((symbol) => symbol.name);
    const errorNodeCount = tree?.rootNode.descendantCount ? tree.rootNode.descendantsOfType("ERROR").length : 0;
    tree?.delete();
    parser.delete();
    return { language, runtime: TREE_SITTER_RUNTIME, grammarVersion: grammar.version, sourceHash: createHash("sha256").update(normalized).digest("hex"), symbols, workspaceExecution: false, parser: "tree-sitter", symbolDetails, ...(errorNodeCount ? { errorNodeCount } : {}) };
  } catch {
    return { language, runtime: TREE_SITTER_RUNTIME, grammarVersion: grammar.version, sourceHash: createHash("sha256").update(normalized).digest("hex"), symbols: heuristicSymbols(language, normalized), workspaceExecution: false, parser: "heuristic" };
  }
}
