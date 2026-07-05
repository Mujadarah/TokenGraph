import { estimateSavings } from "./token.js";
import type { CompressedOutput } from "./types.js";

const ACTIONABLE_PATTERNS = [
  /\bFAIL\b/i,
  /\bError\b/i,
  /\bAssertionError\b/i,
  /\bTypeError\b/i,
  /\bReferenceError\b/i,
  /\bSyntaxError\b/i,
  /\bat\s+.*\.(?:ts|tsx|js|jsx|sql):\d+:\d+/i,
  /\bwarning\b/i,
  /\bconflict\b/i,
  /\bmissing\b/i
];

export function compressOutput(input: { kind: CompressedOutput["kind"]; text: string; maxLines?: number }): CompressedOutput {
  const lines = input.text.split(/\r?\n/).map((line) => line.trim());
  const maxLines = input.maxLines ?? 20;
  const keyLines = lines
    .filter((line) => line.trim() && ACTIONABLE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, maxLines);
  const fallbackLines = keyLines.length > 0 ? keyLines : lines.filter((line) => line.trim()).slice(0, maxLines);
  const summary = fallbackLines.length
    ? `${input.kind} output: ${fallbackLines.slice(0, 3).join(" | ")}`
    : `${input.kind} output contained no actionable lines.`;
  const compressedText = [summary, ...fallbackLines].join("\n");

  const estimatedTokens = estimateSavings(input.text, compressedText);
  const omittedLineCount = Math.max(0, lines.length - fallbackLines.length);
  return {
    kind: input.kind,
    summary,
    keyLines: fallbackLines,
    omittedLineCount,
    estimatedTokens: {
      ...estimatedTokens,
      avoided: omittedLineCount > 0 ? Math.max(1, estimatedTokens.avoided) : estimatedTokens.avoided
    }
  };
}
