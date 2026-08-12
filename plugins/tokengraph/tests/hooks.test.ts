import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { formatTaskReportFooter } from "../src/core/taskEstimator.js";
import {
  __compareHostWorkspaceStatsForTests,
  attestHostWorkspace,
  loadHostWorkspaceAttestation,
  removeHostWorkspaceAttestation
} from "../src/core/hostWorkspace.js";
import {
  createTaskLedger,
  loadTaskLedger,
  recordTaskEvent,
  setTaskDisposition,
  type TaskEvent
} from "../src/core/taskLedger.js";
import { externalHooksEntry, externalRuntimeEnvironment } from "./support/externalRuntime.js";

const hookEntry = process.env.TOKENGRAPH_HOOK_ENTRY ? resolve(process.env.TOKENGRAPH_HOOK_ENTRY) : externalHooksEntry;
const hookPluginRoot = resolve(dirname(hookEntry), "..");
const roots: string[] = [];
const attestationPaths: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function taskEvent(): TaskEvent {
  return {
    id: randomUUID(),
    fingerprint: randomUUID(),
    category: "context",
    toolName: "tokengraph_query_context",
    originalTokens: 100,
    compactTokens: 40,
    overheadTokens: 10,
    confidence: "medium",
    timestamp: new Date().toISOString(),
    qualityChecks: [{ name: "tests", passed: true }]
  };
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  output: Record<string, unknown>;
}

async function runHook(
  event: string,
  input: unknown,
  env: Record<string, string | undefined> = {},
  options: { extraArgs?: string[]; rawInput?: string } = {}
): Promise<HookRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnv: NodeJS.ProcessEnv = externalRuntimeEnvironment({
      PLUGIN_ROOT: undefined,
      PLUGIN_DATA: undefined,
      CLAUDE_PLUGIN_ROOT: undefined,
      CLAUDE_PLUGIN_DATA: undefined,
      TOKENGRAPH_HOOK_HOST: undefined,
      ...env
    });
    for (const key of Object.keys(childEnv)) {
      if (childEnv[key] === undefined) delete childEnv[key];
    }
    const child = spawn(process.execPath, [hookEntry, event, ...(options.extraArgs ?? [])], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      let output: Record<string, unknown>;
      try {
        output = JSON.parse(stdout) as Record<string, unknown>;
      } catch (error) {
        rejectPromise(new Error(`Hook emitted invalid JSON: ${stdout || "<empty>"}; ${String(error)}`));
        return;
      }
      resolvePromise({ code, stdout, stderr, output });
    });
    child.stdin.end(options.rawInput ?? `${JSON.stringify(input)}\n`);
  });
}

async function attestationPath(sessionId: string, pluginRoot = hookPluginRoot): Promise<string> {
  const canonicalPluginRoot = await realpath(pluginRoot);
  const pluginHash = createHash("sha256").update(canonicalPluginRoot).digest("hex");
  const sessionIdHash = createHash("sha256").update(sessionId).digest("hex");
  const path = join(tmpdir(), "tokengraph-host-workspaces", pluginHash, `${sessionIdHash}.json`);
  attestationPaths.push(path);
  return path;
}

function pluginEnvironment(dataRoot: string): Record<string, string> {
  return { PLUGIN_ROOT: hookPluginRoot, PLUGIN_DATA: dataRoot };
}

async function attestWorkspace(
  root: string,
  dataRoot: string,
  sessionId = "session-private-value",
  env: Record<string, string | undefined> = pluginEnvironment(dataRoot)
): Promise<HookRun> {
  await attestationPath(sessionId, env.PLUGIN_ROOT ?? env.CLAUDE_PLUGIN_ROOT ?? hookPluginRoot);
  return runHook("session-start", {
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: root
  }, env);
}

function pointerPath(dataRoot: string, sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex");
  return join(dataRoot, "sessions", `${hash}.json`);
}

function postInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: "session-private-value",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "mcp__tokengraph__tokengraph_query_context",
    tool_input: {},
    tool_response: {},
    ...overrides
  };
}

function stopInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "Stop",
    session_id: "session-private-value",
    turn_id: "turn-stop",
    stop_hook_active: false,
    last_assistant_message: "Work summary without a TokenGraph completion claim.",
    ...overrides
  };
}

async function attachPointer(
  root: string,
  dataRoot: string,
  taskId: string,
  options: { sessionId?: string; turnId?: string; toolName?: string; env?: Record<string, string | undefined>; attest?: boolean } = {}
): Promise<HookRun> {
  const sessionId = options.sessionId ?? "session-private-value";
  const env = {
    CLAUDE_PLUGIN_ROOT: hookPluginRoot,
    CLAUDE_PLUGIN_DATA: dataRoot,
    ...options.env
  };
  if (options.attest !== false) {
    const attested = await attestWorkspace(root, dataRoot, sessionId, env);
    expect(attested.output).toEqual({});
  }
  return runHook("post-tool-use", postInput({
    session_id: sessionId,
    turn_id: options.turnId ?? "turn-1",
    tool_name: options.toolName ?? "mcp__tokengraph__tokengraph_query_context",
    tool_input: { root },
    tool_response: { structuredContent: { taskId, root } }
  }), env);
}

afterEach(async () => {
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...attestationPaths.splice(0).map((path) => rm(path, { force: true }))
  ]);
});

describe("built lifecycle hook process", () => {
  it("compares exact bigint identities for files, directories, and same-directory renames", () => {
    const base = {
      dev: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      ino: BigInt(Number.MAX_SAFE_INTEGER) + 3n,
      mode: 0o100600n,
      nlink: 1n,
      size: 257n,
      birthtimeNs: 9_000_000_000_000_000_001n,
      mtimeNs: 9_000_000_000_000_000_101n,
      ctimeNs: 9_000_000_000_000_000_201n
    };
    expect(Number(base.dev)).toBe(Number(base.dev + 1n));
    expect(__compareHostWorkspaceStatsForTests(base, { ...base, dev: base.dev + 1n }, "file")).toBe(false);
    expect(Number(base.mtimeNs) / 1_000_000).toBe(Number(base.mtimeNs + 1n) / 1_000_000);
    expect(__compareHostWorkspaceStatsForTests(base, { ...base, mtimeNs: base.mtimeNs + 1n }, "file")).toBe(false);

    expect(__compareHostWorkspaceStatsForTests(base, {
      ...base, nlink: 5n, size: 263n, mtimeNs: 9_000_000_000_000_000_301n, ctimeNs: 9_000_000_000_000_000_401n
    }, "directory")).toBe(true);
    for (const field of ["dev", "ino", "mode", "birthtimeNs"] as const) {
      expect(__compareHostWorkspaceStatsForTests(base, { ...base, [field]: base[field] + 1n }, "directory"), field).toBe(false);
    }

    expect(__compareHostWorkspaceStatsForTests(base, {
      ...base, birthtimeNs: base.birthtimeNs + 1n, ctimeNs: base.ctimeNs + 1n
    }, "rename")).toBe(true);
    for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs"] as const) {
      expect(__compareHostWorkspaceStatsForTests(base, { ...base, [field]: base[field] + 1n }, "rename"), field).toBe(false);
    }
  });

  it("refreshes the same Desktop session attestation from SessionStart through UserPromptSubmit", async () => {
    const root = await makeRoot("tokengraph-hook-workspace-");
    const dataRoot = await makeRoot("tokengraph-hook-workspace-data-");
    const secret = "prompt-content-must-not-persist";
    const env = pluginEnvironment(dataRoot);
    const sessionId = randomUUID();
    const path = await attestationPath(sessionId);

    for (const lifecycle of [
      { command: "session-start" as const, event: "SessionStart", turnId: "turn-start" },
      { command: "user-prompt-submit" as const, event: "UserPromptSubmit", turnId: "turn-prompt" }
    ]) {
      const attested = await runHook(lifecycle.command, {
        hook_event_name: lifecycle.event,
        session_id: sessionId,
        turn_id: lifecycle.turnId,
        cwd: root,
        source: "startup",
        prompt: secret
      }, env);

      expect(attested.code).toBe(0);
      expect(attested.output).toEqual({});
      const storedText = await readFile(path, "utf8");
      const stored = JSON.parse(storedText) as Record<string, unknown>;
      expect(Object.keys(stored).sort()).toEqual([
        "pluginRootHash", "root", "schemaId", "schemaVersion", "sessionHash", "updatedAt"
      ].sort());
      expect(stored).toMatchObject({
        schemaId: "tokengraph-host-workspace",
        schemaVersion: 1,
        pluginRootHash: createHash("sha256").update(await realpath(hookPluginRoot)).digest("hex"),
        sessionHash: createHash("sha256").update(sessionId).digest("hex"),
        root: await realpath(root)
      });
      expect(storedText).not.toContain(sessionId);
      expect(storedText).not.toContain(lifecycle.turnId);
      expect(storedText).not.toContain(secret);

      if (lifecycle.command === "session-start") {
        await writeFile(path, `${JSON.stringify({ ...stored, updatedAt: "2000-01-01T00:00:00.000Z" }, null, 2)}\n`);
      } else {
        expect(stored.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
      }
    }

    const ended = await runHook("session-end", {
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: root,
      reason: "other"
    }, env);
    expect(ended.output).toEqual({});
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes fixed-name host and pointer entries without delaying or retrying NTFS publication", async () => {
    const root = await makeRoot("tokengraph-hook-fixed-refresh-root-");
    const dataRoot = await makeRoot("tokengraph-hook-fixed-refresh-data-");
    const sessionId = `fixed-refresh-${randomUUID()}`;
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const hostPath = await attestationPath(sessionId);
    const sessionPath = pointerPath(dataRoot, sessionId);
    const env = pluginEnvironment(dataRoot);

    expect((await attestWorkspace(root, dataRoot, sessionId, env)).output).toEqual({});
    expect((await runHook("post-tool-use", postInput({
      session_id: sessionId,
      turn_id: "fixed-refresh-1",
      tool_input: { root },
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), env)).output).toEqual({});
    const [hostBefore, pointerBefore] = await Promise.all([
      lstat(hostPath, { bigint: true }), lstat(sessionPath, { bigint: true })
    ]);

    expect((await attestWorkspace(root, dataRoot, sessionId, env)).output).toEqual({});
    expect((await runHook("post-tool-use", postInput({
      session_id: sessionId,
      turn_id: "fixed-refresh-2",
      tool_input: { root },
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), env)).output).toEqual({});
    const [hostAfter, pointerAfter] = await Promise.all([
      lstat(hostPath, { bigint: true }), lstat(sessionPath, { bigint: true })
    ]);

    for (const [before, after] of [[hostBefore, hostAfter], [pointerBefore, pointerAfter]] as const) {
      expect(after.nlink).toBe(1n);
      expect({ dev: after.dev, ino: after.ino }).not.toEqual({ dev: before.dev, ino: before.ino });
    }
  });

  it("never treats JSON TextContent as initial task authority", async () => {
    const root = await makeRoot("tokengraph-hook-root-");
    const dataRoot = await makeRoot("tokengraph-hook-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const secret = "raw-response-secret-that-must-not-persist";
    const ledgerBefore = await readFile(join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`), "utf8");
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});

    const run = await runHook("post-tool-use", postInput({
      tool_name: "mcp__any_namespace__tokengraph_prepare_context",
      tool_input: { task: "prepare", privatePrompt: secret, nested: { taskId: randomUUID(), root: "C:/wrong" } },
      tool_response: {
        content: [{ type: "text", text: JSON.stringify({ taskId: ledger.taskId, root, secret, plan: { confidence: "high" } }) }]
      },
      cwd: root,
      prompt: secret,
      transcript: secret,
      raw_payload: secret
    }), {
      ...pluginEnvironment(dataRoot)
    });

    expect(run.code).toBe(0);
    expect(run.output).toEqual({});
    expect(run.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(run.stderr).not.toContain(secret);
    const path = pointerPath(dataRoot, "session-private-value");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`), "utf8")).toBe(ledgerBefore);
  });

  it.each([
    "tokengraph_query_context",
    "tokengraph_compress",
    "tokengraph_recall",
    "tokengraph_analyze"
  ])("tracks a direct auto-start %s response and makes Stop require reporting", async (toolName) => {
    const root = await makeRoot("tokengraph-hook-direct-root-");
    const dataRoot = await makeRoot("tokengraph-hook-direct-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, ledger.taskId, taskEvent());
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const run = await runHook("post-tool-use", postInput({
      tool_name: `mcp__tokengraph__${toolName}`,
      tool_input: { mode: "overview" },
      tool_response: { structuredContent: { taskId: ledger.taskId, confidence: "high" } },
      cwd: root
    }), pluginEnvironment(dataRoot));

    expect(run.code).toBe(0);
    expect(JSON.parse(await readFile(pointerPath(dataRoot, "session-private-value"), "utf8"))).toMatchObject({
      taskId: ledger.taskId, schemaVersion: 2
    });
    const stopped = await runHook("stop", stopInput(), pluginEnvironment(dataRoot));
    expect(stopped.output).toMatchObject({ decision: "block", reason: expect.stringContaining("tokengraph_task_report") });
  });

  it("prefers an explicit absolute tool root for a direct auto-start response", async () => {
    const root = await makeRoot("tokengraph-hook-explicit-root-");
    const dataRoot = await makeRoot("tokengraph-hook-explicit-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const run = await runHook("post-tool-use", postInput({
      tool_name: "mcp__tokengraph__tokengraph_query_context",
      tool_input: { root, mode: "overview" },
      tool_response: { structuredContent: { taskId: ledger.taskId, confidence: "high" } }
    }), pluginEnvironment(dataRoot));
    expect(run.code).toBe(0);
    expect(JSON.parse(await readFile(pointerPath(dataRoot, "session-private-value"), "utf8"))).toMatchObject({ taskId: ledger.taskId, schemaVersion: 2 });
  });

  it.each([
    "tokengraph_query_context",
    "mcp__tokengraph__tokengraph_compress",
    "mcp__personal_tokengraph__tokengraph_recall",
    "server__tokengraph_analyze",
    "mcp__x__tokengraph_propose_knowledge",
    "mcp__x__tokengraph_task_report"
  ])("matches the task-aware core tool regardless of namespace: %s", async (toolName) => {
    const root = await makeRoot("tokengraph-hook-shape-root-");
    const dataRoot = await makeRoot("tokengraph-hook-shape-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const run = await attachPointer(root, dataRoot, ledger.taskId, {
      toolName,
      env: { TOKENGRAPH_HOOK_HOST: "claude" }
    });
    expect(run.code).toBe(0);
    expect(run.output).toEqual({});
    expect(await loadTaskLedger(root, ledger.taskId)).toMatchObject({ host: "unknown" });
    expect(await loadTaskLedger(root, ledger.taskId)).not.toHaveProperty("sessionId");
  });

  it("ignores unrelated tools and nested task-looking payloads", async () => {
    const dataRoot = await makeRoot("tokengraph-hook-unrelated-");
    const run = await runHook("post-tool-use", postInput({
      tool_name: "mcp__other__search",
      tool_input: { nested: { taskId: randomUUID(), root: "C:/private" } }
    }), pluginEnvironment(dataRoot));
    expect(run.output).toEqual({});
    await expect(readdir(join(dataRoot, "sessions"))).rejects.toThrow();
  });

  it("rejects malformed direct task references instead of falling back to a prior pointer", async () => {
    const root = await makeRoot("tokengraph-hook-strict-root-");
    const dataRoot = await makeRoot("tokengraph-hook-strict-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});
    const path = pointerPath(dataRoot, "session-private-value");
    const before = await readFile(path, "utf8");

    const run = await runHook("post-tool-use", postInput({
      turn_id: "turn-malformed",
      tool_input: { taskId: randomUUID(), root: "relative-root", nested: { taskId: ledger.taskId, root } }
    }), { CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: dataRoot });

    expect(run.output).toMatchObject({ systemMessage: expect.stringMatching(/root.*match|tracking.*skipped/i) });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await loadTaskLedger(root, ledger.taskId)).not.toHaveProperty("turnId");
  });

  it("keeps host association project state immutable while selecting private turn metadata", async () => {
    const root = await makeRoot("tokengraph-hook-host-root-");
    const dataRoot = await makeRoot("tokengraph-hook-host-data-");
    const explicit = await createTaskLedger(root, { host: "unknown" });
    const explicitRun = await attachPointer(root, dataRoot, explicit.taskId, {
      env: { TOKENGRAPH_HOOK_HOST: "claude" }
    });
    expect(explicitRun.output).toEqual({});
    expect(await loadTaskLedger(root, explicit.taskId)).toMatchObject({ host: "unknown" });
    expect(await loadTaskLedger(root, explicit.taskId)).not.toHaveProperty("sessionId");

    const implicit = await createTaskLedger(root, { host: "unknown" });
    const implicitSession = "implicit-claude-session";
    const claudeEnv = { CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: dataRoot };
    expect((await attestWorkspace(root, dataRoot, implicitSession, claudeEnv)).output).toEqual({});
    const implicitRun = await runHook("post-tool-use", postInput({
      session_id: implicitSession,
      turn_id: undefined,
      prompt_id: "claude-prompt-id",
      tool_use_id: "claude-tool-use-id",
      tool_name: "mcp__tokengraph__tokengraph_recall",
      tool_input: { root },
      tool_response: { structuredContent: { taskId: implicit.taskId, root } }
    }), claudeEnv);
    expect(implicitRun.output).toEqual({});
    expect(await loadTaskLedger(root, implicit.taskId)).toMatchObject({ host: "unknown" });
    expect(JSON.parse(await readFile(pointerPath(dataRoot, implicitSession), "utf8"))).toMatchObject({
      turnId: "claude-prompt-id"
    });

    const known = await createTaskLedger(root, { host: "codex" });
    const run = await attachPointer(root, dataRoot, known.taskId, { sessionId: "known-session" });
    expect(run.output).toEqual({});
    expect(await loadTaskLedger(root, known.taskId)).toMatchObject({ host: "codex" });

    const unknown = await createTaskLedger(root, { host: "unknown" });
    const unknownSession = "unknown-host-session";
    expect((await attestWorkspace(root, dataRoot, unknownSession, claudeEnv)).output).toEqual({});
    const unknownRun = await runHook("post-tool-use", postInput({
      session_id: unknownSession,
      turn_id: "unknown-host-turn",
      tool_input: { root },
      tool_response: { structuredContent: { taskId: unknown.taskId, root } }
    }), claudeEnv);
    expect(unknownRun.output).toEqual({});
    expect(await loadTaskLedger(root, unknown.taskId)).toMatchObject({ host: "unknown" });
    expect(await loadTaskLedger(root, unknown.taskId)).not.toHaveProperty("sessionId");
  });

  it("serializes concurrent pointer writes and prunes valid pointers older than 30 days", async () => {
    const root = await makeRoot("tokengraph-hook-concurrency-root-");
    const dataRoot = await makeRoot("tokengraph-hook-concurrency-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const sessionsDir = join(dataRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const oldSession = "old-session";
    const oldHash = createHash("sha256").update(oldSession).digest("hex");
    await writeFile(join(sessionsDir, `${oldHash}.json`), `${JSON.stringify({
      schemaId: "tokengraph-hook-session", schemaVersion: 2, sessionHash: oldHash,
      taskId: ledger.taskId, turnId: "old-turn", updatedAt: "2026-05-01T00:00:00.000Z"
    })}\n`);

    const runs = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      attachPointer(root, dataRoot, ledger.taskId, { turnId: `turn-${index}`, attest: false })
    ));
    expect(runs.map((run) => run.output)).toEqual(Array.from({ length: 8 }, () => ({})));
    const pointer = JSON.parse(await readFile(pointerPath(dataRoot, "session-private-value"), "utf8")) as Record<string, unknown>;
    expect(pointer).toMatchObject({ taskId: ledger.taskId, schemaVersion: 2 });
    expect(pointer.turnId).toMatch(/^turn-[0-7]$/);
    await expect(readFile(join(sessionsDir, `${oldHash}.json`), "utf8")).rejects.toThrow();
  });

  it("isolates concurrent first writes for different session hashes without lock or temporary residue", async () => {
    const root = await makeRoot("tokengraph-hook-different-session-root-");
    const dataRoot = await makeRoot("tokengraph-hook-different-session-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    const sessionIds = Array.from({ length: 8 }, (_, index) => `different-session-${index}`);
    for (const sessionId of sessionIds) {
      expect((await attestWorkspace(root, dataRoot, sessionId)).output).toEqual({});
    }
    const runs = await Promise.all(sessionIds.map((sessionId, index) =>
      attachPointer(root, dataRoot, ledger.taskId, {
        sessionId,
        turnId: `different-turn-${index}`,
        attest: false
      })
    ));
    expect(runs.map((run) => run.output)).toEqual(sessionIds.map(() => ({})));
    const names = (await readdir(join(dataRoot, "sessions"))).sort();
    expect(names).toEqual(sessionIds.map((sessionId) => `${createHash("sha256").update(sessionId).digest("hex")}.json`).sort());
    expect(names.some((name) => name.endsWith(".lock") || name.endsWith(".tmp"))).toBe(false);
  });

  it("serializes hook host attachment with concurrent server event writes without losing events", async () => {
    const root = await makeRoot("tokengraph-hook-ledger-race-root-");
    const dataRoot = await makeRoot("tokengraph-hook-ledger-race-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const events = Array.from({ length: 40 }, () => taskEvent());
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});

    await Promise.all([
      ...events.map((item) => recordTaskEvent(root, ledger.taskId, item)),
      ...Array.from({ length: 8 }, (_, index) => attachPointer(root, dataRoot, ledger.taskId, { turnId: `race-turn-${index}`, attest: false }))
    ]);

    const stored = await loadTaskLedger(root, ledger.taskId);
    expect(stored?.events.map((item) => item.fingerprint).sort()).toEqual(events.map((item) => item.fingerprint).sort());
    expect(stored).toMatchObject({ host: "unknown" });
    expect(stored).not.toHaveProperty("sessionId");
  });

  it("keeps a concurrently refreshed valid same-session pointer complete", async () => {
    const root = await makeRoot("tokengraph-hook-prune-race-root-");
    const dataRoot = await makeRoot("tokengraph-hook-prune-race-data-");
    const refreshLedger = await createTaskLedger(root, { host: "unknown" });
    const refreshSession = "refresh-session";
    const refreshHash = createHash("sha256").update(refreshSession).digest("hex");
    await mkdir(join(dataRoot, "sessions"), { recursive: true });
    await writeFile(pointerPath(dataRoot, refreshSession), `${JSON.stringify({
      schemaId: "tokengraph-hook-session", schemaVersion: 2, sessionHash: refreshHash,
      taskId: refreshLedger.taskId, turnId: "old-turn", updatedAt: "2026-05-01T00:00:00.000Z"
    })}\n`);
    expect((await attestWorkspace(root, dataRoot, refreshSession)).output).toEqual({});

    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      attachPointer(root, dataRoot, refreshLedger.taskId, {
        sessionId: refreshSession,
        turnId: `fresh-${index}`,
        attest: false
      })
    ));

    expect(JSON.parse(await readFile(pointerPath(dataRoot, refreshSession), "utf8"))).toMatchObject({
      taskId: refreshLedger.taskId,
      turnId: expect.stringMatching(/^fresh-/)
    });
  });

  it("preserves corrupt hash-named pointer evidence without ingesting its content", async () => {
    const root = await makeRoot("tokengraph-hook-corrupt-prune-root-");
    const dataRoot = await makeRoot("tokengraph-hook-corrupt-prune-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const corruptSession = "expired-corrupt-session";
    const corruptPath = pointerPath(dataRoot, corruptSession);
    await mkdir(join(dataRoot, "sessions"), { recursive: true });
    await writeFile(corruptPath, "{private-corrupt-payload\n");
    const old = new Date("2026-05-01T00:00:00.000Z");
    await utimes(corruptPath, old, old);

    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});
    await expect(readFile(corruptPath, "utf8")).resolves.toBe("{private-corrupt-payload\n");
  });

  it("blocks an open task with one exact report call and prevents a retry loop", async () => {
    const root = await makeRoot("tokengraph-hook-open-root-");
    const dataRoot = await makeRoot("tokengraph-hook-open-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});
    const ledgerPath = join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`);
    const ledgerBefore = await readFile(ledgerPath, "utf8");

    const blocked = await runHook("stop", stopInput(), { CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: dataRoot });
    expect(blocked.output).toMatchObject({ decision: "block", reason: expect.stringContaining("tokengraph_task_report") });
    expect(String(blocked.output.reason)).toContain(ledger.taskId);
    expect(String(blocked.output.reason)).toContain(
      `tokengraph_task_report(${JSON.stringify({ taskId: ledger.taskId, root, disposition: "pause" })})`
    );
    expect(String(blocked.output.reason)).toContain(
      `tokengraph_task_report(${JSON.stringify({ taskId: ledger.taskId, root, disposition: "complete" })})`
    );
    expect(String(blocked.output.reason)).toMatch(/exactly one|call once/i);
    expect(String(blocked.output.reason)).toMatch(/pause.*complete|complete.*pause/i);

    const retried = await runHook("stop", stopInput({ stop_hook_active: true }), {
      CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: dataRoot
    });
    expect(retried.output).not.toHaveProperty("decision");
    expect(retried.output).toMatchObject({ systemMessage: expect.stringMatching(/still open|report/i) });
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBefore);
  });

  it("allows paused tasks and completed tasks whose message contains the exact canonical footer", async () => {
    const root = await makeRoot("tokengraph-hook-allow-root-");
    const dataRoot = await makeRoot("tokengraph-hook-allow-data-");
    const paused = await createTaskLedger(root, { host: "unknown" });
    await attachPointer(root, dataRoot, paused.taskId);
    await setTaskDisposition(root, paused.taskId, "pause");
    expect((await runHook("stop", stopInput(), pluginEnvironment(dataRoot))).output).toEqual({});
    expect((await attachPointer(root, dataRoot, paused.taskId)).output).toEqual({});

    const completed = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, completed.taskId, taskEvent());
    const result = await setTaskDisposition(root, completed.taskId, "complete");
    const footer = formatTaskReportFooter(result.report!);
    await attachPointer(root, dataRoot, completed.taskId);
    expect((await runHook("stop", stopInput({ last_assistant_message: `Done.\n\n${footer}` }), {
      ...pluginEnvironment(dataRoot)
    })).output).toEqual({});
  });

  it("blocks once with the exact stored canonical footer when completion omitted it", async () => {
    const root = await makeRoot("tokengraph-hook-footer-root-");
    const dataRoot = await makeRoot("tokengraph-hook-footer-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, ledger.taskId, taskEvent());
    const result = await setTaskDisposition(root, ledger.taskId, "complete");
    const footer = formatTaskReportFooter(result.report!);
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});

    const blocked = await runHook("stop", stopInput(), pluginEnvironment(dataRoot));
    expect(blocked.output).toEqual({ decision: "block", reason: expect.stringContaining(footer) });
    const retried = await runHook("stop", stopInput({ stop_hook_active: true }), {
      ...pluginEnvironment(dataRoot)
    });
    expect(retried.output).not.toHaveProperty("decision");
    expect(retried.output).toMatchObject({ systemMessage: expect.stringContaining(footer) });
  });

  it("allows without a pointer, but fails open honestly for unavailable or corrupt state", async () => {
    const root = await makeRoot("tokengraph-hook-empty-root-");
    const emptyData = await makeRoot("tokengraph-hook-empty-data-");
    expect((await attestWorkspace(root, emptyData)).output).toEqual({});
    const withoutPointer = await runHook("stop", stopInput(), pluginEnvironment(emptyData));
    expect(withoutPointer.output).not.toHaveProperty("decision");
    expect(withoutPointer.output).toMatchObject({ systemMessage: expect.stringMatching(/pointer is missing/i) });

    const noData = await runHook("stop", stopInput(), { PLUGIN_ROOT: hookPluginRoot });
    expect(noData.output).toMatchObject({ systemMessage: expect.stringMatching(/safely processed|skipped/i) });

    const corruptData = await makeRoot("tokengraph-hook-corrupt-data-");
    await mkdir(join(corruptData, "sessions"), { recursive: true });
    await writeFile(pointerPath(corruptData, "session-private-value"), "{not-json\n");
    expect((await attestWorkspace(root, corruptData)).output).toEqual({});
    const corrupt = await runHook("stop", stopInput(), pluginEnvironment(corruptData));
    expect(corrupt.output).not.toHaveProperty("decision");
    expect(corrupt.output).toMatchObject({ systemMessage: expect.stringMatching(/pointer.*invalid|state.*invalid/i) });

    const missingRoot = await makeRoot("tokengraph-hook-missing-root-");
    const missingData = await makeRoot("tokengraph-hook-missing-data-");
    const missing = await createTaskLedger(missingRoot, { host: "unknown" });
    await attachPointer(missingRoot, missingData, missing.taskId);
    await rm(join(missingRoot, ".tokengraph", "tasks", `${missing.taskId}.json`), { force: true });
    const missingLedger = await runHook("stop", stopInput(), pluginEnvironment(missingData));
    expect(missingLedger.output).not.toHaveProperty("decision");
    expect(missingLedger.output).toMatchObject({ systemMessage: expect.stringMatching(/ledger.*unavailable|ledger.*missing/i) });

    const corruptRoot = await makeRoot("tokengraph-hook-corrupt-ledger-root-");
    const corruptLedgerData = await makeRoot("tokengraph-hook-corrupt-ledger-data-");
    const corruptLedger = await createTaskLedger(corruptRoot, { host: "unknown" });
    expect((await attachPointer(corruptRoot, corruptLedgerData, corruptLedger.taskId)).output).toEqual({});
    await writeFile(join(corruptRoot, ".tokengraph", "tasks", `${corruptLedger.taskId}.json`), "{broken\n");
    const corruptLedgerStop = await runHook("stop", stopInput(), {
      ...pluginEnvironment(corruptLedgerData)
    });
    expect(corruptLedgerStop.output).not.toHaveProperty("decision");
    expect(corruptLedgerStop.output).toMatchObject({ systemMessage: expect.stringMatching(/ledger.*invalid/i) });
  });

  it("does not enforce StopFailure interrupts or API failures as completion", async () => {
    const run = await runHook("stop-failure", {
      hook_event_name: "StopFailure",
      session_id: "session-private-value",
      error: "API failure detail that must not be echoed",
      is_interrupt: true
    }, pluginEnvironment(await makeRoot("tokengraph-hook-failure-")));
    expect(run).toMatchObject({ code: 0, output: { systemMessage: expect.any(String) } });
    expect(run.stdout).not.toMatch(/complete|saved/i);
    expect(run.stderr).not.toContain("API failure detail");
  });

  it("requires exact argv, event/input pairing, bounded identifiers, and rejects confirmation-like fields without mutation", async () => {
    const root = await makeRoot("tokengraph-hook-input-root-");
    const dataRoot = await makeRoot("tokengraph-hook-input-data-");
    const env = pluginEnvironment(dataRoot);
    const sessionId = "exact-input-session";
    const path = await attestationPath(sessionId);
    const invalidRuns = [
      runHook("session-start", { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: root }, env),
      runHook("session-start", { hook_event_name: "SessionStart", session_id: sessionId, cwd: root }, env, { extraArgs: ["unexpected"] }),
      runHook("unknown-event", { hook_event_name: "SessionStart", session_id: sessionId, cwd: root }, env),
      runHook("session-start", { hook_event_name: "SessionStart", session_id: " ", cwd: root }, env),
      runHook("session-start", { hook_event_name: "SessionStart", session_id: "x".repeat(1_025), cwd: root }, env),
      runHook("session-start", { hook_event_name: "SessionStart", session_id: sessionId, cwd: root, confirmNoLegacyProcesses: true }, env),
      runHook("session-start", { hook_event_name: "SessionStart", session_id: sessionId, cwd: root, confirmedNoLegacyTokenGraphProcesses: true }, env),
      runHook("session-start", {}, env, { rawInput: "{broken\n" }),
      runHook("session-start", {}, env, { rawInput: JSON.stringify({ padding: "x".repeat(1024 * 1024) }) })
    ];
    for (const run of await Promise.all(invalidRuns)) {
      expect(run.code).toBe(0);
      expect(String(run.output.systemMessage ?? "").length).toBeLessThanOrEqual(512);
      expect(run.stdout).not.toContain(root);
    }
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(dataRoot)).resolves.toEqual([]);
  });

  it("accepts only complete matching host storage pairs and rejects overlap or linked data roots before mutation", async () => {
    const root = await makeRoot("tokengraph-hook-env-root-");
    const dataRoot = await makeRoot("tokengraph-hook-env-data-");
    const sessionId = "host-pair-session";
    const validDual = {
      PLUGIN_ROOT: hookPluginRoot,
      PLUGIN_DATA: dataRoot,
      CLAUDE_PLUGIN_ROOT: hookPluginRoot,
      CLAUDE_PLUGIN_DATA: dataRoot
    };
    expect((await attestWorkspace(root, dataRoot, sessionId, validDual)).output).toEqual({});

    const invalidData = await makeRoot("tokengraph-hook-env-invalid-");
    const conflictingData = await makeRoot("tokengraph-hook-env-conflict-");
    const cases: Array<Record<string, string | undefined>> = [
      { PLUGIN_ROOT: hookPluginRoot },
      { PLUGIN_DATA: invalidData },
      { PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: invalidData },
      { PLUGIN_ROOT: ".", PLUGIN_DATA: invalidData },
      { ...pluginEnvironment(invalidData), CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: conflictingData }
    ];
    for (const [index, candidate] of cases.entries()) {
      const run = await runHook("session-start", {
        hook_event_name: "SessionStart",
        session_id: `invalid-pair-${index}`,
        cwd: root
      }, candidate);
      expect(run.output).toHaveProperty("systemMessage");
    }
    await expect(readdir(invalidData)).resolves.toEqual([]);
    await expect(readdir(conflictingData)).resolves.toEqual([]);

    const overlap = await runHook("session-start", {
      hook_event_name: "SessionStart",
      session_id: "overlap-session",
      cwd: root
    }, { PLUGIN_ROOT: hookPluginRoot, PLUGIN_DATA: root });
    expect(overlap.output).toHaveProperty("systemMessage");

    const linkedTarget = await makeRoot("tokengraph-hook-env-linked-target-");
    const linkedParent = await makeRoot("tokengraph-hook-env-linked-parent-");
    const linkedData = join(linkedParent, "data-link");
    await symlink(linkedTarget, linkedData, process.platform === "win32" ? "junction" : "dir");
    const linked = await runHook("session-start", {
      hook_event_name: "SessionStart",
      session_id: "linked-data-session",
      cwd: root
    }, { PLUGIN_ROOT: hookPluginRoot, PLUGIN_DATA: linkedData });
    expect(linked.output).toHaveProperty("systemMessage");
    await expect(readdir(linkedTarget)).resolves.toEqual([]);
  });

  it("classifies host attestations exactly and preserves unsafe refresh/removal evidence", async () => {
    const pluginRoot = hookPluginRoot;
    const workspace = await makeRoot("tokengraph-host-state-root-");
    const sessionId = `host-state-${randomUUID()}`;
    const path = await attestationPath(sessionId, pluginRoot);
    await attestHostWorkspace(pluginRoot, sessionId, workspace);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "valid", root: await realpath(workspace) });

    const valid = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...valid, schemaVersion: 2 })}\n`);
    const unsupportedBytes = await readFile(path, "utf8");
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "unsupported" });
    await expect(attestHostWorkspace(pluginRoot, sessionId, workspace)).rejects.toThrow();
    await expect(removeHostWorkspaceAttestation(pluginRoot, sessionId)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(unsupportedBytes);

    await writeFile(path, `${JSON.stringify({ ...valid, unexpected: true })}\n`);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "invalid" });
    await writeFile(path, `${JSON.stringify({ ...valid, sessionHash: "0".repeat(64) })}\n`);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "mismatched" });
    await writeFile(path, `${JSON.stringify({ ...valid, updatedAt: "2000-01-01T00:00:00.000Z" })}\n`);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "expired" });
    await expect(removeHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toBe(true);
    await attestHostWorkspace(pluginRoot, sessionId, workspace);
    const refreshed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, Buffer.alloc(64 * 1024 + 1, 0x20));
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "invalid" });

    await writeFile(path, `${JSON.stringify(refreshed)}\n`);
    const linkedCopy = join(await makeRoot("tokengraph-host-hardlink-"), "attestation.json");
    await link(path, linkedCopy);
    await expect(loadHostWorkspaceAttestation(pluginRoot, sessionId)).resolves.toEqual({ status: "unstable" });
    await expect(removeHostWorkspaceAttestation(pluginRoot, sessionId)).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe(await readFile(linkedCopy, "utf8"));
  });

  it("keeps unsafe pointer targets and linked sessions children unchanged", async () => {
    const root = await makeRoot("tokengraph-hook-pointer-unsafe-root-");
    const dataRoot = await makeRoot("tokengraph-hook-pointer-unsafe-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    await mkdir(join(dataRoot, "sessions"));
    const path = pointerPath(dataRoot, "session-private-value");
    await writeFile(path, "{foreign-pointer-evidence\n");
    const before = await readFile(path, "utf8");
    const run = await runHook("post-tool-use", postInput({
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(dataRoot));
    expect(run.output).toHaveProperty("systemMessage");
    expect(await readFile(path, "utf8")).toBe(before);

    const expectedHash = createHash("sha256").update("session-private-value").digest("hex");
    const exactBase = {
      schemaId: "tokengraph-hook-session",
      schemaVersion: 2,
      sessionHash: expectedHash,
      taskId: ledger.taskId,
      turnId: "existing-turn",
      updatedAt: new Date().toISOString()
    };
    for (const unsafeRecord of [
      { ...exactBase, schemaVersion: 1 },
      { ...exactBase, sessionHash: "0".repeat(64) },
      { ...exactBase, unexpected: true }
    ]) {
      await writeFile(path, `${JSON.stringify(unsafeRecord)}\n`);
      const unsafeBefore = await readFile(path, "utf8");
      const unsafeRun = await runHook("post-tool-use", postInput({
        tool_response: { structuredContent: { taskId: ledger.taskId, root } }
      }), pluginEnvironment(dataRoot));
      expect(unsafeRun.output).toHaveProperty("systemMessage");
      expect(await readFile(path, "utf8")).toBe(unsafeBefore);
    }
    await writeFile(path, Buffer.alloc(16 * 1024 + 1, 0x20));
    const oversizedRun = await runHook("post-tool-use", postInput({
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(dataRoot));
    expect(oversizedRun.output).toHaveProperty("systemMessage");
    expect((await readFile(path)).byteLength).toBe(16 * 1024 + 1);

    await writeFile(path, `${JSON.stringify(exactBase)}\n`);
    const pointerHardLink = join(root, "pointer-hardlink.json");
    await link(path, pointerHardLink);
    const hardLinkedRun = await runHook("post-tool-use", postInput({
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(dataRoot));
    expect(hardLinkedRun.output).toHaveProperty("systemMessage");
    await expect(readFile(pointerHardLink, "utf8")).resolves.toBe(await readFile(path, "utf8"));

    const linkedData = await makeRoot("tokengraph-hook-sessions-link-data-");
    const sessionsTarget = await makeRoot("tokengraph-hook-sessions-link-target-");
    expect((await attestWorkspace(root, linkedData, "linked-sessions")).output).toEqual({});
    await symlink(sessionsTarget, join(linkedData, "sessions"), process.platform === "win32" ? "junction" : "dir");
    const linkedRun = await runHook("post-tool-use", postInput({
      session_id: "linked-sessions",
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(linkedData));
    expect(linkedRun.output).toHaveProperty("systemMessage");
    await expect(readdir(sessionsTarget)).resolves.toEqual([]);
  });

  it("accepts an input-only task id only after an exact valid response-bound session pointer", async () => {
    const root = await makeRoot("tokengraph-hook-task-authority-root-");
    const dataRoot = await makeRoot("tokengraph-hook-task-authority-data-");
    const first = await createTaskLedger(root, { host: "codex" });
    const second = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const path = pointerPath(dataRoot, "session-private-value");

    const inputOnly = await runHook("post-tool-use", postInput({
      tool_input: { taskId: first.taskId, root }
    }), pluginEnvironment(dataRoot));
    expect(inputOnly.output).toEqual({});
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect((await attachPointer(root, dataRoot, first.taskId, { attest: false })).output).toEqual({});
    const before = await readFile(path, "utf8");
    const mismatched = await runHook("post-tool-use", postInput({
      turn_id: "turn-mismatch",
      tool_input: { taskId: second.taskId, root }
    }), pluginEnvironment(dataRoot));
    expect(mismatched.output).toEqual({});
    expect(await readFile(path, "utf8")).toBe(before);

    const matching = await runHook("post-tool-use", postInput({
      turn_id: "turn-matching",
      tool_input: { taskId: first.taskId, root },
      tool_response: { isError: false, content: [{ type: "text", text: "successful" }] }
    }), pluginEnvironment(dataRoot));
    expect(matching.output).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ taskId: first.taskId, turnId: "turn-matching" });

    const stable = await readFile(path, "utf8");
    const malformedPriority = await runHook("post-tool-use", postInput({
      turn_id: " ",
      prompt_id: "must-not-fallback",
      tool_input: { taskId: first.taskId, root }
    }), pluginEnvironment(dataRoot));
    expect(malformedPriority.output).toHaveProperty("systemMessage");
    expect(await readFile(path, "utf8")).toBe(stable);
  });

  it("accepts task authority only from a successful unambiguous structured response", async () => {
    const root = await makeRoot("tokengraph-hook-response-authority-root-");
    const dataRoot = await makeRoot("tokengraph-hook-response-authority-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    const conflicting = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const path = pointerPath(dataRoot, "session-private-value");

    const rejectedResponses = [
      { isError: true, structuredContent: { taskId: ledger.taskId, root } },
      { is_error: true, structuredContent: { taskId: ledger.taskId, root } },
      { isError: "false", structuredContent: { taskId: ledger.taskId, root } },
      { is_error: 0, structuredContent: { taskId: ledger.taskId, root } },
      { isError: false, is_error: true, structuredContent: { taskId: ledger.taskId, root } },
      { error: { message: "failed" }, structuredContent: { taskId: ledger.taskId, root } },
      {
        isError: false,
        structuredContent: { taskId: ledger.taskId, root },
        structured_content: { taskId: conflicting.taskId, root }
      }
    ];
    for (const [index, toolResponse] of rejectedResponses.entries()) {
      const run = await runHook("post-tool-use", postInput({ turn_id: `turn-rejected-${index}`, tool_response: toolResponse }), pluginEnvironment(dataRoot));
      expect(run.output, `response ${index}`).toEqual({});
      await expect(readFile(path, "utf8"), `response ${index}`).rejects.toMatchObject({ code: "ENOENT" });
    }

    const taskConflict = await runHook("post-tool-use", postInput({
      tool_input: { taskId: conflicting.taskId, root },
      tool_response: { isError: false, structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(dataRoot));
    expect(taskConflict.output).toEqual({});
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const rootConflict = await runHook("post-tool-use", postInput({
      tool_input: { root },
      tool_response: { isError: false, structuredContent: { taskId: ledger.taskId, root: dataRoot } }
    }), pluginEnvironment(dataRoot));
    expect(rootConflict.output).toHaveProperty("systemMessage");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const accepted = await runHook("post-tool-use", postInput({
      turn_id: "turn-accepted",
      tool_input: { root },
      tool_response: {
        isError: false,
        is_error: false,
        structuredContent: { taskId: ledger.taskId, root },
        structured_content: { root, taskId: ledger.taskId }
      }
    }), pluginEnvironment(dataRoot));
    expect(accepted.output).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ taskId: ledger.taskId, turnId: "turn-accepted" });

    const beforeFailure = await readFile(path, "utf8");
    const inputOnlyFailure = await runHook("post-tool-use", postInput({
      turn_id: "turn-input-failed",
      tool_input: { taskId: ledger.taskId, root },
      tool_response: { isError: true }
    }), pluginEnvironment(dataRoot));
    expect(inputOnlyFailure.output).toEqual({});
    expect(await readFile(path, "utf8")).toBe(beforeFailure);
  });

  it("does not create plugin-data state before root and ledger authority are valid", async () => {
    const root = await makeRoot("tokengraph-hook-preauthority-root-");
    const otherRoot = await makeRoot("tokengraph-hook-preauthority-other-");
    const dataRoot = await makeRoot("tokengraph-hook-preauthority-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});

    const missingLedger = await runHook("post-tool-use", postInput({
      tool_response: { structuredContent: { taskId: randomUUID(), root } }
    }), pluginEnvironment(dataRoot));
    expect(missingLedger.output).toHaveProperty("systemMessage");
    await expect(readdir(dataRoot)).resolves.toEqual([]);

    const wrongRoot = await runHook("post-tool-use", postInput({
      tool_input: { root: otherRoot },
      tool_response: { structuredContent: { taskId: ledger.taskId } }
    }), pluginEnvironment(dataRoot));
    expect(wrongRoot.output).toHaveProperty("systemMessage");
    await expect(readdir(dataRoot)).resolves.toEqual([]);

    const nestedConfirmation = await runHook("post-tool-use", postInput({
      tool_input: { root, nested: { confirmNoLegacyProcesses: true } },
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(dataRoot));
    expect(nestedConfirmation.output).toHaveProperty("systemMessage");
    await expect(readdir(dataRoot)).resolves.toEqual([]);
  });

  it("prunes only expired exact pointer and temporary identities within the bounded sorted window", async () => {
    const root = await makeRoot("tokengraph-hook-prune-v2-root-");
    const dataRoot = await makeRoot("tokengraph-hook-prune-v2-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const sessions = join(dataRoot, "sessions");
    await mkdir(sessions);
    const expiredSession = "expired-v2-session";
    const expiredHash = createHash("sha256").update(expiredSession).digest("hex");
    const expiredPath = pointerPath(dataRoot, expiredSession);
    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await writeFile(expiredPath, `${JSON.stringify({
      schemaId: "tokengraph-hook-session",
      schemaVersion: 2,
      sessionHash: expiredHash,
      taskId: ledger.taskId,
      turnId: "expired-turn",
      updatedAt: expiredAt.toISOString()
    })}\n`);
    const tempName = `.tg-pointer-${expiredHash}-${process.pid}-${randomUUID()}.tmp`;
    const tempPath = join(sessions, tempName);
    await writeFile(tempPath, "expired temporary bytes\n");
    await utimes(tempPath, expiredAt, expiredAt);
    const foreignTemp = join(sessions, ".tg-pointer-not-owned.tmp");
    await writeFile(foreignTemp, "foreign\n");

    expect((await attachPointer(root, dataRoot, ledger.taskId, { attest: false })).output).toEqual({});
    await expect(readFile(expiredPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(tempPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(foreignTemp, "utf8")).resolves.toBe("foreign\n");
    expect((await readdir(sessions)).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("removes only exact SessionEnd pointer and attestation identities", async () => {
    const root = await makeRoot("tokengraph-hook-end-root-");
    const dataRoot = await makeRoot("tokengraph-hook-end-data-");
    const sessionId = "end-session";
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attachPointer(root, dataRoot, ledger.taskId, { sessionId })).output).toEqual({});
    const hostPath = await attestationPath(sessionId);
    const sessionPath = pointerPath(dataRoot, sessionId);
    const ended = await runHook("session-end", {
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: root
    }, { CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: dataRoot });
    expect(ended.output).toEqual({});
    await expect(readFile(hostPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves pointer and attestation evidence when SessionEnd host state is unsupported", async () => {
    const root = await makeRoot("tokengraph-hook-end-unsafe-root-");
    const dataRoot = await makeRoot("tokengraph-hook-end-unsafe-data-");
    const sessionId = "unsafe-end-session";
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attachPointer(root, dataRoot, ledger.taskId, { sessionId })).output).toEqual({});
    const hostPath = await attestationPath(sessionId);
    const sessionPath = pointerPath(dataRoot, sessionId);
    const hostRecord = JSON.parse(await readFile(hostPath, "utf8")) as Record<string, unknown>;
    await writeFile(hostPath, `${JSON.stringify({ ...hostRecord, schemaVersion: 2 })}\n`);
    const hostBefore = await readFile(hostPath, "utf8");
    const pointerBefore = await readFile(sessionPath, "utf8");
    const ended = await runHook("session-end", {
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: root
    }, pluginEnvironment(dataRoot));
    expect(ended.output).toHaveProperty("systemMessage");
    expect(await readFile(hostPath, "utf8")).toBe(hostBefore);
    expect(await readFile(sessionPath, "utf8")).toBe(pointerBefore);
  });

  it("keeps canonical footer and Stop outcomes byte-equivalent across Codex and Claude adapter environments", async () => {
    const summaries: Record<string, unknown>[] = [];
    for (const host of ["codex", "claude"] as const) {
      const root = await makeRoot(`tokengraph-hook-paired-${host}-root-`);
      const dataRoot = await makeRoot(`tokengraph-hook-paired-${host}-data-`);
      const sessionId = `paired-${host}`;
      const env = host === "codex"
        ? { PLUGIN_ROOT: hookPluginRoot, PLUGIN_DATA: dataRoot, TOKENGRAPH_HOOK_HOST: host }
        : { CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: dataRoot, TOKENGRAPH_HOOK_HOST: host };
      expect((await attestWorkspace(root, dataRoot, sessionId, env)).output).toEqual({});
      const attach = async (taskId: string) => runHook("post-tool-use", postInput({
        session_id: sessionId,
        tool_input: { root },
        tool_response: { structuredContent: { taskId, root } }
      }), env);
      const stop = async (overrides: Record<string, unknown> = {}) => runHook("stop", stopInput({ session_id: sessionId, ...overrides }), env);

      const measured = await createTaskLedger(root, { host: "unknown" });
      await recordTaskEvent(root, measured.taskId, taskEvent());
      const measuredResult = await setTaskDisposition(root, measured.taskId, "complete");
      const measuredFooter = formatTaskReportFooter(measuredResult.report!);
      expect(measuredFooter).toContain("categories context=~0-60 (context:uncalibrated)");
      await attach(measured.taskId);
      const measuredStop = await stop({ last_assistant_message: `Done.\n\n${measuredFooter}` });

      const noEvents = await createTaskLedger(root, { host: "unknown" });
      const noEventsResult = await setTaskDisposition(root, noEvents.taskId, "complete");
      const noEventsFooter = formatTaskReportFooter(noEventsResult.report!);
      await attach(noEvents.taskId);
      const noEventsStop = await stop({ last_assistant_message: noEventsFooter });

      const paused = await createTaskLedger(root, { host: "unknown" });
      await setTaskDisposition(root, paused.taskId, "pause");
      await attach(paused.taskId);
      const pausedStop = await stop();

      await attach(measured.taskId);
      const missingFooter = await stop();
      const repeatedStop = await stop({ stop_hook_active: true });

      const emptyData = await makeRoot(`tokengraph-hook-paired-${host}-empty-`);
      const emptyEnv = host === "codex"
        ? { PLUGIN_ROOT: hookPluginRoot, PLUGIN_DATA: emptyData, TOKENGRAPH_HOOK_HOST: host }
        : { CLAUDE_PLUGIN_ROOT: hookPluginRoot, CLAUDE_PLUGIN_DATA: emptyData, TOKENGRAPH_HOOK_HOST: host };
      expect((await attestWorkspace(root, emptyData, `empty-${host}`, emptyEnv)).output).toEqual({});
      const noState = await runHook("stop", stopInput({ session_id: `empty-${host}` }), emptyEnv);
      await mkdir(join(emptyData, "sessions"), { recursive: true });
      await writeFile(pointerPath(emptyData, `empty-${host}`), "{corrupt\n");
      const corruptState = await runHook("stop", stopInput({ session_id: `empty-${host}` }), emptyEnv);

      summaries.push({
        measuredFooter,
        noEventsFooter,
        measuredStop: measuredStop.output,
        noEventsStop: noEventsStop.output,
        pausedStop: pausedStop.output,
        missingFooterIncludesCanonicalBytes: String(missingFooter.output.reason).includes(measuredFooter),
        repeatedStopIncludesCanonicalBytes: String(repeatedStop.output.systemMessage).includes(measuredFooter),
        noState: noState.output,
        corruptState: corruptState.output
      });
    }

    expect(summaries[0]).toEqual(summaries[1]);
    expect(summaries[0]).toMatchObject({
      measuredFooter: expect.stringMatching(/^TokenGraph: /),
      noEventsFooter: expect.stringMatching(/^TokenGraph: /),
      measuredStop: {}, noEventsStop: {}, pausedStop: {},
      missingFooterIncludesCanonicalBytes: true,
      repeatedStopIncludesCanonicalBytes: true,
      noState: { systemMessage: expect.stringMatching(/pointer is missing/i) },
      corruptState: { systemMessage: expect.stringMatching(/invalid/i) }
    });
  });
});

describe("audited lifecycle hook boundaries", () => {
  async function injector(script: string): Promise<string> {
    const directory = await makeRoot("tokengraph-hook-inject-");
    const path = join(directory, "inject.mjs");
    await writeFile(path, script);
    return `--import ${path}`;
  }

  const unlinkAtLstat = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const promises = require("node:fs/promises");
const target = process.env.TG_TEST_TARGET;
const at = Number(process.env.TG_TEST_UNLINK_AT);
const originalLstat = promises.lstat;
let seen = 0;
promises.lstat = async (path, options) => {
  if (String(path) === target) {
    seen += 1;
    if (seen === at) { try { await promises.unlink(target); } catch { /* already gone */ } }
  }
  return originalLstat(path, options);
};
`;

  const failTemporarySync = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const promises = require("node:fs/promises");
const marker = process.env.TG_TEST_FAIL_SYNC;
const originalOpen = promises.open;
promises.open = async (path, ...rest) => {
  const handle = await originalOpen(path, ...rest);
  if (!String(path).includes(marker)) return handle;
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === "sync") return async () => { throw new Error("injected-sync-failure"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
`;

  it("reports a pointer unlinked after the bounded read began as unstable, not missing", async () => {
    const root = await makeRoot("tokengraph-hook-midread-root-");
    const dataRoot = await makeRoot("tokengraph-hook-midread-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});
    const path = pointerPath(dataRoot, "session-private-value");
    await expect(readFile(path, "utf8")).resolves.toContain(ledger.taskId);

    const stopped = await runHook("stop", stopInput(), {
      ...pluginEnvironment(dataRoot),
      NODE_OPTIONS: await injector(unlinkAtLstat),
      TG_TEST_TARGET: path,
      TG_TEST_UNLINK_AT: "2"
    });
    expect(stopped.output).not.toHaveProperty("decision");
    expect(stopped.output).toMatchObject({ systemMessage: expect.stringMatching(/pointer is unstable/i) });
  });

  it("warns and allows Stop without a pointer or a sessions directory", async () => {
    const root = await makeRoot("tokengraph-hook-nopointer-root-");
    const dataRoot = await makeRoot("tokengraph-hook-nopointer-data-");
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});

    const withoutSessions = await runHook("stop", stopInput(), pluginEnvironment(dataRoot));
    expect(withoutSessions.output).not.toHaveProperty("decision");
    expect(withoutSessions.output).toMatchObject({ systemMessage: expect.stringMatching(/pointer is missing/i) });

    await mkdir(join(dataRoot, "sessions"), { recursive: true });
    const withoutPointer = await runHook("stop", stopInput(), pluginEnvironment(dataRoot));
    expect(withoutPointer.output).not.toHaveProperty("decision");
    expect(withoutPointer.output).toMatchObject({ systemMessage: expect.stringMatching(/pointer is missing/i) });
  });

  it("skips Stop and SessionEnd when an explicit lifecycle root disagrees with the attestation", async () => {
    const root = await makeRoot("tokengraph-hook-rootcheck-root-");
    const other = await makeRoot("tokengraph-hook-rootcheck-other-");
    const dataRoot = await makeRoot("tokengraph-hook-rootcheck-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    await recordTaskEvent(root, ledger.taskId, taskEvent());
    await setTaskDisposition(root, ledger.taskId, "complete");
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});
    const hostPath = await attestationPath("session-private-value");
    const sessionPath = pointerPath(dataRoot, "session-private-value");
    const [hostBefore, pointerBefore] = await Promise.all([readFile(hostPath, "utf8"), readFile(sessionPath, "utf8")]);

    const stopped = await runHook("stop", stopInput({ cwd: other }), pluginEnvironment(dataRoot));
    expect(stopped.output).not.toHaveProperty("decision");
    expect(stopped.output).toMatchObject({ systemMessage: expect.stringMatching(/root did not match/i) });
    expect(String(stopped.output.systemMessage)).not.toContain(other);

    // SessionEnd removes only binding-keyed host state and never uses the
    // project root, so a disagreeing cwd does not orphan the attestation and
    // pointer; the authority check protects decision paths, not cleanup.
    expect(hostBefore.length).toBeGreaterThan(0);
    expect(pointerBefore.length).toBeGreaterThan(0);
    const ended = await runHook("session-end", {
      hook_event_name: "SessionEnd",
      session_id: "session-private-value",
      cwd: other
    }, pluginEnvironment(dataRoot));
    expect(ended.output).toEqual({});
    await expect(readFile(hostPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("compares an explicit root supplied by an unstructured tool response", async () => {
    const root = await makeRoot("tokengraph-hook-rawroot-root-");
    const other = await makeRoot("tokengraph-hook-rawroot-other-");
    const dataRoot = await makeRoot("tokengraph-hook-rawroot-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});

    const run = await runHook("post-tool-use", postInput({
      tool_input: { root },
      tool_response: { root: other, structuredContent: { taskId: ledger.taskId, root } }
    }), pluginEnvironment(dataRoot));
    expect(run.output).toMatchObject({ systemMessage: expect.stringMatching(/root did not match/i) });
    await expect(readdir(dataRoot)).resolves.toEqual([]);
  });

  it("removes the session pointer with an expired attestation and reports SessionEnd success honestly", async () => {
    const root = await makeRoot("tokengraph-hook-expired-end-root-");
    const dataRoot = await makeRoot("tokengraph-hook-expired-end-data-");
    const sessionId = "expired-end-session";
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attachPointer(root, dataRoot, ledger.taskId, { sessionId })).output).toEqual({});
    const hostPath = await attestationPath(sessionId);
    const sessionPath = pointerPath(dataRoot, sessionId);
    const stored = JSON.parse(await readFile(hostPath, "utf8")) as Record<string, unknown>;
    await writeFile(hostPath, `${JSON.stringify({ ...stored, updatedAt: "2000-01-01T00:00:00.000Z" }, null, 2)}\n`);

    const ended = await runHook("session-end", {
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: root
    }, pluginEnvironment(dataRoot));
    expect(ended.output).toEqual({});
    await expect(readFile(hostPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an exclusively created pointer temporary when the durability flush fails", async () => {
    const root = await makeRoot("tokengraph-hook-tempfail-root-");
    const dataRoot = await makeRoot("tokengraph-hook-tempfail-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});

    const run = await runHook("post-tool-use", postInput({
      tool_input: { root },
      tool_response: { structuredContent: { taskId: ledger.taskId, root } }
    }), {
      ...pluginEnvironment(dataRoot),
      NODE_OPTIONS: await injector(failTemporarySync),
      TG_TEST_FAIL_SYNC: ".tg-pointer-"
    });
    expect(run.output).toHaveProperty("systemMessage");
    const sessions = join(dataRoot, "sessions");
    expect((await readdir(sessions)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    expect((await attachPointer(root, dataRoot, ledger.taskId, { attest: false })).output).toEqual({});
    await expect(readFile(pointerPath(dataRoot, "session-private-value"), "utf8")).resolves.toContain(ledger.taskId);
  });

  it("never prunes a future-dated pointer temporary", async () => {
    const root = await makeRoot("tokengraph-hook-future-root-");
    const dataRoot = await makeRoot("tokengraph-hook-future-data-");
    const ledger = await createTaskLedger(root, { host: "codex" });
    expect((await attestWorkspace(root, dataRoot)).output).toEqual({});
    const sessions = join(dataRoot, "sessions");
    await mkdir(sessions);
    const sessionHash = createHash("sha256").update("session-private-value").digest("hex");
    const futurePath = join(sessions, `.tg-pointer-${sessionHash}-${process.pid}-${randomUUID()}.tmp`);
    const stalePath = join(sessions, `.tg-pointer-${sessionHash}-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(futurePath, "future temporary bytes\n");
    await writeFile(stalePath, "stale temporary bytes\n");
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000);
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(futurePath, future, future);
    await utimes(stalePath, stale, stale);

    expect((await attachPointer(root, dataRoot, ledger.taskId, { attest: false })).output).toEqual({});
    await expect(readFile(futurePath, "utf8")).resolves.toBe("future temporary bytes\n");
    await expect(readFile(stalePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds the blocking decision reason for an oversized stored completion report", async () => {
    const root = await makeRoot("tokengraph-hook-bound-root-");
    const dataRoot = await makeRoot("tokengraph-hook-bound-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, ledger.taskId, taskEvent());
    await setTaskDisposition(root, ledger.taskId, "complete");
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});

    const ledgerFile = join(root, ".tokengraph", "tasks", `${ledger.taskId}.json`);
    const stored = JSON.parse(await readFile(ledgerFile, "utf8")) as Record<string, unknown>;
    const report = stored.completedReport as { categories: Array<{ basis: string[] }> };
    report.categories[0]!.basis = ["b".repeat(200_000)];
    await writeFile(ledgerFile, `${JSON.stringify(stored, null, 2)}\n`);

    // An exact-footer instruction that cannot fit the output bound would be
    // truncated into an instruction no response can ever satisfy, so an
    // oversized footer degrades to a bounded warning that allows Stop.
    const blocked = await runHook("stop", stopInput(), pluginEnvironment(dataRoot));
    expect(blocked.output).not.toHaveProperty("decision");
    expect(blocked.output).toMatchObject({ systemMessage: expect.stringMatching(/footer/i) });
    expect(blocked.stdout.length).toBeLessThanOrEqual(8192);
  });
});

describe("hook manifest contract", () => {
  it("keeps the manifest bytes and unactivated hook capability boundary exact", async () => {
    const manifestBytes = await readFile(resolve("hooks", "hooks.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex"))
      .toBe("21997194c231aecea3505680f6d5db61accea9d8cfc949e63d66f310c28feb07");

    for (const path of [resolve("src", "hooks.ts"), hookEntry]) {
      const source = await readFile(path, "utf8");
      expect(source).toContain("inspectTaskLedgerReadOnly");
      for (const forbidden of [
        "activateLegacyRuntimeShutdown", "nativeLockProvider", "loadNativeLockAddon",
        "withFileLock", "canonicalPersistenceLock", "attachTaskHostContext", "loadTaskLedger"
      ]) expect(source).not.toContain(forbidden);
    }
  });

  it("wires workspace attestation and task lifecycle through the self-contained Node adapter only", async () => {
    const manifest = JSON.parse(await readFile(resolve("hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(Object.keys(manifest.hooks).sort()).toEqual([
      "PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"
    ].sort());
    expect(manifest.hooks.SessionStart[0]?.hooks).toEqual([
      { type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks.js\" session-start" }
    ]);
    expect(manifest.hooks.UserPromptSubmit[0]?.hooks).toEqual([
      { type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks.js\" user-prompt-submit" }
    ]);
    expect(manifest.hooks.SessionEnd[0]?.hooks).toEqual([
      { type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks.js\" session-end" }
    ]);
    expect(manifest.hooks.PostToolUse[0]?.matcher).toMatch(/tokengraph_prepare_context/);
    expect(manifest.hooks.PostToolUse[0]?.matcher).toMatch(/tokengraph_task_report/);
    expect(manifest.hooks.PostToolUse[0]?.hooks).toEqual([
      { type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks.js\" post-tool-use" }
    ]);
    expect(manifest.hooks.Stop[0]?.hooks).toEqual([
      { type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks.js\" stop" }
    ]);
    expect(manifest.hooks).not.toHaveProperty("StopFailure");
  });
});
