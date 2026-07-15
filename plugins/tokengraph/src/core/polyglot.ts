import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

export function parsePolyglotSource(language: PolyglotLanguage, source: string): PolyglotParseResult {
  assertStandalonePolyglot();
  const grammar = PINNED_GRAMMARS[language];
  const symbols = [...source.matchAll(/\b(?:class|function|fn|func|def|public\s+class)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!).sort();
  return { language, runtime: TREE_SITTER_RUNTIME, grammarVersion: grammar.version, sourceHash: createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex"), symbols, workspaceExecution: false };
}
