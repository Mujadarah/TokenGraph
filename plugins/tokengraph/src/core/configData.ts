import { Worker } from "node:worker_threads";

export interface ConfigurationLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  timeoutMs?: number;
}

const DEFAULT_LIMITS: Required<ConfigurationLimits> = { maxBytes: 512 * 1024, maxDepth: 32, maxNodes: 20_000, timeoutMs: 2_000 };
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
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) throw new Error("Configuration byte limit exceeded.");
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    const unsafe = new Set(["__proto__", "prototype", "constructor"]);
    const stripComments = (value) => value.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").replace(/(^|\\s)\\/\\/.*$/gm, "$1");
    const stripCommas = (value) => value.replace(/,\\s*([}\\]])/g, "$1");
    const validate = (value, limits, depth = 0, counter = { value: 0 }) => {
      counter.value += 1;
      if (counter.value > limits.maxNodes) throw new Error("Configuration node limit exceeded.");
      if (depth > limits.maxDepth) throw new Error("Configuration nesting limit exceeded.");
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (unsafe.has(key)) throw new Error("Unsafe configuration key " + key + ".");
        validate(entry, limits, depth + 1, counter);
      }
    };
    try {
      const parsed = JSON.parse(stripCommas(stripComments(workerData.text)));
      validate(parsed, workerData.limits);
      parentPort.postMessage({ ok: true, value: parsed });
    } catch (error) {
      parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { text, limits } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Configuration parser worker timed out."));
    }, limits.timeoutMs);
    worker.once("message", (message: { ok: boolean; value?: unknown; message?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok) resolve(message.value);
      else reject(new Error(message.message ?? "Configuration parsing failed."));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
