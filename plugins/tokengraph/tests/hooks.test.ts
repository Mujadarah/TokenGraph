import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { formatTaskReportFooter } from "../src/core/taskEstimator.js";
import {
  createTaskLedger,
  loadTaskLedger,
  recordTaskEvent,
  setTaskDisposition,
  type TaskEvent
} from "../src/core/taskLedger.js";

const hookEntry = resolve(process.env.TOKENGRAPH_HOOK_ENTRY ?? resolve("dist", "hooks.js"));
const hookPluginRoot = resolve(dirname(hookEntry), "..");
const roots: string[] = [];

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
  event: "post-tool-use" | "stop" | "stop-failure",
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = {}
): Promise<HookRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PLUGIN_ROOT: undefined,
      PLUGIN_DATA: undefined,
      CLAUDE_PLUGIN_ROOT: undefined,
      CLAUDE_PLUGIN_DATA: undefined,
      TOKENGRAPH_HOOK_HOST: undefined,
      ...env
    };
    for (const key of Object.keys(childEnv)) {
      if (childEnv[key] === undefined) delete childEnv[key];
    }
    const child = spawn(process.execPath, [hookEntry, event], {
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
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
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
  options: { sessionId?: string; turnId?: string; toolName?: string; env?: Record<string, string | undefined> } = {}
): Promise<HookRun> {
  const sessionId = options.sessionId ?? "session-private-value";
  return runHook("post-tool-use", postInput({
    session_id: sessionId,
    turn_id: options.turnId ?? "turn-1",
    tool_name: options.toolName ?? "mcp__tokengraph__tokengraph_query_context",
    tool_input: { taskId, root }
  }), {
    CLAUDE_PLUGIN_ROOT: process.cwd(),
    CLAUDE_PLUGIN_DATA: dataRoot,
    ...options.env
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("built lifecycle hook process", () => {
  it("extracts prepare context only from structured response fields and writes a private minimal pointer", async () => {
    const root = await makeRoot("tokengraph-hook-root-");
    const dataRoot = await makeRoot("tokengraph-hook-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const secret = "raw-response-secret-that-must-not-persist";

    const run = await runHook("post-tool-use", postInput({
      tool_name: "mcp__any_namespace__tokengraph_prepare_context",
      tool_input: { task: "prepare", nested: { taskId: randomUUID(), root: "C:/wrong" } },
      tool_response: {
        structuredContent: { taskId: ledger.taskId, root },
        content: [{ type: "text", text: JSON.stringify({ taskId: randomUUID(), root: secret }) }]
      },
      raw_payload: secret
    }), {
      PLUGIN_ROOT: process.cwd(),
      PLUGIN_DATA: dataRoot
    });

    expect(run.code).toBe(0);
    expect(run.output).toEqual({});
    expect(run.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(run.stderr).not.toContain(secret);
    const path = pointerPath(dataRoot, "session-private-value");
    const pointerText = await readFile(path, "utf8");
    const pointer = JSON.parse(pointerText) as Record<string, unknown>;
    expect(Object.keys(pointer).sort()).toEqual([
      "root", "schemaId", "schemaVersion", "sessionHash", "taskId", "turnId", "updatedAt"
    ].sort());
    expect(pointer).toMatchObject({
      schemaId: "tokengraph-hook-session",
      schemaVersion: 1,
      sessionHash: createHash("sha256").update("session-private-value").digest("hex"),
      taskId: ledger.taskId,
      root,
      turnId: "turn-1"
    });
    expect(pointerText).not.toContain("session-private-value");
    expect(pointerText).not.toContain(secret);
    expect(await loadTaskLedger(root, ledger.taskId)).toMatchObject({
      host: "codex", sessionId: "session-private-value", turnId: "turn-1"
    });
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
    expect(await loadTaskLedger(root, ledger.taskId)).toMatchObject({ host: "claude" });
  });

  it("ignores unrelated tools and nested task-looking payloads", async () => {
    const dataRoot = await makeRoot("tokengraph-hook-unrelated-");
    const run = await runHook("post-tool-use", postInput({
      tool_name: "mcp__other__search",
      tool_input: { nested: { taskId: randomUUID(), root: "C:/private" } }
    }), { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: dataRoot });
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
    }), { CLAUDE_PLUGIN_ROOT: process.cwd(), CLAUDE_PLUGIN_DATA: dataRoot });

    expect(run.output).toEqual({});
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await loadTaskLedger(root, ledger.taskId)).toMatchObject({ turnId: "turn-1" });
  });

  it("uses explicit host detection first and preserves a known host when detection is unresolved", async () => {
    const root = await makeRoot("tokengraph-hook-host-root-");
    const dataRoot = await makeRoot("tokengraph-hook-host-data-");
    const explicit = await createTaskLedger(root, { host: "unknown" });
    const explicitRun = await attachPointer(root, dataRoot, explicit.taskId, {
      env: { TOKENGRAPH_HOOK_HOST: "claude", PLUGIN_ROOT: process.cwd() }
    });
    expect(explicitRun.output).toEqual({});
    expect(await loadTaskLedger(root, explicit.taskId)).toMatchObject({ host: "claude" });

    const implicit = await createTaskLedger(root, { host: "unknown" });
    const implicitSession = "implicit-claude-session";
    const implicitRun = await runHook("post-tool-use", postInput({
      session_id: implicitSession,
      turn_id: undefined,
      prompt_id: "claude-prompt-id",
      tool_use_id: "claude-tool-use-id",
      tool_name: "mcp__tokengraph__tokengraph_recall",
      tool_input: { taskId: implicit.taskId, root }
    }), { CLAUDE_PLUGIN_ROOT: process.cwd(), CLAUDE_PLUGIN_DATA: dataRoot });
    expect(implicitRun.output).toEqual({});
    expect(await loadTaskLedger(root, implicit.taskId)).toMatchObject({
      host: "claude", sessionId: implicitSession, turnId: "claude-prompt-id"
    });
    expect(JSON.parse(await readFile(pointerPath(dataRoot, implicitSession), "utf8"))).toMatchObject({
      turnId: "claude-prompt-id"
    });

    const known = await createTaskLedger(root, { host: "codex" });
    const run = await attachPointer(root, dataRoot, known.taskId, { sessionId: "known-session", env: {
      PLUGIN_ROOT: undefined,
      CLAUDE_PLUGIN_ROOT: undefined,
      TOKENGRAPH_HOOK_HOST: undefined
    } });
    expect(run.output).toEqual({});
    expect(await loadTaskLedger(root, known.taskId)).toMatchObject({ host: "codex" });

    const unknown = await createTaskLedger(root, { host: "unknown" });
    const unknownRun = await runHook("post-tool-use", postInput({
      session_id: "unknown-host-session",
      turn_id: "unknown-host-turn",
      tool_input: { taskId: unknown.taskId, root }
    }), { CLAUDE_PLUGIN_DATA: dataRoot });
    expect(unknownRun.output).toEqual({});
    expect(await loadTaskLedger(root, unknown.taskId)).toMatchObject({
      host: "unknown", sessionId: "unknown-host-session", turnId: "unknown-host-turn"
    });
  });

  it("serializes concurrent pointer writes and prunes valid pointers older than 30 days", async () => {
    const root = await makeRoot("tokengraph-hook-concurrency-root-");
    const dataRoot = await makeRoot("tokengraph-hook-concurrency-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const sessionsDir = join(dataRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const oldSession = "old-session";
    const oldHash = createHash("sha256").update(oldSession).digest("hex");
    await writeFile(join(sessionsDir, `${oldHash}.json`), `${JSON.stringify({
      schemaId: "tokengraph-hook-session", schemaVersion: 1, sessionHash: oldHash,
      taskId: ledger.taskId, root, turnId: "old-turn", updatedAt: "2026-05-01T00:00:00.000Z"
    })}\n`);

    const runs = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      attachPointer(root, dataRoot, ledger.taskId, { turnId: `turn-${index}` })
    ));
    expect(runs.map((run) => run.output)).toEqual(Array.from({ length: 8 }, () => ({})));
    const pointer = JSON.parse(await readFile(pointerPath(dataRoot, "session-private-value"), "utf8")) as Record<string, unknown>;
    expect(pointer).toMatchObject({ taskId: ledger.taskId, root });
    expect(pointer.turnId).toMatch(/^turn-[0-7]$/);
    await expect(readFile(join(sessionsDir, `${oldHash}.json`), "utf8")).rejects.toThrow();
  });

  it("serializes hook host attachment with concurrent server event writes without losing events", async () => {
    const root = await makeRoot("tokengraph-hook-ledger-race-root-");
    const dataRoot = await makeRoot("tokengraph-hook-ledger-race-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    const events = Array.from({ length: 40 }, () => taskEvent());

    await Promise.all([
      ...events.map((item) => recordTaskEvent(root, ledger.taskId, item)),
      ...Array.from({ length: 8 }, (_, index) => attachPointer(root, dataRoot, ledger.taskId, { turnId: `race-turn-${index}` }))
    ]);

    const stored = await loadTaskLedger(root, ledger.taskId);
    expect(stored?.events.map((item) => item.fingerprint).sort()).toEqual(events.map((item) => item.fingerprint).sort());
    expect(stored).toMatchObject({ host: "claude", sessionId: "session-private-value" });
  });

  it("locks and rechecks retention so pruning cannot delete a concurrently refreshed pointer", async () => {
    const root = await makeRoot("tokengraph-hook-prune-race-root-");
    const dataRoot = await makeRoot("tokengraph-hook-prune-race-data-");
    const refreshLedger = await createTaskLedger(root, { host: "unknown" });
    const triggerLedger = await createTaskLedger(root, { host: "unknown" });
    const refreshSession = "refresh-session";
    const refreshHash = createHash("sha256").update(refreshSession).digest("hex");
    await mkdir(join(dataRoot, "sessions"), { recursive: true });
    await writeFile(pointerPath(dataRoot, refreshSession), `${JSON.stringify({
      schemaId: "tokengraph-hook-session", schemaVersion: 1, sessionHash: refreshHash,
      taskId: refreshLedger.taskId, root, turnId: "old-turn", updatedAt: "2026-05-01T00:00:00.000Z"
    })}\n`);

    await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.all([
      attachPointer(root, dataRoot, refreshLedger.taskId, { sessionId: refreshSession, turnId: `fresh-${index}` }),
      attachPointer(root, dataRoot, triggerLedger.taskId, { sessionId: `trigger-${index}`, turnId: `trigger-${index}` })
    ])));

    expect(JSON.parse(await readFile(pointerPath(dataRoot, refreshSession), "utf8"))).toMatchObject({
      taskId: refreshLedger.taskId,
      turnId: expect.stringMatching(/^fresh-/)
    });
  });

  it("prunes corrupt hash-named pointers by safe file age without ingesting their content", async () => {
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
    await expect(readFile(corruptPath, "utf8")).rejects.toThrow();
  });

  it("blocks an open task with one exact report call and prevents a retry loop", async () => {
    const root = await makeRoot("tokengraph-hook-open-root-");
    const dataRoot = await makeRoot("tokengraph-hook-open-data-");
    const ledger = await createTaskLedger(root, { host: "unknown" });
    expect((await attachPointer(root, dataRoot, ledger.taskId)).output).toEqual({});

    const blocked = await runHook("stop", stopInput(), { CLAUDE_PLUGIN_ROOT: process.cwd(), CLAUDE_PLUGIN_DATA: dataRoot });
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
      CLAUDE_PLUGIN_ROOT: process.cwd(), CLAUDE_PLUGIN_DATA: dataRoot
    });
    expect(retried.output).not.toHaveProperty("decision");
    expect(retried.output).toMatchObject({ systemMessage: expect.stringMatching(/still open|report/i) });
  });

  it("allows paused tasks and completed tasks whose message contains the exact canonical footer", async () => {
    const root = await makeRoot("tokengraph-hook-allow-root-");
    const dataRoot = await makeRoot("tokengraph-hook-allow-data-");
    const paused = await createTaskLedger(root, { host: "unknown" });
    await setTaskDisposition(root, paused.taskId, "pause");
    await attachPointer(root, dataRoot, paused.taskId);
    expect((await runHook("stop", stopInput(), { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: dataRoot })).output).toEqual({});

    const completed = await createTaskLedger(root, { host: "unknown" });
    await recordTaskEvent(root, completed.taskId, taskEvent());
    const result = await setTaskDisposition(root, completed.taskId, "complete");
    const footer = formatTaskReportFooter(result.report!);
    await attachPointer(root, dataRoot, completed.taskId);
    expect((await runHook("stop", stopInput({ last_assistant_message: `Done.\n\n${footer}` }), {
      PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: dataRoot
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

    const blocked = await runHook("stop", stopInput(), { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: dataRoot });
    expect(blocked.output).toEqual({ decision: "block", reason: expect.stringContaining(footer) });
    const retried = await runHook("stop", stopInput({ stop_hook_active: true }), {
      PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: dataRoot
    });
    expect(retried.output).not.toHaveProperty("decision");
    expect(retried.output).toMatchObject({ systemMessage: expect.stringContaining(footer) });
  });

  it("allows silently without a pointer, but fails open honestly for unavailable or corrupt state", async () => {
    const emptyData = await makeRoot("tokengraph-hook-empty-data-");
    expect((await runHook("stop", stopInput(), { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: emptyData })).output).toEqual({});

    const noData = await runHook("stop", stopInput(), { PLUGIN_ROOT: process.cwd() });
    expect(noData.output).toMatchObject({ systemMessage: expect.stringMatching(/plugin data.*unavailable/i) });

    const corruptData = await makeRoot("tokengraph-hook-corrupt-data-");
    await mkdir(join(corruptData, "sessions"), { recursive: true });
    await writeFile(pointerPath(corruptData, "session-private-value"), "{not-json\n");
    const corrupt = await runHook("stop", stopInput(), { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: corruptData });
    expect(corrupt.output).not.toHaveProperty("decision");
    expect(corrupt.output).toMatchObject({ systemMessage: expect.stringMatching(/pointer.*corrupt|state.*corrupt/i) });

    const missingRoot = await makeRoot("tokengraph-hook-missing-root-");
    const missingData = await makeRoot("tokengraph-hook-missing-data-");
    const missing = await createTaskLedger(missingRoot, { host: "unknown" });
    await attachPointer(missingRoot, missingData, missing.taskId);
    await rm(join(missingRoot, ".tokengraph", "tasks", `${missing.taskId}.json`), { force: true });
    const missingLedger = await runHook("stop", stopInput(), { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: missingData });
    expect(missingLedger.output).not.toHaveProperty("decision");
    expect(missingLedger.output).toMatchObject({ systemMessage: expect.stringMatching(/ledger.*unavailable|ledger.*missing/i) });

    const corruptRoot = await makeRoot("tokengraph-hook-corrupt-ledger-root-");
    const corruptLedgerData = await makeRoot("tokengraph-hook-corrupt-ledger-data-");
    const corruptLedger = await createTaskLedger(corruptRoot, { host: "unknown" });
    expect((await attachPointer(corruptRoot, corruptLedgerData, corruptLedger.taskId)).output).toEqual({});
    await writeFile(join(corruptRoot, ".tokengraph", "tasks", `${corruptLedger.taskId}.json`), "{broken\n");
    const corruptLedgerStop = await runHook("stop", stopInput(), {
      PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: corruptLedgerData
    });
    expect(corruptLedgerStop.output).not.toHaveProperty("decision");
    expect(corruptLedgerStop.output).toMatchObject({ systemMessage: expect.stringMatching(/ledger.*unavailable|ledger.*missing/i) });
  });

  it("does not enforce StopFailure interrupts or API failures as completion", async () => {
    const run = await runHook("stop-failure", {
      hook_event_name: "StopFailure",
      session_id: "session-private-value",
      error: "API failure detail that must not be echoed",
      is_interrupt: true
    }, { PLUGIN_ROOT: process.cwd(), PLUGIN_DATA: await makeRoot("tokengraph-hook-failure-") });
    expect(run).toMatchObject({ code: 0, output: {} });
    expect(run.stdout).not.toMatch(/complete|saved/i);
    expect(run.stderr).not.toContain("API failure detail");
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
      const attach = async (taskId: string) => runHook("post-tool-use", postInput({
        session_id: sessionId,
        tool_input: { taskId, root }
      }), env);
      const stop = async (overrides: Record<string, unknown> = {}) => runHook("stop", stopInput({ session_id: sessionId, ...overrides }), env);

      const measured = await createTaskLedger(root, { host: "unknown" });
      await recordTaskEvent(root, measured.taskId, taskEvent());
      const measuredResult = await setTaskDisposition(root, measured.taskId, "complete");
      const measuredFooter = formatTaskReportFooter(measuredResult.report!);
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
      noState: {},
      corruptState: { systemMessage: expect.stringMatching(/corrupt/i) }
    });
  });
});

describe("hook manifest contract", () => {
  it("wires task-aware PostToolUse and Stop through the self-contained Node adapter only", async () => {
    const manifest = JSON.parse(await readFile(resolve("hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(Object.keys(manifest.hooks).sort()).toEqual(["PostToolUse", "Stop"]);
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
