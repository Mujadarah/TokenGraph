import { createHash } from "node:crypto";

export function normalizeCanonicalText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function normalizeWorkspacePath(value: string): string {
  return normalizeCanonicalText(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeCanonicalText(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value;
}

export function canonicalize<T>(value: T): T {
  return canonicalValue(value) as T;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
