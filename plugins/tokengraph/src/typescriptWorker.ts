import { parentPort } from "node:worker_threads";

import ts from "typescript";

interface WorkerInput {
  id: number;
  filePath: string;
  source: string;
  maxNodes: number;
  maxSymbols: number;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isExported(node: ts.Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
}

function declarationKind(node: ts.Node, name: string, filePath: string): "function" | "class" | "component" | "const" | "type" | "interface" {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return "type";
  if (ts.isVariableStatement(node)) return /^[A-Z]/.test(name) && /\.[jt]sx$/.test(filePath) ? "component" : "const";
  return /^[A-Z]/.test(name) && /\.[jt]sx$/.test(filePath) ? "component" : "function";
}

function names(node: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name ? [node.name.text] : [];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  return [];
}

function parse(input: WorkerInput): { symbols: Array<Record<string, unknown>>; degradedReason?: string } {
  const sourceFile = ts.createSourceFile(input.filePath, input.source, ts.ScriptTarget.Latest, false, scriptKind(input.filePath));
  let nodeCount = 0;
  const count = (node: ts.Node): void => {
    nodeCount += 1;
    if (nodeCount > input.maxNodes) throw new Error("AST node limit exceeded.");
    ts.forEachChild(node, count);
  };
  count(sourceFile);
  const symbols = sourceFile.statements.flatMap((statement) => names(statement).map((name) => {
    const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(statement.end).line + 1;
    const kind = declarationKind(statement, name, input.filePath);
    return {
      name,
      kind,
      filePath: input.filePath,
      exported: isExported(statement),
      startLine: start,
      endLine: end,
      signature: `${kind} ${name}`,
      provenance: "typescript" as const,
      parserVersion: ts.version
    };
  }));
  const degradedReason = symbols.length > input.maxSymbols ? "symbol limit exceeded" : undefined;
  return { symbols: symbols.slice(0, input.maxSymbols), ...(degradedReason ? { degradedReason } : {}) };
}

parentPort?.on("message", (input: WorkerInput) => {
  try {
    parentPort?.postMessage({ id: input.id, ok: true, ...parse(input) });
  } catch (error) {
    parentPort?.postMessage({ id: input.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
