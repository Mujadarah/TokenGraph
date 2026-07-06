import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { indexProject } from "../src/core/projectIndexer.js";

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const tempRoots: string[] = [];
let server: ChildProcessWithoutNullStreams | undefined;
const serverEntry = resolve("dist/index.js");

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
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
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
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Server exited before JSON-RPC response ${id} (code ${code ?? "null"}, signal ${signal ?? "null"}). Stderr: ${stderrBuffer}`));
    };
    let stderrBuffer = "";
    const onStderr = (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    };
    const cleanup = () => {
      clearTimeout(timeout);
      server?.stdout.off("data", onData);
      server?.stderr.off("data", onStderr);
      server?.off("error", onError);
      server?.off("exit", onExit);
    };

    server?.stdout.on("data", onData);
    server?.stderr.on("data", onStderr);
    server?.once("error", onError);
    server?.once("exit", onExit);
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

function startServer(cwd: string = process.cwd()) {
  server = spawn(process.execPath, [serverEntry], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function stopServer() {
  if (!server) {
    return;
  }
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    current.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    current.kill();
  });
}

beforeEach(() => {
  startServer();
});

afterEach(async () => {
  await stopServer();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TokenGraph MCP stdio server", () => {
  it("lists tools, reports index status, indexes, and resets over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
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
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
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
        "tokengraph_compress_output",
        "tokengraph_review_memories",
        "tokengraph_export_project_map"
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

  it("reviews memories and exports a visual project map over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "components"), { recursive: true });
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await writeFile(join(root, "components", "PatientCard.tsx"), "export function PatientCard() { return <article />; }");
    await writeFile(
      join(root, "app", "patients", "page.tsx"),
      [
        "import { PatientCard } from '../../components/PatientCard';",
        "export default function PatientsPage() {",
        "  return <PatientCard />;",
        "}"
      ].join("\n")
    );

    await request(30, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    await request(31, "tools/call", {
      name: "tokengraph_remember_decision",
      arguments: {
        type: "architecture",
        title: "Patient summaries stay tenant scoped",
        body: "Patient summary loading must stay tenant scoped and respect RLS policies.",
        tags: ["patients", "summary", "rls"]
      }
    });

    const review = await request(32, "tools/call", {
      name: "tokengraph_review_memories",
      arguments: { query: "patient summary tenant", limit: 3 }
    });
    expect(review.structuredContent).toMatchObject({
      totalMemories: 1,
      matches: [
        expect.objectContaining({
          title: "Patient summaries stay tenant scoped",
          action: "keep"
        })
      ]
    });

    const exported = await request(33, "tools/call", {
      name: "tokengraph_export_project_map",
      arguments: { format: "mermaid", limit: 10 }
    });
    expect(exported.structuredContent).toMatchObject({
      format: "mermaid",
      nodeCount: 2,
      edgeCount: 1
    });
    expect(JSON.stringify(exported.structuredContent)).toContain("flowchart LR");
    expect(JSON.stringify(exported.structuredContent)).not.toContain("return <PatientCard");
  });

  it("rejects roots outside the launched workspace", async () => {
    const root = await makeRoot();
    const outsideRoot = await makeRoot();
    await stopServer();
    startServer(root);

    await request(10, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const response = await request(11, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root: outsideRoot }
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toMatch(/outside the allowed workspace/i);
  });

  it("accepts an explicit workspace root when launched from the installed plugin root", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    await stopServer();
    startServer(process.cwd());

    await request(40, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const mapped = await request(41, "tools/call", {
      name: "tokengraph_project_map",
      arguments: { root }
    });
    expect(mapped.structuredContent).toMatchObject({
      root,
      counts: {
        files: 1
      }
    });

    const missingRoot = await request(42, "tools/call", {
      name: "tokengraph_project_map",
      arguments: {}
    });
    expect(missingRoot.isError).toBe(true);
    expect(JSON.stringify(missingRoot)).toMatch(/pass the workspace root/i);
  });

  it("summarizes v0.5 SQL objects over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase", "migrations", "001_patient_rollups.sql"),
      `
        create extension if not exists "uuid-ossp";
        create table public.patients (id uuid primary key, tenant_id uuid, archived_at timestamptz);
        create policy "tenant can read active patients" on public.patients for select to authenticated using (tenant_id = auth.uid() and archived_at is null);
        create materialized view public.patient_rollups as select tenant_id, count(*) from public.patients group by tenant_id;
      `
    );
    await stopServer();
    startServer(root);

    await request(16, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const summary = await request(17, "tools/call", {
      name: "tokengraph_summarize_sql",
      arguments: { query: "tenant active patient rollups authenticated", limit: 5 }
    });

    expect(summary.structuredContent).toMatchObject({
      query: "tenant active patient rollups authenticated",
      sql: expect.arrayContaining([
        expect.objectContaining({ kind: "policy", name: "tenant can read active patients" }),
        expect.objectContaining({ kind: "materializedView", name: "public.patient_rollups" })
      ])
    });
  });

  it("reindexes stale persisted indexes before serving read tools", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(join(root, "src", "real.ts"), "export function RealSymbol() { return true; }");
    await writeFile(
      join(root, ".tokengraph", "index.json"),
      JSON.stringify(
        {
          root,
          scannedAt: "2026-07-06T00:00:00.000Z",
          fingerprint: "stale-fingerprint",
          frameworks: ["TypeScript"],
          files: [],
          symbols: [
            {
              name: "InjectedOutsideSymbol",
              kind: "function",
              filePath: "../../outside-secret.ts",
              exported: true,
              startLine: 1,
              endLine: 1
            }
          ],
          imports: [],
          exclusions: [],
          sql: { tables: [], relations: [], policies: [], indexes: [], triggers: [], functions: [], views: [] }
        },
        null,
        2
      )
    );
    await stopServer();
    startServer(root);

    await request(12, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const explanation = await request(13, "tools/call", {
      name: "tokengraph_explain_symbol",
      arguments: { target: "InjectedOutsideSymbol" }
    });

    expect(explanation.structuredContent).toMatchObject({
      symbols: [],
      explanation: "No indexed file or symbol matched this target."
    });
  });

  it("ignores crafted persisted indexes even when they claim the current fingerprint", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(join(root, "src", "real.ts"), "export function RealSymbol() { return true; }");
    const current = await indexProject(root);
    await writeFile(
      join(root, ".tokengraph", "index.json"),
      JSON.stringify(
        {
          ...current,
          symbols: [
            {
              name: "InjectedOutsideSymbol",
              kind: "function",
              filePath: "../../outside-secret.ts",
              exported: true,
              startLine: 1,
              endLine: 1
            }
          ]
        },
        null,
        2
      )
    );
    await stopServer();
    startServer(root);

    await request(14, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const explanation = await request(15, "tools/call", {
      name: "tokengraph_explain_symbol",
      arguments: { target: "InjectedOutsideSymbol" }
    });

    expect(explanation.structuredContent).toMatchObject({
      symbols: [],
      explanation: "No indexed file or symbol matched this target."
    });
  });

  it("serves fresh persisted indexes without reindexing when the scan signature matches", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "real.ts"), "export function RealSymbol() { return true; }");
    const current = await indexProject(root);
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(
      join(root, ".tokengraph", "index.json"),
      JSON.stringify(
        {
          ...current,
          scannedAt: "2000-01-01T00:00:00.000Z"
        },
        null,
        2
      )
    );
    await stopServer();
    startServer(root);

    await request(50, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const mapped = await request(51, "tools/call", {
      name: "tokengraph_project_map",
      arguments: { root }
    });

    expect(mapped.structuredContent).toMatchObject({
      scannedAt: "2000-01-01T00:00:00.000Z"
    });
  });

  it("returns a friendly error for missing workspace roots", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);

    await request(52, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const response = await request(53, "tools/call", {
      name: "tokengraph_project_map",
      arguments: { root: join(root, "missing") }
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toMatch(/does not exist or is not readable/i);
  });
});
