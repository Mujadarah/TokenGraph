const DENSE_SCRIPT_CHARACTER = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;
const PICTOGRAPHIC_CHARACTER = /\p{Extended_Pictographic}/u;
export function estimateTokens(text) {
    if (!text.trim()) {
        return 0;
    }
    let denseCharacters = 0;
    let regularCharacters = 0;
    for (const character of text) {
        if (DENSE_SCRIPT_CHARACTER.test(character) || PICTOGRAPHIC_CHARACTER.test(character)) {
            denseCharacters += 1;
        }
        else {
            regularCharacters += 1;
        }
    }
    return Math.max(1, denseCharacters + Math.ceil(regularCharacters / 4));
}
export function estimateSavings(originalText, compressedText) {
    const original = estimateTokens(originalText);
    const compressed = estimateTokens(compressedText);
    return {
        original,
        compressed,
        avoided: Math.max(0, original - compressed)
    };
}
export function tokenize(text) {
    return Array.from(new Set(text
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9_/$.[\]-]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length > 1)));
}
