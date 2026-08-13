import { TARGETS } from "./generate-native-lock-manifest.mjs";

export const INSTALLABLE_ASSET_PATHS = Object.freeze([
  "grammars/tree-sitter-go.wasm",
  "grammars/tree-sitter-java.wasm",
  "grammars/tree-sitter-python.wasm",
  "grammars/tree-sitter-rust.wasm",
  "grammars/web-tree-sitter.wasm",
  "native-lock/THIRD_PARTY_NOTICES.txt",
  "native-lock/manifest.json",
  ...TARGETS.map((target) => `native-lock/${target.id}/${target.file}`)
].sort());
