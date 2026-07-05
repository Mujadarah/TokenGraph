import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const tempRoots: string[] = [];
let server: ChildProcessWithoutNullStreams | undefined;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-mcp-"));
  tempRoots.push(root);
  return root;
}

function send(message: Record<string, unknown>) {
  server?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function readResponse(id: number, timeoutMs = 5000): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}. Last stdout: ${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as JsonRpcResponse;
        if (parsed.id === id) {
          cleanup();
          resolve(parsed);
        }
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      server?.stdout.off("data", onData);
      server?.off("error", onError);
    };

    server?.stdout.on("data", onData);
    server?.once("error", onError);
  });
}

async function request(id: number, method: string, params?: Record<string, unknown>) {
  const pending = readResponse(id);
  send({ id, method, ...(params ? { params } : {}) });
  const response = await pending;
  if (response.error) {
    throw new Error(`${method} failed: ${response.error.message}`);
  }
  return response.result as Record<string, unknown>;
}

beforeEach(() => {
  server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
});

afterEach(async () => {
  server?.kill();
  server = undefined;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TokenGraph MCP stdio server", () => {
  it("lists tools, reports index status, indexes, and resets over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    await writeFile(
      join(root, "src", "patientPage.ts"),
      [
        "import { loadPatientSummary } from './patientSummary';",
        "export function renderPatientPage() {",
        "  return loadPatientSummary();",
        "}"
      ].join("\n")
    );

    await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.4.0" }
    });
    send({ method: "notifications/initialized" });

    const listed = await request(2, "tools/list");
    const toolNames = ((listed.tools as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "tokengraph_index_project",
        "tokengraph_index_status",
        "tokengraph_reset_project",
        "tokengraph_project_map",
        "tokengraph_plan_context",
        "tokengraph_compress_output"
      ])
    );

    const missingStatus = await request(3, "tools/call", {
      name: "tokengraph_index_status",
      arguments: { root }
    });
    expect(missingStatus.structuredContent).toMatchObject({
      state: "missing",
      hasIndex: false
    });

    const indexed = await request(4, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    expect(indexed.structuredContent).toMatchObject({
      status: "indexed",
      map: {
        counts: {
          files: 2
        }
      }
    });

    const freshStatus = await request(5, "tools/call", {
      name: "tokengraph_index_status",
      arguments: { root }
    });
    expect(freshStatus.structuredContent).toMatchObject({
      state: "fresh",
      hasIndex: true
    });

    const explanation = await request(6, "tools/call", {
      name: "tokengraph_explain_symbol",
      arguments: { root, target: "loadPatientSummary" }
    });
    expect(explanation.structuredContent).toMatchObject({
      target: "loadPatientSummary",
      inboundReferences: [
        expect.objectContaining({
          filePath: "src/patientPage.ts",
          source: "./patientSummary",
          resolvedPath: "src/patientSummary.ts"
        })
      ],
      outboundReferences: []
    });

    const reset = await request(7, "tools/call", {
      name: "tokengraph_reset_project",
      arguments: { root, mode: "index" }
    });
    expect(reset.structuredContent).toMatchObject({
      status: "reset",
      mode: "index"
    });

    const resetStatus = await request(8, "tools/call", {
      name: "tokengraph_index_status",
      arguments: { root }
    });
    expect(resetStatus.structuredContent).toMatchObject({
      state: "missing",
      hasIndex: false
    });
  });
});
