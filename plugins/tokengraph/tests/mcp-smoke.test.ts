import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

function startServer(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ...env };
  if (!env.TOKENGRAPH_WORKSPACE_ROOT && !env.CLAUDE_PROJECT_DIR && cwd !== process.cwd()) {
    childEnv.TOKENGRAPH_WORKSPACE_ROOT = cwd;
  }
  server = spawn(process.execPath, [serverEntry], {
    cwd,
    env: childEnv,
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
    const listedTools = (listed.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }> | undefined) ?? [];
    const toolNames = listedTools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "tokengraph_index_project",
        "tokengraph_index_status",
        "tokengraph_reset_project",
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
      ])
    );
    const indexWritingTools = [
      "tokengraph_check_architecture",
      "tokengraph_trace_failure",
      "tokengraph_assess_change_risk",
      "tokengraph_project_map",
      "tokengraph_plan_context",
      "tokengraph_search_graph",
      "tokengraph_explain_symbol",
      "tokengraph_summarize_sql",
      "tokengraph_compress_context",
      "tokengraph_export_project_map",
      "tokengraph_show_token_savings"
    ];
    for (const name of indexWritingTools) {
      expect(listedTools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(listedTools.find((tool) => tool.name === "tokengraph_recall_memory")?.annotations?.idempotentHint).toBe(false);

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
      indexingMode: "full",
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

    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummaryNew() { return null; }");
    const incremented = await request(54, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    expect(incremented.structuredContent).toMatchObject({
      status: "indexed",
      indexingMode: "incremental",
      changes: {
        changedFiles: ["src/patientSummary.ts"],
        parsedFiles: ["src/patientSummary.ts"]
      }
    });

    const explanation = await request(6, "tools/call", {
      name: "tokengraph_explain_symbol",
      arguments: { root, target: "loadPatientSummaryNew" }
    });
    expect(explanation.structuredContent).toMatchObject({
      target: "loadPatientSummaryNew",
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

  it("manages architecture rules and checks architecture over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "src", "ui"), { recursive: true });
    await mkdir(join(root, "src", "server"), { recursive: true });
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(join(root, "src", "ui", "page.ts"), "import { queryDb } from '../server/db'; export const page = queryDb;");
    await writeFile(join(root, "src", "server", "db.ts"), "export const queryDb = true;");
    await writeFile(
      join(root, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        plugins: [
          {
            name: "tokengraph",
            source: { source: "local", path: "./plugins/tokengraph" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }
          }
        ]
      })
    );

    await request(100, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    const added = await request(101, "tools/call", {
      name: "tokengraph_add_rule",
      arguments: {
        root,
        type: "forbidden-import",
        name: "UI cannot import server",
        fromPattern: "^src/ui/",
        targetPattern: "^src/server/",
        severity: "error"
      }
    });
    expect(added.structuredContent).toMatchObject({
      status: "added",
      rule: {
        type: "forbidden-import",
        name: "UI cannot import server"
      }
    });

    const listed = await request(102, "tools/call", {
      name: "tokengraph_list_rules",
      arguments: { root }
    });
    expect(listed.structuredContent).toMatchObject({
      rules: [expect.objectContaining({ name: "UI cannot import server" })]
    });

    const ruleId = (added.structuredContent as { rule: { id: string } }).rule.id;
    const updated = await request(103, "tools/call", {
      name: "tokengraph_update_rule",
      arguments: { root, id: ruleId, message: "Use the public client boundary." }
    });
    expect(updated.structuredContent).toMatchObject({
      status: "updated",
      rule: {
        id: ruleId,
        message: "Use the public client boundary."
      }
    });

    const checked = await request(104, "tools/call", {
      name: "tokengraph_check_architecture",
      arguments: { root }
    });
    expect(checked.structuredContent).toMatchObject({
      status: "checked",
      violations: [
        expect.objectContaining({
          type: "forbidden-import",
          ruleName: "UI cannot import server",
          filePath: "src/ui/page.ts",
          targetPath: "src/server/db.ts"
        })
      ],
      warnings: [expect.objectContaining({ type: "marketplace-target", sourcePath: "./plugins/tokengraph" })]
    });

    const deleted = await request(105, "tools/call", {
      name: "tokengraph_delete_rule",
      arguments: { root, id: ruleId }
    });
    expect(deleted.structuredContent).toMatchObject({ status: "deleted", id: ruleId });
  });

  it("traces failure output with compact graph-related recommendations", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "services"), { recursive: true });
    await writeFile(join(root, "services", "patientService.ts"), "export function loadPatientSummary() { return []; }");
    await writeFile(
      join(root, "services", "patientService.test.ts"),
      "import { loadPatientSummary } from './patientService'; it('keeps tenant scoped rows', () => loadPatientSummary());"
    );

    await request(110, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    const traced = await request(111, "tools/call", {
      name: "tokengraph_trace_failure",
      arguments: {
        root,
        kind: "test",
        task: "Fix patient summary tenant scoped rows",
        text: [
          "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
          "AssertionError: expected 2 to be 1",
          "    at loadPatientSummary (services/patientService.ts:1:17)",
          "    at services/patientService.test.ts:1:82"
        ].join("\n")
      }
    });

    expect(traced.structuredContent).toMatchObject({
      detectedPaths: expect.arrayContaining(["services/patientService.ts", "services/patientService.test.ts"]),
      detectedTests: expect.arrayContaining(["services/patientService.test.ts > patient summary > keeps tenant scoped rows"]),
      detectedSymbols: expect.arrayContaining(["loadPatientSummary"]),
      hypotheses: [expect.objectContaining({ label: "hypothesis" })],
      recommendedCommands: expect.arrayContaining(["pnpm test -- services/patientService.test.ts"])
    });
    expect(JSON.stringify(traced.structuredContent)).toContain("AssertionError: expected 2 to be 1");
  });

  it("compresses mixed context while preserving implementation-critical references", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "services", "patientService.ts"), "export function loadPatientSummary() { return []; }");
    await writeFile(
      join(root, "services", "patientService.test.ts"),
      "import { loadPatientSummary } from './patientService'; it('keeps tenant scoped rows', () => loadPatientSummary());"
    );
    await writeFile(
      join(root, "supabase", "migrations", "20260708_add_patient_rls.sql"),
      "create policy \"tenant rows only\" on public.patients for select using (tenant_id = auth.uid());"
    );

    await request(115, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    await request(116, "tools/call", {
      name: "tokengraph_remember_decision",
      arguments: {
        root,
        type: "bug",
        title: "Patient RLS failures keep exact test output",
        body: "Preserve exact failing test names, stack paths, RLS migration identifiers, and tenant-isolation warnings.",
        tags: ["patient", "rls", "test"]
      }
    });

    const compressed = await request(117, "tools/call", {
      name: "tokengraph_compress_context",
      arguments: {
        root,
        task: "Fix patient summary tenant scoped rows without weakening RLS",
        contentKind: "mixed",
        preserveRawReferences: true,
        text: [
          "User constraint: Do not remove public API loadPatientSummary.",
          "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
          "AssertionError: expected 2 to be 1",
          "    at loadPatientSummary (services/patientService.ts:1:17)",
          "Migration 20260708_add_patient_rls.sql must preserve RLS policy using tenant_id = auth.uid().",
          "Security warning: tenant isolation is required.",
          ...Array.from({ length: 60 }, (_, index) => `irrelevant expanded context line ${index}`)
        ].join("\n")
      }
    });

    expect(compressed.structuredContent).toMatchObject({
      compressedTask: expect.stringContaining("Fix patient summary tenant scoped rows"),
      preservedConstraints: expect.arrayContaining([
        "User constraint: Do not remove public API loadPatientSummary.",
        "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
        "AssertionError: expected 2 to be 1",
        "at loadPatientSummary (services/patientService.ts:1:17)",
        "Migration 20260708_add_patient_rls.sql must preserve RLS policy using tenant_id = auth.uid().",
        "Security warning: tenant isolation is required."
      ]),
      referencedMemories: expect.arrayContaining([expect.objectContaining({ title: "Patient RLS failures keep exact test output" })]),
      recommendedFirstReads: expect.arrayContaining([expect.objectContaining({ path: "services/patientService.ts", startLine: 1 })])
    });
    expect((compressed.structuredContent as { omissions: string[] }).omissions.join("\n")).toMatch(/omitted/i);
    expect((compressed.structuredContent as { estimatedTokens: { avoided: number } }).estimatedTokens.avoided).toBeGreaterThan(0);
    expect((compressed.structuredContent as { confidence: string }).confidence).toMatch(/medium|high/);
  });

  it("assesses change risk with graph, SQL, rule, test, and memory signals", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await mkdir(join(root, "src", "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(
      join(root, "app", "patients", "page.tsx"),
      "import { loadPatientSummary } from '../../src/services/patientService'; export default function Page() { return loadPatientSummary(); }"
    );
    await writeFile(join(root, "src", "services", "patientService.ts"), "export function loadPatientSummary() { return []; }");
    await writeFile(
      join(root, "src", "services", "patientService.test.ts"),
      "import { loadPatientSummary } from './patientService'; it('keeps tenant scoped rows', () => loadPatientSummary());"
    );
    await writeFile(
      join(root, "supabase", "migrations", "001_patient_rls.sql"),
      [
        "create table public.patients (id uuid primary key, tenant_id uuid, auth_user_id uuid);",
        "create policy \"tenant can read patients\" on public.patients for select using (tenant_id = auth.uid());",
        "create function public.audit_patient_change() returns trigger language plpgsql as $$ begin return new; end; $$;"
      ].join("\n")
    );

    await request(120, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    const remembered = await request(121, "tools/call", {
      name: "tokengraph_remember_decision",
      arguments: {
        root,
        type: "bug",
        title: "Patient tenant scoping is fragile",
        body: "Past patient summary bugs leaked tenant rows when auth and RLS context were skipped.",
        tags: ["patient", "tenant", "fragile", "rls"]
      }
    });
    expect(remembered.structuredContent).toMatchObject({ status: "remembered" });

    const addedRule = await request(122, "tools/call", {
      name: "tokengraph_add_rule",
      arguments: {
        root,
        type: "forbidden-import",
        name: "Routes cannot import services directly",
        fromPattern: "^app/",
        targetPattern: "^src/services/",
        severity: "warning"
      }
    });
    expect(addedRule.structuredContent).toMatchObject({ status: "added" });

    const assessed = await request(123, "tools/call", {
      name: "tokengraph_assess_change_risk",
      arguments: {
        root,
        changedFiles: ["src/services/patientService.ts", "supabase/migrations/001_patient_rls.sql"],
        task: "Change patient summary tenant scoping and audit logging",
        diffSummary: "Touches tenant_id RLS policy, auth user lookup, and audit logging for patient summaries."
      }
    });

    expect(assessed.structuredContent).toMatchObject({
      riskLevel: "high",
      affectedFiles: expect.arrayContaining([expect.objectContaining({ path: "app/patients/page.tsx" })]),
      affectedTests: expect.arrayContaining([expect.objectContaining({ path: "src/services/patientService.test.ts" })]),
      affectedSql: expect.arrayContaining([expect.objectContaining({ kind: "policy", name: "tenant can read patients" })]),
      affectedRules: expect.arrayContaining([expect.objectContaining({ ruleName: "Routes cannot import services directly" })]),
      affectedMemories: expect.arrayContaining([expect.objectContaining({ title: "Patient tenant scoping is fragile" })]),
      recommendedTests: expect.arrayContaining(["pnpm test -- src/services/patientService.test.ts"])
    });
    expect((assessed.structuredContent as { riskScore: number }).riskScore).toBeGreaterThanOrEqual(70);
    expect(JSON.stringify((assessed.structuredContent as { manualReviewWarnings: string[] }).manualReviewWarnings)).toMatch(/RLS|tenant|audit/i);
  });

  it("manages memory lifecycle metadata over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);

    await request(130, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    const remembered = await request(131, "tools/call", {
      name: "tokengraph_remember_decision",
      arguments: {
        root,
        type: "architecture",
        title: "Use REST patient API",
        body: "Use REST endpoints for patient reads until the API migration is complete.",
        tags: ["patient", "api"],
        source: "mcp-smoke",
        evidence: ["Initial memory lifecycle smoke test"]
      }
    });
    const memoryId = (remembered.structuredContent as { memory: { id: string } }).memory.id;

    const updated = await request(132, "tools/call", {
      name: "tokengraph_update_memory",
      arguments: { root, id: memoryId, confidence: "medium", tags: ["patient", "api", "tenant"] }
    });
    expect(updated.structuredContent).toMatchObject({
      status: "updated",
      memory: expect.objectContaining({ id: memoryId, status: "active", tags: ["patient", "api", "tenant"] })
    });

    const confirmed = await request(133, "tools/call", {
      name: "tokengraph_confirm_memory",
      arguments: { root, id: memoryId, evidence: ["Confirmed by test fixture"] }
    });
    expect(confirmed.structuredContent).toMatchObject({
      status: "confirmed",
      memory: expect.objectContaining({ id: memoryId, confidence: "high", confirmedAt: expect.any(String) })
    });

    const linked = await request(134, "tools/call", {
      name: "tokengraph_link_memory",
      arguments: {
        root,
        id: memoryId,
        linkedFiles: ["src/services/patientService.ts"],
        linkedSymbols: ["loadPatientSummary"],
        linkedSqlObjects: ["public.patients"],
        linkedRules: ["rule_patient_api"],
        evidence: ["Linked by smoke test"]
      }
    });
    expect(linked.structuredContent).toMatchObject({
      status: "linked",
      memory: expect.objectContaining({
        id: memoryId,
        linkedFiles: ["src/services/patientService.ts"],
        linkedSymbols: ["loadPatientSummary"],
        linkedSqlObjects: ["public.patients"],
        linkedRules: ["rule_patient_api"]
      })
    });

    const conflicts = await request(135, "tools/call", {
      name: "tokengraph_find_memory_conflicts",
      arguments: {
        root,
        candidate: {
          type: "architecture",
          title: "Use GraphQL patient API",
          body: "Prefer GraphQL instead of REST for patient reads.",
          tags: ["patient", "api"]
        }
      }
    });
    expect(conflicts.structuredContent).toMatchObject({
      conflicts: [expect.objectContaining({ memory: expect.objectContaining({ id: memoryId, status: "active" }) })],
      policy: expect.stringMatching(/not automatically resolved/i)
    });

    const recalled = await request(136, "tools/call", {
      name: "tokengraph_recall_memory",
      arguments: { root, query: "patient api", limit: 5 }
    });
    expect(recalled.structuredContent).toMatchObject({
      memories: [expect.objectContaining({ id: memoryId, status: "active", lastUsedAt: expect.any(String) })]
    });

    const deprecated = await request(137, "tools/call", {
      name: "tokengraph_deprecate_memory",
      arguments: { root, id: memoryId, supersededBy: ["mem_next"], evidence: ["GraphQL migration superseded it"] }
    });
    expect(deprecated.structuredContent).toMatchObject({
      status: "deprecated",
      memory: expect.objectContaining({ id: memoryId, status: "deprecated", supersededBy: ["mem_next"] })
    });

    const normalRecall = await request(138, "tools/call", {
      name: "tokengraph_recall_memory",
      arguments: { root, query: "patient api" }
    });
    expect(normalRecall.structuredContent).toMatchObject({ memories: [] });

    const deleted = await request(139, "tools/call", {
      name: "tokengraph_delete_memory",
      arguments: { root, id: memoryId }
    });
    expect(deleted.structuredContent).toMatchObject({ status: "deleted", id: memoryId, hard: false });

    const auditRecall = await request(140, "tools/call", {
      name: "tokengraph_recall_memory",
      arguments: { root, query: "patient api", auditMode: true }
    });
    expect(auditRecall.structuredContent).toMatchObject({
      memories: [expect.objectContaining({ id: memoryId, status: "deleted" })]
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
      edgeCount: 1,
      resourceLinks: [
        expect.objectContaining({
          label: "TokenGraph project map",
          mimeType: "text/vnd.mermaid"
        })
      ],
      markdownFallback: expect.stringContaining("```mermaid")
    });
    expect(exported.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "resource_link",
          uri: expect.stringMatching(/^tokengraph:\/\/project-map\//),
          mimeType: "text/vnd.mermaid"
        })
      ])
    );
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
    expect(JSON.stringify(response)).toMatch(/outside (the allowed|the trusted|trusted) workspace/i);
  });

  it("generates and reads project wiki pages over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "app", "patients", "[id]"), { recursive: true });
    await mkdir(join(root, "components"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "components", "PatientCard.tsx"), "export function PatientCard() { return <article />; }");
    await writeFile(
      join(root, "app", "patients", "[id]", "page.tsx"),
      "import { PatientCard } from '../../../components/PatientCard'; export default function PatientPage() { return <PatientCard />; }"
    );
    await writeFile(
      join(root, "supabase", "migrations", "001_patients.sql"),
      "create table public.patients (id uuid primary key); create policy \"tenant can read patients\" on public.patients for select using (true);"
    );

    await request(80, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.9.0" }
    });
    send({ method: "notifications/initialized" });

    const missing = await request(81, "tools/call", {
      name: "tokengraph_generate_wiki",
      arguments: { root }
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toMatch(/tokengraph_index_project/i);

    await request(82, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    const generated = await request(83, "tools/call", {
      name: "tokengraph_generate_wiki",
      arguments: { root }
    });
    expect(generated.structuredContent).toMatchObject({
      status: "generated",
      wikiStatus: { state: "fresh" },
      pages: expect.arrayContaining([
        expect.objectContaining({ slug: "overview", title: "Project Overview", estimatedTokens: expect.any(Number) }),
        expect.objectContaining({ slug: "database", title: "Database", estimatedTokens: expect.any(Number) })
      ])
    });

    const overview = await request(84, "tools/call", {
      name: "tokengraph_show_wiki_page",
      arguments: { root, slug: "overview" }
    });
    expect(overview.structuredContent).toMatchObject({
      slug: "overview",
      title: "Project Overview",
      wikiStatus: { state: "fresh" }
    });
    expect(JSON.stringify(overview.structuredContent)).toContain("# Project Overview");

    const unknown = await request(85, "tools/call", {
      name: "tokengraph_show_wiki_page",
      arguments: { root, slug: "missing" }
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).toMatch(/available slugs.*overview/i);

    await writeFile(join(root, "components", "PatientCard.tsx"), "export function PatientCardRenamed() { return <article />; }");
    await request(86, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    const stale = await request(87, "tools/call", {
      name: "tokengraph_show_wiki_page",
      arguments: { root, slug: "overview" }
    });
    expect(stale.structuredContent).toMatchObject({
      wikiStatus: { state: "stale" }
    });
  });

  it("applies workspace root boundaries to wiki tools", async () => {
    const root = await makeRoot();
    const outsideRoot = await makeRoot();
    await stopServer();
    startServer(root);

    await request(88, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.9.0" }
    });
    send({ method: "notifications/initialized" });

    const generate = await request(89, "tools/call", {
      name: "tokengraph_generate_wiki",
      arguments: { root: outsideRoot }
    });
    expect(generate.isError).toBe(true);
    expect(JSON.stringify(generate)).toMatch(/outside (the allowed|the trusted|trusted) workspace/i);

    const show = await request(90, "tools/call", {
      name: "tokengraph_show_wiki_page",
      arguments: { root: outsideRoot, slug: "overview" }
    });
    expect(show.isError).toBe(true);
    expect(JSON.stringify(show)).toMatch(/outside (the allowed|the trusted|trusted) workspace/i);
  });

  it("leaves wiki auto-refresh off by default during indexing", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummary() { return true; }");
    await stopServer();
    startServer(root);

    await request(91, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.9.0" }
    });
    send({ method: "notifications/initialized" });

    const indexed = await request(92, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    expect(indexed.structuredContent).toMatchObject({
      status: "indexed",
      wikiRefreshed: false
    });
    await expect(access(join(root, ".tokengraph", "wiki"))).rejects.toThrow();
  });

  it("auto-refreshes the wiki on full and incremental indexing when enabled", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummary() { return true; }");
    await stopServer();
    startServer(root);

    await request(93, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.9.0" }
    });
    send({ method: "notifications/initialized" });

    await request(94, "tools/call", {
      name: "tokengraph_update_config",
      arguments: { root, wikiGenerationEnabled: true }
    });
    const full = await request(95, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root, fullReindex: true }
    });
    expect(full.structuredContent).toMatchObject({
      status: "indexed",
      indexingMode: "full",
      wikiRefreshed: true
    });
    const fullOverview = await request(96, "tools/call", {
      name: "tokengraph_show_wiki_page",
      arguments: { root, slug: "overview" }
    });
    expect(fullOverview.structuredContent).toMatchObject({
      wikiStatus: { state: "fresh" }
    });

    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummaryChanged() { return true; }");
    const incremental = await request(97, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    expect(incremental.structuredContent).toMatchObject({
      status: "indexed",
      indexingMode: "incremental",
      wikiRefreshed: true
    });
    const incrementalOverview = await request(98, "tools/call", {
      name: "tokengraph_show_wiki_page",
      arguments: { root, slug: "overview" }
    });
    expect(incrementalOverview.structuredContent).toMatchObject({
      wikiStatus: { state: "fresh" }
    });
  });

  it("manages local config and profile-aware plans over JSON-RPC stdio", async () => {
    const root = await makeRoot();
    await stopServer();
    startServer(root);
    await mkdir(join(root, "services"), { recursive: true });
    for (let index = 1; index <= 5; index += 1) {
      await writeFile(join(root, "services", `patientSummary${index}.ts`), `export function patientSummary${index}() { return ${index}; }`);
    }

    await request(70, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.9.0" }
    });
    send({ method: "notifications/initialized" });

    const defaults = await request(71, "tools/call", {
      name: "tokengraph_get_config",
      arguments: { root }
    });
    expect(defaults.structuredContent).toMatchObject({
      tokenSavingProfile: "balanced",
      maxFiles: 6,
      maxSqlObjects: 6,
      maxMemories: 4
    });

    const profiled = await request(72, "tools/call", {
      name: "tokengraph_set_profile",
      arguments: { root, profile: "aggressive" }
    });
    expect(profiled.structuredContent).toMatchObject({
      status: "updated",
      config: {
        tokenSavingProfile: "aggressive",
        maxFiles: 6
      }
    });

    const updated = await request(73, "tools/call", {
      name: "tokengraph_update_config",
      arguments: { root, maxFiles: 4, maxPlannedContextTokens: 5000, memoryEnabled: false }
    });
    expect(updated.structuredContent).toMatchObject({
      status: "updated",
      config: {
        tokenSavingProfile: "aggressive",
        maxFiles: 4,
        maxPlannedContextTokens: 5000,
        memoryEnabled: false
      }
    });

    const plan = await request(74, "tools/call", {
      name: "tokengraph_plan_context",
      arguments: { root, task: "Fix patient summary" }
    });
    expect(plan.structuredContent).toMatchObject({
      profile: "aggressive",
      budget: {
        maxFiles: 3
      }
    });
  });

  it("rejects an outside root when launched from the installed plugin root", async () => {
    const root = await makeRoot();
    const outsideRoot = await makeRoot();
    await writeFile(join(outsideRoot, "outside.ts"), "export const outsideValue = true;");
    await stopServer();
    startServer(process.cwd(), { TOKENGRAPH_WORKSPACE_ROOT: root, CLAUDE_PROJECT_DIR: "" });

    await request(60, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const response = await request(61, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root: outsideRoot }
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toMatch(/outside the trusted workspace/i);
    await expect(access(join(outsideRoot, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when launched from the installed plugin root without a trusted workspace", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    await stopServer();
    startServer(process.cwd(), { TOKENGRAPH_WORKSPACE_ROOT: "", CLAUDE_PROJECT_DIR: "" });

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
    expect(mapped.isError).toBe(true);
    expect(JSON.stringify(mapped)).toMatch(/trusted workspace root/i);

    await expect(access(join(root, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a root inside the host-provided workspace when launched from the plugin root", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    await stopServer();
    startServer(process.cwd(), { TOKENGRAPH_WORKSPACE_ROOT: root, CLAUDE_PROJECT_DIR: "" });

    await request(43, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.7.0" }
    });
    send({ method: "notifications/initialized" });

    const mapped = await request(44, "tools/call", {
      name: "tokengraph_project_map",
      arguments: { root }
    });
    expect(mapped.structuredContent).toMatchObject({ root, counts: { files: 1 } });
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

  it("rejects nested traversal paths in crafted persisted indexes", async () => {
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
              name: "NestedInjectedOutsideSymbol",
              kind: "function",
              filePath: "src/../../outside-secret.ts",
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

    await request(60, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    const explanation = await request(61, "tools/call", {
      name: "tokengraph_explain_symbol",
      arguments: { target: "NestedInjectedOutsideSymbol" }
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

  it("persists a refreshed scan signature after a metadata-only change", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src", "stable.ts");
    await writeFile(file, "export const stable = true;\n");
    await stopServer();
    startServer(root);

    await request(70, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    await request(71, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    const before = JSON.parse(await readFile(join(root, ".tokengraph", "index.json"), "utf8")) as {
      fingerprint: string;
      scanSignature: string;
    };

    const original = await readFile(file, "utf8");
    const touchedAt = new Date(Date.now() + 2_000);
    await utimes(file, touchedAt, touchedAt);
    expect(await readFile(file, "utf8")).toBe(original);
    const mapped = await request(72, "tools/call", {
      name: "tokengraph_project_map",
      arguments: { root }
    });
    const after = JSON.parse(await readFile(join(root, ".tokengraph", "index.json"), "utf8")) as {
      fingerprint: string;
      scanSignature: string;
    };

    expect(mapped.structuredContent).toMatchObject({ root });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.scanSignature).not.toBe(before.scanSignature);
    const status = await request(73, "tools/call", {
      name: "tokengraph_index_status",
      arguments: { root }
    });
    expect(status.structuredContent).toMatchObject({ state: "fresh" });
  });

  it("serializes overlapping index operations for one project", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "first.ts"), "export const first = true;\n");
    await stopServer();
    startServer(root);

    await request(80, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tokengraph-smoke-test", version: "0.17.0" }
    });
    send({ method: "notifications/initialized" });

    await request(81, "tools/call", {
      name: "tokengraph_index_project",
      arguments: { root }
    });
    await writeFile(join(root, "src", "second.ts"), "export const second = true;\n");

    const [first, second] = await Promise.all([
      request(82, "tools/call", { name: "tokengraph_project_map", arguments: { root } }),
      request(83, "tools/call", { name: "tokengraph_project_map", arguments: { root } })
    ]);

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const final = await request(84, "tools/call", {
      name: "tokengraph_project_map",
      arguments: { root }
    });
    expect(final.structuredContent).toMatchObject({ counts: { files: 2 } });
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
