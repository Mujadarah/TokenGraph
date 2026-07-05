import process from "node:process";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { compressOutput } from "./core/compressor.js";
import { getIndexStatus } from "./core/indexStatus.js";
import { MemoryStore } from "./core/memoryStore.js";
import { buildContextPlan } from "./core/planner.js";
import { indexProject } from "./core/projectIndexer.js";
import { clearProjectIndex, clearProjectState, loadProjectIndex, memoryPath, saveProjectIndex } from "./core/persistence.js";
import { estimateTokens, tokenize } from "./core/token.js";
import type { ProjectIndex, RankedSqlObject } from "./core/types.js";

const DEFAULT_BUDGET = {
  maxFiles: 6,
  maxSqlObjects: 6,
  maxMemories: 4
};

function workspaceRoot(inputRoot?: string): string {
  return inputRoot?.trim() || process.cwd();
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ok<T extends object>(output: T) {
  return {
    content: [{ type: "text" as const, text: compactJson(output) }],
    structuredContent: output
  };
}

async function ensureProject(root: string): Promise<ProjectIndex> {
  const existing = await loadProjectIndex(root);
  if (existing) {
    return existing;
  }
  const indexed = await indexProject(root);
  await saveProjectIndex(root, indexed);
  return indexed;
}

function projectMap(project: ProjectIndex) {
  return {
    root: project.root,
    scannedAt: project.scannedAt,
    fingerprint: project.fingerprint,
    frameworks: project.frameworks,
    counts: {
      files: project.files.length,
      symbols: project.symbols.length,
      imports: project.imports.length,
      tables: project.sql.tables.length,
      policies: project.sql.policies.length,
      memories: undefined as number | undefined
    },
    modules: project.files
      .filter((file) => !file.isTest && file.kind !== "sql")
      .slice(0, 20)
      .map((file) => ({ path: file.path, kind: file.kind, route: file.route })),
    database: {
      tables: project.sql.tables.map((table) => ({ name: table.name, columns: table.columns.length })),
      policies: project.sql.policies.map((policy) => ({ name: policy.name, table: policy.table }))
    }
  };
}

function searchProject(project: ProjectIndex, query: string, limit: number) {
  const terms = tokenize(query);
  const score = (text: string) => terms.reduce((total, term) => total + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  const fileRows = project.files.map((file) => ({
    kind: "file",
    name: file.path,
    path: file.path,
    score: score(`${file.path} ${file.kind} ${file.route ?? ""}`)
  }));
  const symbolRows = project.symbols.map((symbol) => ({
    kind: "symbol",
    name: symbol.name,
    path: symbol.filePath,
    score: score(`${symbol.name} ${symbol.kind} ${symbol.filePath}`)
  }));
  const sqlRows = project.sql.tables.map((table) => ({
    kind: "sql_table",
    name: table.name,
    path: table.filePath,
    score: score(`${table.name} ${table.columns.join(" ")}`)
  }));
  return [...fileRows, ...symbolRows, ...sqlRows]
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function explain(project: ProjectIndex, target: string) {
  const file = project.files.find((candidate) => candidate.path === target);
  const symbols = project.symbols.filter((symbol) => symbol.filePath === target || symbol.name === target);
  const imports = file ? project.imports.filter((edge) => edge.filePath === file.path) : [];
  return {
    target,
    file,
    symbols,
    imports,
    explanation: file
      ? `${target} is indexed as ${file.kind}${file.route ? ` for route ${file.route}` : ""}.`
      : symbols.length
        ? `${target} is a symbol in ${symbols.map((symbol) => symbol.filePath).join(", ")}.`
        : "No indexed file or symbol matched this target."
  };
}

function sqlSummary(project: ProjectIndex, query: string, limit: number): RankedSqlObject[] {
  const terms = tokenize(query);
  const score = (text: string) => terms.reduce((total, term) => total + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  const rows: RankedSqlObject[] = [
    ...project.sql.tables.map((table) => ({
      kind: "table" as const,
      name: table.name,
      filePath: table.filePath,
      reason: `Columns: ${table.columns.join(", ")}`,
      score: score(`${table.name} ${table.columns.join(" ")}`)
    })),
    ...project.sql.policies.map((policy) => ({
      kind: "policy" as const,
      name: policy.name,
      filePath: policy.filePath,
      reason: `Policy on ${policy.table}`,
      score: score(`${policy.name} ${policy.table}`)
    }))
  ];
  return rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function createTokenGraphServer(): McpServer {
  const server = new McpServer({ name: "tokengraph", version: "0.3.0" });

  server.registerTool(
    "tokengraph_index_project",
    {
      title: "Index Project",
      description: "Use this when Codex needs a compact local project map before reading raw files.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root to index. Defaults to the MCP server current working directory.")
      })
    },
    async ({ root }) => {
      const resolvedRoot = workspaceRoot(root);
      const project = await indexProject(resolvedRoot);
      await saveProjectIndex(resolvedRoot, project);
      return ok({ status: "indexed", map: projectMap(project), exclusions: project.exclusions.slice(0, 25) });
    }
  );

  server.registerTool(
    "tokengraph_index_status",
    {
      title: "Index Status",
      description: "Use this before trusting a persisted TokenGraph index to detect missing, fresh, or stale project context.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root to check. Defaults to the MCP server current working directory.")
      })
    },
    async ({ root }) => ok(await getIndexStatus(workspaceRoot(root)))
  );

  server.registerTool(
    "tokengraph_reset_project",
    {
      title: "Reset Project State",
      description: "Use this to clear TokenGraph local state. The default mode clears only the persisted index and preserves memories.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root to reset. Defaults to the MCP server current working directory."),
        mode: z.enum(["index", "all"]).default("index").describe("index clears only index.json; all clears the full .tokengraph state directory.")
      })
    },
    async ({ root, mode }) => {
      const resolvedRoot = workspaceRoot(root);
      if (mode === "all") {
        await clearProjectState(resolvedRoot);
      } else {
        await clearProjectIndex(resolvedRoot);
      }
      return ok({ status: "reset", mode, root: resolvedRoot });
    }
  );

  server.registerTool(
    "tokengraph_project_map",
    {
      title: "Show Project Map",
      description: "Use this when Codex needs a compact overview of indexed modules, symbols, SQL objects, and freshness.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional() })
    },
    async ({ root }) => {
      const resolvedRoot = workspaceRoot(root);
      const project = await ensureProject(resolvedRoot);
      const memories = await new MemoryStore(memoryPath(resolvedRoot)).list();
      const map = projectMap(project);
      map.counts.memories = memories.length;
      return ok(map);
    }
  );

  server.registerTool(
    "tokengraph_plan_context",
    {
      title: "Plan Context",
      description: "Use this before raw file exploration to get the smallest likely files, SQL objects, tests, and memories for a task.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        task: z.string().min(3).describe("The coding task or question to route."),
        maxFiles: z.number().int().min(1).max(20).optional(),
        maxSqlObjects: z.number().int().min(0).max(20).optional(),
        maxMemories: z.number().int().min(0).max(20).optional()
      })
    },
    async ({ root, task, maxFiles, maxSqlObjects, maxMemories }) => {
      const resolvedRoot = workspaceRoot(root);
      const project = await ensureProject(resolvedRoot);
      const memory = new MemoryStore(memoryPath(resolvedRoot));
      const memories = await memory.search(task, maxMemories ?? DEFAULT_BUDGET.maxMemories);
      const plan = await buildContextPlan({
        root: resolvedRoot,
        task,
        project,
        memories,
        budget: {
          maxFiles: maxFiles ?? DEFAULT_BUDGET.maxFiles,
          maxSqlObjects: maxSqlObjects ?? DEFAULT_BUDGET.maxSqlObjects,
          maxMemories: maxMemories ?? DEFAULT_BUDGET.maxMemories
        }
      });
      return ok(plan);
    }
  );

  server.registerTool(
    "tokengraph_search_graph",
    {
      title: "Search Graph",
      description: "Use this to search indexed files, symbols, SQL tables, and routes without reading raw source.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        query: z.string().min(2),
        limit: z.number().int().min(1).max(50).optional()
      })
    },
    async ({ root, query, limit }) => {
      const project = await ensureProject(workspaceRoot(root));
      return ok({ query, results: searchProject(project, query, limit ?? 10) });
    }
  );

  server.registerTool(
    "tokengraph_explain_symbol",
    {
      title: "Explain Symbol",
      description: "Use this when Codex needs to know why a file or symbol is relevant before reading it.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional(), target: z.string().min(1) })
    },
    async ({ root, target }) => {
      const project = await ensureProject(workspaceRoot(root));
      return ok(explain(project, target));
    }
  );

  server.registerTool(
    "tokengraph_summarize_sql",
    {
      title: "Summarize SQL",
      description: "Use this when a task touches data, auth, reports, RLS, migrations, or persistence.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional(), query: z.string().min(2), limit: z.number().int().min(1).max(50).optional() })
    },
    async ({ root, query, limit }) => {
      const project = await ensureProject(workspaceRoot(root));
      return ok({ query, sql: sqlSummary(project, query, limit ?? 10) });
    }
  );

  server.registerTool(
    "tokengraph_compress_output",
    {
      title: "Compress Output",
      description: "Use this to compress test, build, install, diff, or log output before Codex reads a long raw output.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        kind: z.enum(["test", "build", "install", "diff", "log"]),
        text: z.string(),
        maxLines: z.number().int().min(1).max(200).optional()
      })
    },
    async ({ kind, text, maxLines }) => ok(compressOutput({ kind, text, maxLines }))
  );

  server.registerTool(
    "tokengraph_remember_decision",
    {
      title: "Remember Decision",
      description: "Use this only when the user or task outcome provides a durable project decision worth recalling later.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        type: z.enum(["architecture", "convention", "bug", "migration", "product", "security", "lesson"]),
        title: z.string().min(3),
        body: z.string().min(3),
        tags: z.array(z.string()).default([])
      })
    },
    async ({ root, type, title, body, tags }) => {
      const resolvedRoot = workspaceRoot(root);
      const entry = await new MemoryStore(memoryPath(resolvedRoot)).add({ type, title, body, tags });
      return ok({ status: "remembered", memory: entry });
    }
  );

  server.registerTool(
    "tokengraph_show_token_savings",
    {
      title: "Show Token Savings",
      description: "Use this to estimate how many tokens TokenGraph avoided by using the compact local index.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional() })
    },
    async ({ root }) => {
      const project = await ensureProject(workspaceRoot(root));
      const original = project.files.reduce((total, file) => total + file.estimatedTokens, 0);
      const compact = estimateTokens(compactJson(projectMap(project)));
      return ok({ original, compact, avoided: Math.max(0, original - compact), unit: "estimated tokens" });
    }
  );

  return server;
}
