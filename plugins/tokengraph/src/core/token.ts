export function estimateTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateSavings(originalText: string, compressedText: string) {
  const original = estimateTokens(originalText);
  const compressed = estimateTokens(compressedText);
  return {
    original,
    compressed,
    avoided: Math.max(0, original - compressed)
  };
}

export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9_/$.[\]-]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length > 1)
    )
  );
}
