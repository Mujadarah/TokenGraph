import { createHash } from "node:crypto";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { Language, Parser } from "web-tree-sitter";

interface WorkerInput {
  language: "python" | "go" | "rust" | "java";
  source: string;
  assetRoot: string;
  grammar: { asset: string };
  symbolNodes: string[];
  limits: { maxNodes: number; maxSymbols: number };
}

const input = workerData as WorkerInput;

function heuristicSymbols(language: WorkerInput["language"], source: string): string[] {
  const keyword = language === "python" ? "def|class" : language === "go" ? "func|type" : language === "rust" ? "fn|struct|enum|trait" : "class|interface|enum|record|public\\s+class";
  return [...source.matchAll(new RegExp(`\\b(?:${keyword})\\s+([A-Za-z_][A-Za-z0-9_]*)`, "g"))].map((match) => match[1]!).sort();
}

function nodeName(node: { childForFieldName(name: string): { text: string; childForFieldName(name: string): { text: string } | null } | null }): string | undefined {
  return node.childForFieldName("name")?.text ?? node.childForFieldName("declarator")?.childForFieldName("name")?.text;
}

function nodeKind(language: WorkerInput["language"], type: string): "function" | "class" | "type" {
  if (language === "python") return type === "class_definition" ? "class" : "function";
  if (language === "go") return type.includes("function") || type.includes("method") ? "function" : "type";
  if (language === "rust") return type === "function_item" ? "function" : type === "struct_item" ? "class" : "type";
  return type.includes("method") || type.includes("constructor") ? "function" : type.includes("class") ? "class" : "type";
}

async function run(): Promise<void> {
  await Parser.init({ locateFile: (file: string) => join(input.assetRoot, file) });
  const languageParser = await Language.load(join(input.assetRoot, input.grammar.asset));
  const parser = new Parser();
  parser.setLanguage(languageParser);
  const tree = parser.parse(input.source);
  if (!tree) throw new Error("Tree-sitter returned no syntax tree.");
  if (tree.rootNode.descendantCount > input.limits.maxNodes) throw new Error("AST node limit exceeded.");
  const nodes = tree.rootNode.descendantsOfType(input.symbolNodes);
  let symbolDetails = nodes.map((node) => {
    const name = nodeName(node);
    const kind = nodeKind(input.language, node.type);
    return name ? {
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: `${kind} ${name}`
    } : undefined;
  }).filter((value): value is NonNullable<typeof value> => Boolean(value)).sort((left, right) => left.name.localeCompare(right.name) || left.startLine - right.startLine);
  const errorNodeCount = tree.rootNode.descendantsOfType("ERROR").length;
  const degradedReason = symbolDetails.length > input.limits.maxSymbols ? "symbol limit exceeded" : undefined;
  symbolDetails = symbolDetails.slice(0, input.limits.maxSymbols);
  tree.delete();
  parser.delete();
  parentPort?.postMessage({ ok: true, result: { symbols: symbolDetails.map((symbol) => symbol.name), symbolDetails, parser: "tree-sitter", errorNodeCount, degradedReason } });
}

void run().catch((error: unknown) => {
  parentPort?.postMessage({
    ok: true,
    result: {
      symbols: heuristicSymbols(input.language, input.source).slice(0, input.limits.maxSymbols),
      parser: "heuristic",
      degradedReason: error instanceof Error ? error.message : String(error),
      sourceHash: createHash("sha256").update(input.source).digest("hex")
    }
  });
});
