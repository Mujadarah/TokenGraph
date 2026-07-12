#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultServerEntry = resolve(pluginRoot, "dist", "index.js");
const requiredTools = [
  "tokengraph_setup",
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
];

function usage() {
  return [
    "Usage: node scripts/smoke.mjs [--root <project-root>] [--server <dist/index.js>] [--surface <core|full>] [--json] [--timeout <ms>]",
    "",
    "Validates the built TokenGraph stdio MCP server outside Codex by listing tools",
    "and calling read-only project context tools against a local project root."
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    server: defaultServerEntry,
    surface: "core",
    json: false,
    timeoutMs: 10000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--root") {
      args.root = readOptionValue(argv, ++index, "--root");
    } else if (arg === "--server") {
      args.server = readOptionValue(argv, ++index, "--server");
    } else if (arg === "--surface") {
      args.surface = readOptionValue(argv, ++index, "--surface");
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--timeout") {
      args.timeoutMs = Number(readOptionValue(argv, ++index, "--timeout"));
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error("--timeout must be an integer greater than or equal to 1000.");
  }
  if (args.surface !== "core" && args.surface !== "full") {
    throw new Error("--surface must be either core or full.");
  }
  return args;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.\n${usage()}`);
  }
  return value;
}

function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

class JsonRpcClient {
  constructor(child, timeoutMs) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.stderr = "";

    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`MCP server exited before smoke finished (code ${code ?? "null"}, signal ${signal ?? "null"}).`);
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for ${method}. Server stderr: ${this.stderr.trim()}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise.then((message) => {
      if (message.error) {
        throw new Error(`${method} failed: ${message.error.message}`);
      }
      return message.result;
    });
  }

  async close() {
    if (this.child.exitCode !== null) return;
    await new Promise((resolveClose) => {
      const timeout = setTimeout(resolveClose, 1000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolveClose();
      });
      this.child.kill();
    });
  }
}

async function assertReadableFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing at ${path}. Run pnpm build first.`);
  }
}

function assertToolResult(result, toolName) {
  if (result?.isError) {
    throw new Error(`${toolName} returned an MCP tool error: ${compactJson(result)}`);
  }
  return result?.structuredContent ?? {};
}

async function runSmoke() {
  const args = parseArgs(process.argv.slice(2));
  const root = await realpath(resolve(args.root));
  const serverEntry = resolve(args.server);
  await assertReadableFile(serverEntry, "built MCP server entry");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...process.env, TOKENGRAPH_WORKSPACE_ROOT: root, TOKENGRAPH_TOOL_SURFACE: args.surface },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const client = new JsonRpcClient(child, args.timeoutMs);

  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-cli-smoke", version: "0.19.0" }
    });
    client.notify("notifications/initialized");

    const listed = await client.request("tools/list");
    const tools = ((listed?.tools ?? []).map((tool) => tool.name)).sort();
    const missingTools = requiredTools.filter((tool) => !tools.includes(tool));
    if (missingTools.length) {
      throw new Error(`Missing required tools: ${missingTools.join(", ")}`);
    }
    const expectedToolCount = args.surface === "core" ? 8 : 42;
    if (tools.length !== expectedToolCount || new Set(tools).size !== expectedToolCount) {
      throw new Error(`Expected ${expectedToolCount} unique ${args.surface} tools, received ${tools.length}.`);
    }

    const setup = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_setup", arguments: {} }),
      "tokengraph_setup"
    );
    const prepared = assertToolResult(
      await client.request("tools/call", {
        name: "tokengraph_prepare_context",
        arguments: { root, task: "TokenGraph CLI smoke validation", profile: "aggressive", budgets: { maxFiles: 3, maxSqlObjects: 3, maxMemories: 0 } }
      }),
      "tokengraph_prepare_context"
    );
    const overview = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_query_context", arguments: { root, taskId: prepared.taskId, mode: "overview" } }),
      "tokengraph_query_context"
    );
    const compressed = assertToolResult(
      await client.request("tools/call", {
        name: "tokengraph_compress",
        arguments: {
          root, taskId: prepared.taskId, mode: "output", kind: "test",
          text: "FAIL scripts/smoke.mjs > smoke validation > keeps required tools\nAssertionError: expected tool to be listed"
        }
      }),
      "tokengraph_compress"
    );
    const memoryReview = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_recall", arguments: { root, taskId: prepared.taskId, mode: "review", query: "smoke validation", limit: 5 } }),
      "tokengraph_recall"
    );
    const analysis = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_analyze", arguments: { root, taskId: prepared.taskId, mode: "architecture" } }),
      "tokengraph_analyze"
    );
    const knowledge = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_propose_knowledge", arguments: { root, taskId: prepared.taskId, action: "list" } }),
      "tokengraph_propose_knowledge"
    );
    const completed = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_task_report", arguments: { root, taskId: prepared.taskId, disposition: "complete" } }),
      "tokengraph_task_report"
    );

    return {
      status: "ok",
      root,
      serverEntry,
      toolSurface: setup.surface,
      tools,
      taskId: prepared.taskId,
      indexStateBeforeMap: prepared.index?.previousStatus ?? "unknown",
      filesIndexed: overview.result?.counts?.files ?? 0,
      symbolsIndexed: overview.result?.counts?.symbols ?? 0,
      recommendedFirstReads: prepared.plan?.recommendedFirstReads ?? [],
      activeProfile: prepared.plan?.profile ?? "unknown",
      estimatedTokensAvoided: Math.max(0, (compressed.estimates?.original ?? 0) - (compressed.estimates?.compact ?? 0) - (compressed.estimates?.overhead ?? 0)),
      memoriesReviewed: memoryReview.result?.totalMemories ?? 0,
      architectureStatus: analysis.result?.status ?? "unknown",
      knowledgeSuggestions: knowledge.suggestions?.length ?? 0,
      taskEventCount: completed.report?.eventCount ?? 0,
      wikiPageSlugs: [],
      wikiStatus: prepared.wikiStatus?.state ?? "missing"
    };
  } finally {
    await client.close();
  }
}

runSmoke()
  .then((report) => {
    const args = parseArgs(process.argv.slice(2));
    if (args.json) {
      console.log(JSON.stringify(report));
      return;
    }
    console.log(`TokenGraph smoke passed for ${report.root}`);
    console.log(`Tools: ${report.tools.length}; files indexed: ${report.filesIndexed}; estimated tokens avoided: ${report.estimatedTokensAvoided}`);
  })
  .catch((error) => {
    console.error(`TokenGraph smoke failed: ${error.message}`);
    process.exit(1);
  });
