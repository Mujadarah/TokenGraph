export interface ConfigurationLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

const DEFAULT_LIMITS: Required<ConfigurationLimits> = { maxBytes: 512 * 1024, maxDepth: 32, maxNodes: 20_000 };
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function stripTypeScriptComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function validateData(value: unknown, limits: Required<ConfigurationLimits>, depth = 0, counter = { value: 0 }): void {
  counter.value += 1;
  if (counter.value > limits.maxNodes) throw new Error("Configuration node limit exceeded.");
  if (depth > limits.maxDepth) throw new Error("Configuration nesting limit exceeded.");
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) validateData(entry, limits, depth + 1, counter);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe configuration key ${key}.`);
    validateData(entry, limits, depth + 1, counter);
  }
}

export function parseConfigurationData(text: string, options: ConfigurationLimits = {}): unknown {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) throw new Error("Configuration byte limit exceeded.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripTypeScriptComments(text)));
  } catch {
    throw new Error("Configuration must be valid JSON data; executable configuration is not supported.");
  }
  validateData(parsed, limits);
  return parsed;
}

export async function parseConfigurationDataBounded(text: string, options: ConfigurationLimits = {}): Promise<unknown> {
  return parseConfigurationData(text, options);
}
