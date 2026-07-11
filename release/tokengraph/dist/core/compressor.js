import { estimateSavings } from "./token.js";
const ACTIONABLE_PATTERNS = [
    /\b(?:fail|failed|failure|failures)\b/i,
    /\berrors?\b/i,
    /\bAssertionError\b/i,
    /\bTypeError\b/i,
    /\bReferenceError\b/i,
    /\bSyntaxError\b/i,
    /\bat\s+.*\.(?:ts|tsx|js|jsx|sql):\d+:\d+/i,
    /\bwarning\b/i,
    /\bconflict\b/i,
    /\bmissing\b/i
];
const MAX_INPUT_CHARS = 1024 * 1024;
const MAX_INPUT_LINES = 10_000;
export function compressOutput(input) {
    const truncatedByChars = input.text.length > MAX_INPUT_CHARS;
    const boundedText = truncatedByChars ? input.text.slice(0, MAX_INPUT_CHARS) : input.text;
    const lines = boundedText.split(/\r?\n/, MAX_INPUT_LINES + 1).map((line) => line.trim());
    const truncatedByLines = lines.length > MAX_INPUT_LINES;
    if (truncatedByLines) {
        lines.length = MAX_INPUT_LINES;
    }
    const maxLines = input.maxLines ?? 20;
    const seen = new Set();
    const keyLines = [];
    for (const line of lines) {
        if (!line || seen.has(line) || !ACTIONABLE_PATTERNS.some((pattern) => pattern.test(line))) {
            continue;
        }
        seen.add(line);
        keyLines.push(line);
        if (keyLines.length >= maxLines) {
            break;
        }
    }
    const fallbackLines = keyLines.length > 0 ? keyLines : lines.filter((line) => line).slice(0, maxLines);
    const summary = fallbackLines.length
        ? `${input.kind} output: ${fallbackLines.slice(0, 3).join(" | ")}`
        : `${input.kind} output contained no actionable lines.`;
    const compressedText = [summary, ...fallbackLines].join("\n");
    const estimatedTokens = estimateSavings(input.text, compressedText);
    const omittedLineCount = Math.max(0, lines.length - fallbackLines.length) + (truncatedByChars || truncatedByLines ? 1 : 0);
    return {
        kind: input.kind,
        summary,
        keyLines: fallbackLines,
        omittedLineCount,
        estimatedTokens
    };
}
