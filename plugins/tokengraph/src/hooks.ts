#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { formatTaskReportFooter } from "./core/taskEstimator.js";
import { attachTaskHostContext, loadTaskLedger, type TaskHost } from "./core/taskLedger.js";
import { writeJsonAtomic } from "./core/storage.js";

const POINTER_SCHEMA_ID = "tokengraph-hook-session" as const;
const POINTER_SCHEMA_VERSION = 1 as const;
const POINTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 200;
const WINDOWS_FS_RETRY_ATTEMPTS = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TASK_AWARE_TOOLS = new Set([
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
]);

interface SessionPointer {
  schemaId: typeof POINTER_SCHEMA_ID;
  schemaVersion: typeof POINTER_SCHEMA_VERSION;
  sessionHash: string;
  taskId: string;
  root: string;
  turnId: string;
  updatedAt: string;
}

type HookOutput = Record<string, unknown>;
type PointerLoad = { status: "missing" } | { status: "corrupt" } | { status: "valid"; pointer: SessionPointer };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function dataRoot(): string | undefined {
  // Host plugin-data directory for session pointers, not workspace .tokengraph state.
  const value = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  return isIdentifier(value) ? resolve(value) : undefined;
}

function sessionsDirectory(root: string): string {
  return join(root, "sessions");
}

function pointerPath(root: string, hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error("Invalid session hash.");
  return join(sessionsDirectory(root), `${hash}.json`);
}

function reconstructPointer(value: unknown, expectedHash: string): SessionPointer | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["root", "schemaId", "schemaVersion", "sessionHash", "taskId", "turnId", "updatedAt"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined;
  if (
    value.schemaId !== POINTER_SCHEMA_ID ||
    value.schemaVersion !== POINTER_SCHEMA_VERSION ||
    value.sessionHash !== expectedHash ||
    typeof value.taskId !== "string" ||
    !UUID_PATTERN.test(value.taskId) ||
    typeof value.root !== "string" ||
    !isAbsolute(value.root) ||
    !isIdentifier(value.turnId) ||
    !isTimestamp(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    schemaId: POINTER_SCHEMA_ID,
    schemaVersion: POINTER_SCHEMA_VERSION,
    sessionHash: expectedHash,
    taskId: value.taskId,
    root: value.root,
    turnId: value.turnId,
    updatedAt: value.updatedAt
  };
}

async function loadPointer(root: string, hash: string): Promise<PointerLoad> {
  try {
    const parsed = JSON.parse(await readFile(pointerPath(root, hash), "utf8")) as unknown;
    const pointer = reconstructPointer(parsed, hash);
    return pointer ? { status: "valid", pointer } : { status: "corrupt" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    if (error instanceof SyntaxError) return { status: "corrupt" };
    throw error;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isTransientWindowsFsError(error: unknown): boolean {
  return process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String((error as NodeJS.ErrnoException).code));
}

async function retryTransientWindowsFs<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsFsError(error) || attempt >= WINDOWS_FS_RETRY_ATTEMPTS - 1) throw error;
      await wait(LOCK_WAIT_MS);
    }
  }
}

async function withPointerLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await operation();
      } finally {
        await handle.close();
        await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !isTransientWindowsFsError(error)) throw error;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { force: true });
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
      }
      await wait(LOCK_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for the session pointer lock.");
}

async function prunePointers(root: string, now = new Date()): Promise<void> {
  let files: string[];
  try {
    files = await readdir(sessionsDirectory(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const cutoff = now.getTime() - POINTER_RETENTION_MS;
  await Promise.all(files.filter((file) => HASH_PATTERN.test(file.slice(0, -5)) && file.endsWith(".json")).map(async (file) => {
    const hash = file.slice(0, -5);
    const path = pointerPath(root, hash);
    await withPointerLock(path, async () => {
      const loaded = await loadPointer(root, hash);
      if (loaded.status === "missing") return;
      const expired = loaded.status === "valid"
        ? Date.parse(loaded.pointer.updatedAt) < cutoff
        : (await stat(path)).mtimeMs < cutoff;
      if (expired) await retryTransientWindowsFs(async () => rm(path, { force: true }));
    });
  }));
}

function detectHost(): TaskHost {
  const explicit = process.env.TOKENGRAPH_HOOK_HOST;
  if (explicit === "codex" || explicit === "claude") return explicit;
  if (isIdentifier(process.env.PLUGIN_ROOT)) return "codex";
  if (isIdentifier(process.env.CLAUDE_PLUGIN_ROOT)) return "claude";
  return "unknown";
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.split("__").at(-1);
  if (!candidate || !/^tokengraph_[a-z0-9_]+$/.test(candidate) || !TASK_AWARE_TOOLS.has(candidate)) return undefined;
  return candidate;
}

function responsePayload(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response)) return undefined;
  const structured = isRecord(response.structuredContent)
    ? response.structuredContent
    : isRecord(response.structured_content)
      ? response.structured_content
      : undefined;
  if (structured) return structured;
  if (!Array.isArray(response.content) || response.content.length !== 1) return undefined;
  const item = response.content[0];
  if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return undefined;
  try {
    const parsed = JSON.parse(item.text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function responseReference(
  response: unknown,
  toolInput: unknown,
  hookInput: Record<string, unknown>,
  previous: PointerLoad
): { taskId: string; root: string } | undefined {
  const payload = responsePayload(response);
  if (!payload || typeof payload.taskId !== "string" || !UUID_PATTERN.test(payload.taskId)) return undefined;
  const candidates = [
    payload.root,
    isRecord(toolInput) ? toolInput.root : undefined,
    previous.status === "valid" && previous.pointer.taskId === payload.taskId ? previous.pointer.root : undefined,
    hookInput.cwd,
    process.env.CLAUDE_PROJECT_DIR,
    process.env.TOKENGRAPH_WORKSPACE_ROOT
  ];
  const root = candidates.find((candidate): candidate is string => typeof candidate === "string" && isAbsolute(candidate));
  return root ? { taskId: payload.taskId, root } : undefined;
}

function taskInputReference(value: unknown, previous: PointerLoad): { taskId: string; root: string } | undefined {
  if (!isRecord(value) || typeof value.taskId !== "string" || !UUID_PATTERN.test(value.taskId)) return undefined;
  if (typeof value.root === "string") {
    return isAbsolute(value.root) ? { taskId: value.taskId, root: value.root } : undefined;
  }
  if (value.root !== undefined || previous.status !== "valid" || previous.pointer.taskId !== value.taskId) return undefined;
  return { taskId: value.taskId, root: previous.pointer.root };
}

function turnId(input: Record<string, unknown>): string | undefined {
  if (isIdentifier(input.turn_id)) return input.turn_id;
  if (isIdentifier(input.prompt_id)) return input.prompt_id;
  if (isIdentifier(input.tool_use_id)) return input.tool_use_id;
  return undefined;
}

async function postToolUse(input: unknown): Promise<HookOutput> {
  if (!isRecord(input) || !isIdentifier(input.session_id)) return {};
  const currentSessionId = input.session_id;
  const toolName = normalizeToolName(input.tool_name);
  if (!toolName) return {};
  const pluginData = dataRoot();
  if (!pluginData) {
    return { systemMessage: "TokenGraph plugin data is unavailable; task lifecycle tracking was skipped." };
  }
  const hash = sessionHash(currentSessionId);
  const previous = await loadPointer(pluginData, hash);
  const reference = taskInputReference(input.tool_input, previous)
    ?? responseReference(input.tool_response, input.tool_input, input, previous);
  const currentTurnId = turnId(input);
  if (!reference || !currentTurnId) return {};
  try {
    await withPointerLock(pointerPath(pluginData, hash), async () => {
      const ledger = await loadTaskLedger(reference.root, reference.taskId);
      if (!ledger) throw new Error("ledger-unavailable");
      const detected = detectHost();
      const effectiveHost = detected === "unknown" ? ledger.host : detected;
      await retryTransientWindowsFs(async () => attachTaskHostContext(reference.root, reference.taskId, {
        host: effectiveHost,
        sessionId: currentSessionId,
        turnId: currentTurnId
      }));
      const pointer: SessionPointer = {
        schemaId: POINTER_SCHEMA_ID,
        schemaVersion: POINTER_SCHEMA_VERSION,
        sessionHash: hash,
        taskId: reference.taskId,
        root: reference.root,
        turnId: currentTurnId,
        updatedAt: new Date().toISOString()
      };
      await retryTransientWindowsFs(async () => writeJsonAtomic(pointerPath(pluginData, hash), pointer));
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ledger-unavailable") {
      return { systemMessage: "TokenGraph task ledger is unavailable; task lifecycle tracking was skipped." };
    }
    if (error instanceof Error && /Paused task .* is terminal/.test(error.message)) {
      return { systemMessage: `${error.message} Lifecycle tracking was skipped.` };
    }
    const code = (error as NodeJS.ErrnoException).code;
    return { systemMessage: `TokenGraph lifecycle state update failed${code ? ` (${code})` : ""}; tracking was skipped.` };
  }
  await prunePointers(pluginData);
  return {};
}

function retryWarning(ledgerStatus: string, footer?: string): HookOutput {
  if (ledgerStatus === "completed" && footer) {
    return { systemMessage: `TokenGraph completion footer is still missing. Append exactly: ${footer}` };
  }
  return { systemMessage: "TokenGraph task is still open without a pause-or-complete report; allowing stop to prevent a hook retry loop." };
}

async function stop(input: unknown): Promise<HookOutput> {
  if (!isRecord(input) || !isIdentifier(input.session_id)) {
    return { systemMessage: "TokenGraph received invalid Stop hook input; lifecycle enforcement was skipped." };
  }
  const pluginData = dataRoot();
  if (!pluginData) {
    return { systemMessage: "TokenGraph plugin data is unavailable; lifecycle enforcement was skipped." };
  }
  const loaded = await loadPointer(pluginData, sessionHash(input.session_id));
  if (loaded.status === "missing") return {};
  if (loaded.status === "corrupt") {
    return { systemMessage: "TokenGraph session pointer state is corrupt; lifecycle enforcement was skipped." };
  }
  const ledger = await loadTaskLedger(loaded.pointer.root, loaded.pointer.taskId);
  if (!ledger) {
    return { systemMessage: "TokenGraph task ledger is missing or unavailable; lifecycle enforcement was skipped." };
  }
  if (ledger.status === "paused") return {};
  const isRetry = input.stop_hook_active === true;
  if (ledger.status === "open" && ledger.lastDisposition === undefined) {
    if (isRetry) return retryWarning("open");
    const pauseCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: loaded.pointer.root, disposition: "pause" })})`;
    const completeCall = `tokengraph_task_report(${JSON.stringify({ taskId: loaded.pointer.taskId, root: loaded.pointer.root, disposition: "complete" })})`;
    return {
      decision: "block",
      reason: `Call exactly one of these exact calls, choosing pause if work is unfinished or complete if it is finished: ${pauseCall} OR ${completeCall}. Then report the returned status. Do not claim completion for an interrupt or API failure.`
    };
  }
  if (ledger.status === "completed" && ledger.completedReport) {
    const footer = formatTaskReportFooter(ledger.completedReport);
    const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    if (message.includes(footer)) return {};
    if (isRetry) return retryWarning("completed", footer);
    return { decision: "block", reason: `Append this exact canonical TokenGraph footer to the final response: ${footer}` };
  }
  return {};
}

async function readStdin(): Promise<unknown> {
  let content = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    content += chunk;
    if (content.length > 1_048_576) throw new Error("Hook input exceeded the size limit.");
  }
  return JSON.parse(content) as unknown;
}

async function main(): Promise<void> {
  const event = process.argv[2];
  let output: HookOutput;
  try {
    const input = await readStdin();
    output = event === "post-tool-use" ? await postToolUse(input) : event === "stop" ? await stop(input) : {};
  } catch {
    output = { systemMessage: "TokenGraph hook state could not be processed; lifecycle enforcement was skipped." };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();
