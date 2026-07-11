#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultServerEntry = resolve(pluginRoot, "dist", "index.js");
const requiredTools = [
  "tokengraph_index_status",
  "tokengraph_get_config",
  "tokengraph_set_profile",
  "tokengraph_update_config",
  "tokengraph_project_map",
  "tokengraph_plan_context",
  "tokengraph_compress_output",
  "tokengraph_compress_context",
  "tokengraph_review_memories",
  "tokengraph_update_memory",
  "tokengraph_delete_memory",
  "tokengraph_deprecate_memory",
  "tokengraph_confirm_memory",
  "tokengraph_find_memory_conflicts",
  "tokengraph_link_memory",
  "tokengraph_recall_memory",
  "tokengraph_export_project_map",
  "tokengraph_generate_wiki",
  "tokengraph_show_wiki_page",
  "tokengraph_list_rules",
  "tokengraph_add_rule",
  "tokengraph_update_rule",
  "tokengraph_delete_rule",
  "tokengraph_check_architecture",
  "tokengraph_trace_failure",
  "tokengraph_assess_change_risk"
];

function usage() {
  return [
    "Usage: node scripts/smoke.mjs [--root <project-root>] [--server <dist/index.js>] [--json] [--timeout <ms>]",
    "",
    "Validates the built TokenGraph stdio MCP server outside Codex by listing tools",
    "and calling read-only project context tools against a local project root."
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    server: defaultServerEntry,
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
    env: { ...process.env, TOKENGRAPH_WORKSPACE_ROOT: root },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const client = new JsonRpcClient(child, args.timeoutMs);

  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-cli-smoke", version: "0.18.0" }
    });
    client.notify("notifications/initialized");

    const listed = await client.request("tools/list");
    const tools = ((listed?.tools ?? []).map((tool) => tool.name)).sort();
    const missingTools = requiredTools.filter((tool) => !tools.includes(tool));
    if (missingTools.length) {
      throw new Error(`Missing required tools: ${missingTools.join(", ")}`);
    }

    const status = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_index_status", arguments: { root } }),
      "tokengraph_index_status"
    );
    const map = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_project_map", arguments: { root } }),
      "tokengraph_project_map"
    );
    const plan = assertToolResult(
      await client.request("tools/call", {
        name: "tokengraph_plan_context",
        arguments: { root, task: "TokenGraph CLI smoke validation", profile: "aggressive", maxFiles: 3, maxSqlObjects: 3, maxMemories: 0 }
      }),
      "tokengraph_plan_context"
    );
    const config = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_get_config", arguments: { root } }),
      "tokengraph_get_config"
    );
    const savings = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_show_token_savings", arguments: { root } }),
      "tokengraph_show_token_savings"
    );
    const memoryReview = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_review_memories", arguments: { root, query: "smoke validation", limit: 5 } }),
      "tokengraph_review_memories"
    );
    const projectMapExport = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_export_project_map", arguments: { root, format: "mermaid", limit: 25 } }),
      "tokengraph_export_project_map"
    );
    const compressedContext = assertToolResult(
      await client.request("tools/call", {
        name: "tokengraph_compress_context",
        arguments: {
          root,
          task: "TokenGraph CLI smoke validation must preserve public API smokeValidation",
          contentKind: "mixed",
          preserveRawReferences: true,
          text: [
            "User constraint: Do not remove public API smokeValidation.",
            "FAIL scripts/smoke.mjs > smoke validation > keeps required tools",
            "AssertionError: expected tool to be listed",
            "Security warning: local-only MCP context must not require telemetry."
          ].join("\n")
        }
      }),
      "tokengraph_compress_context"
    );
    const generatedWiki = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_generate_wiki", arguments: { root } }),
      "tokengraph_generate_wiki"
    );
    const overviewWiki = assertToolResult(
      await client.request("tools/call", { name: "tokengraph_show_wiki_page", arguments: { root, slug: "overview" } }),
      "tokengraph_show_wiki_page"
    );

    return {
      status: "ok",
      root,
      serverEntry,
      tools,
      indexStateBeforeMap: status.state,
      filesIndexed: map.counts?.files ?? 0,
      symbolsIndexed: map.counts?.symbols ?? 0,
      recommendedFirstReads: plan.recommendedFirstReads ?? [],
      activeProfile: config.tokenSavingProfile,
      estimatedTokensAvoided: savings.avoided ?? 0,
      memoriesReviewed: memoryReview.totalMemories ?? 0,
      exportedMapNodes: projectMapExport.nodeCount ?? 0,
      exportedMapEdges: projectMapExport.edgeCount ?? 0,
      compressedContextConfidence: compressedContext.confidence ?? "unknown",
      wikiPageSlugs: (generatedWiki.pages ?? []).map((page) => page.slug),
      wikiStatus: overviewWiki.wikiStatus?.state ?? "unknown"
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
