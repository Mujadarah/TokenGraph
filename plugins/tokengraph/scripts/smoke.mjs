#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultServerEntry = resolve(pluginRoot, "dist", "index.js");
const coreToolNames = [
  "tokengraph_analyze", "tokengraph_compress", "tokengraph_prepare_context", "tokengraph_propose_knowledge",
  "tokengraph_query_context", "tokengraph_recall", "tokengraph_setup", "tokengraph_task_report"
];
const legacyToolNames = [
  "tokengraph_add_rule", "tokengraph_assess_change_risk", "tokengraph_check_architecture", "tokengraph_compress_context",
  "tokengraph_compress_output", "tokengraph_confirm_memory", "tokengraph_delete_memory", "tokengraph_delete_rule",
  "tokengraph_deprecate_memory", "tokengraph_explain_symbol", "tokengraph_export_project_map", "tokengraph_find_memory_conflicts",
  "tokengraph_generate_wiki", "tokengraph_get_config", "tokengraph_index_project", "tokengraph_index_status",
  "tokengraph_link_memory", "tokengraph_list_rules", "tokengraph_plan_context", "tokengraph_project_map",
  "tokengraph_recall_memory", "tokengraph_remember_decision", "tokengraph_reset_project", "tokengraph_review_memories",
  "tokengraph_search_graph", "tokengraph_set_profile", "tokengraph_setup_status", "tokengraph_show_token_savings",
  "tokengraph_show_wiki_page", "tokengraph_summarize_sql", "tokengraph_trace_failure", "tokengraph_update_config",
  "tokengraph_update_memory", "tokengraph_update_rule"
];

function usage() {
  return [
    "Usage: node scripts/smoke.mjs [--root <project-root>] [--server <dist/index.js>] [--surface <core|full>] [--json] [--timeout <ms>]",
    "",
    "Validates the built TokenGraph stdio MCP server outside Codex by listing tools and running a task workflow.",
    "prepare_context and task_report may write .tokengraph index, wiki, and task-ledger state under the project root."
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
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  return text ? JSON.parse(text) : {};
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
    const expectedTools = (args.surface === "core" ? coreToolNames : [...coreToolNames, ...legacyToolNames]).sort();
    const missingTools = expectedTools.filter((tool) => !tools.includes(tool));
    const unexpectedTools = tools.filter((tool) => !expectedTools.includes(tool));
    if (tools.length !== expectedTools.length || new Set(tools).size !== expectedTools.length || missingTools.length || unexpectedTools.length) {
      throw new Error(
        `Tool surface mismatch for ${args.surface}: missing [${missingTools.join(", ")}], unexpected [${unexpectedTools.join(", ")}].`
      );
    }

    const setup = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_setup", arguments: {} }),
      "tokengraph_setup"
    );
    const prepared = assertToolResult(
      await client.request("tools/call", {
        name: "tokengraph_prepare_context",
        arguments: { root, task: "TokenGraph CLI smoke validation", profile: "aggressive", maxTokens: 4000, responseMode: "verbose" }
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
      filesIndexed: overview.counts?.files ?? overview.result?.counts?.files ?? 0,
      symbolsIndexed: overview.counts?.symbols ?? overview.result?.counts?.symbols ?? 0,
      recommendedFirstReads: prepared.plan?.firstReads ?? prepared.plan?.recommendedFirstReads ?? [],
      activeProfile: prepared.plan?.profile ?? "unknown",
      estimatedTokensAvoided: Math.max(0, (compressed.estimates?.original ?? 0) - (compressed.estimates?.compact ?? 0) - (compressed.estimates?.overhead ?? 0)),
      memoriesReviewed: memoryReview.totalMemories ?? memoryReview.result?.totalMemories ?? 0,
      architectureStatus: analysis.status ?? analysis.result?.status ?? "unknown",
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
