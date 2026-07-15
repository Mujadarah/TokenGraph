import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { CodeSymbol } from "./types.js";

export interface TypeScriptParseOptions {
  maxNodes: number;
  maxSymbols: number;
  timeoutMs: number;
}

interface ParseRequest {
  id: number;
  filePath: string;
  source: string;
  options: TypeScriptParseOptions;
  resolve: (value: { symbols: CodeSymbol[]; degradedReason?: string }) => void;
  reject: (error: Error) => void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  symbols?: CodeSymbol[];
  degradedReason?: string;
  message?: string;
}

let nextId = 1;
let sharedWorker: Worker | undefined;
let starting = false;
let active: (ParseRequest & { timer: NodeJS.Timeout }) | undefined;
const queue: ParseRequest[] = [];

async function workerPath(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "typescript-worker.cjs"), resolve(here, "../../dist/typescript-worker.cjs")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the source-tree build location after the bundled location.
    }
  }
  throw new Error("The bundled TypeScript parser worker is missing.");
}

function rejectActive(error: Error): void {
  if (!active) return;
  clearTimeout(active.timer);
  active.reject(error);
  active = undefined;
}

async function resetWorker(worker: Worker, error: Error): Promise<void> {
  if (sharedWorker !== worker) return;
  sharedWorker = undefined;
  rejectActive(error);
  await worker.terminate().catch(() => undefined);
  void startNext();
}

async function ensureWorker(): Promise<Worker> {
  if (sharedWorker) return sharedWorker;
  const worker = new Worker(await workerPath());
  worker.unref();
  worker.on("message", (message: WorkerResponse) => {
    if (sharedWorker !== worker || !active || message.id !== active.id) return;
    const request = active;
    clearTimeout(request.timer);
    active = undefined;
    if (message.ok && message.symbols) {
      request.resolve({ symbols: message.symbols, ...(message.degradedReason ? { degradedReason: message.degradedReason } : {}) });
    } else {
      request.reject(new Error(message.message ?? "TypeScript parser worker failed."));
    }
    void startNext();
  });
  worker.on("error", (error) => void resetWorker(worker, error));
  worker.on("exit", (code) => {
    if (sharedWorker === worker && code !== 0) void resetWorker(worker, new Error(`TypeScript parser worker exited with code ${code}.`));
  });
  sharedWorker = worker;
  return worker;
}

async function startNext(): Promise<void> {
  if (active || starting || queue.length === 0) return;
  starting = true;
  try {
    const worker = await ensureWorker();
    const request = queue.shift();
    if (!request) return;
    const timer = setTimeout(() => {
      void resetWorker(worker, new Error("TypeScript parser worker timed out."));
    }, request.options.timeoutMs);
    active = { ...request, timer };
    worker.postMessage({
      id: request.id,
      filePath: request.filePath,
      source: request.source,
      maxNodes: request.options.maxNodes,
      maxSymbols: request.options.maxSymbols
    });
  } catch (error) {
    const request = queue.shift();
    request?.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    starting = false;
    if (!active && queue.length > 0) void startNext();
  }
}

export async function parseTypeScriptSource(filePath: string, source: string, options: TypeScriptParseOptions): Promise<{ symbols: CodeSymbol[]; degradedReason?: string }> {
  return new Promise((resolvePromise, reject) => {
    queue.push({ id: nextId++, filePath, source, options, resolve: resolvePromise, reject });
    void startNext();
  });
}
