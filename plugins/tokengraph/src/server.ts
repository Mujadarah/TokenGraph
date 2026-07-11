import process from "node:process";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { ArchitectureRuleStore, checkArchitecture } from "./core/architectureRules.js";
import { compressContext } from "./core/contextCompressor.js";
import { compressOutput } from "./core/compressor.js";
import { loadTokenGraphConfig, setTokenSavingProfile, updateTokenGraphConfig } from "./core/config.js";
import { scanProjectSignature } from "./core/fileScanner.js";
import { getIndexStatus, isFreshProjectIndex } from "./core/indexStatus.js";
import { traceFailure } from "./core/failureTracer.js";
import { MemoryStore } from "./core/memoryStore.js";
import { buildContextPlan } from "./core/planner.js";
import { indexProject, updateProjectIndexIncremental } from "./core/projectIndexer.js";
import { assessChangeRisk } from "./core/regressionRisk.js";
import {
  clearProjectIndex,
  clearProjectState,
  getWikiStatus,
  loadProjectIndex,
  loadProjectWiki,
  memoryPath,
  rulesPath,
  saveProjectIndex,
  saveProjectWiki
} from "./core/persistence.js";
import { exportProjectMap, reviewMemories } from "./core/review.js";
import { estimateTokens, tokenize } from "./core/token.js";
import type { ProjectIndex, RankedSqlObject } from "./core/types.js";
import { buildProjectWiki } from "./core/wiki.js";

const architectureRuleTypeSchema = z.enum([
  "forbidden-import",
  "required-import",
  "dependency-direction",
  "naming-convention",
  "required-test",
  "security",
  "rls",
  "tenant-isolation",
  "audit-logging",
  "release-packaging"
]);

const memoryTypeSchema = z.enum(["architecture", "convention", "bug", "migration", "product", "security", "lesson"]);
const memoryConfidenceSchema = z.enum(["low", "medium", "high"]);
const tokenSavingProfileSchema = z.enum(["conservative", "balanced", "aggressive"]);
const contextCompressionKindSchema = z.enum(["prompt", "memory", "diff", "sql", "wiki", "mixed"]);
const architectureRuleSeveritySchema = z.enum(["info", "warning", "error"]);
const architectureRuleFields = {
  type: architectureRuleTypeSchema,
  name: z.string().min(3),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  severity: architectureRuleSeveritySchema.optional(),
  fromPattern: z.string().optional(),
  targetPattern: z.string().optional(),
  allowedTargetPattern: z.string().optional(),
  modulePattern: z.string().optional(),
  testPattern: z.string().optional(),
  namePattern: z.string().optional(),
  sqlPattern: z.string().optional(),
  message: z.string().optional()
};

function ownPluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function isPluginRoot(root: string): Promise<boolean> {
  try {
    const [realRoot, realSelf] = await Promise.all([realpath(root), realpath(ownPluginRoot())]);
    if (realRoot !== realSelf) return false;
    const hasManifest = await Promise.any([
      access(join(root, ".codex-plugin", "plugin.json")),
      access(join(root, ".claude-plugin", "plugin.json"))
    ]).then(() => true, () => false);
    const hasMcpConfig = await Promise.any([
      access(join(root, ".mcp.json")),
      access(join(root, ".mcp.claude.json"))
    ]).then(() => true, () => false);
    return hasManifest && hasMcpConfig;
  } catch {
    return false;
  }
}

type TrustedWorkspaceProvider = () => Promise<string | undefined>;

async function resolveTrustedWorkspace(server: McpServer): Promise<string | undefined> {
  const configured = process.env.CLAUDE_PROJECT_DIR?.trim() || process.env.TOKENGRAPH_WORKSPACE_ROOT?.trim();
  if (configured) return configured;

  try {
    const roots = await server.server.listRoots({}, { timeout: 1_000 });
    const fileRoot = roots.roots.find((root) => root.uri.startsWith("file://"));
    return fileRoot ? fileURLToPath(fileRoot.uri) : undefined;
  } catch {
    return undefined;
  }
}

function createWorkspaceResolver(server: McpServer, provider?: TrustedWorkspaceProvider) {
  return async (inputRoot?: string): Promise<string> => {
    const cwd = await realpath(process.cwd());
    const configured = await (provider?.() ?? resolveTrustedWorkspace(server));
    const allowedRoot = configured
      ? await realpath(configured)
      : await isPluginRoot(cwd)
        ? undefined
        : cwd;
    if (!allowedRoot) {
      throw new Error("TokenGraph needs a trusted workspace root from the host before it can access project files.");
    }

    const home = await realpath(homedir());
    if (allowedRoot === parse(allowedRoot).root || allowedRoot === home) {
      throw new Error("TokenGraph refuses filesystem and home directories as workspace roots.");
    }

    const requested = inputRoot?.trim() ? resolve(allowedRoot, inputRoot.trim()) : allowedRoot;
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(requested);
    } catch {
      throw new Error(`Requested workspace root does not exist or is not readable: ${requested}`);
    }
    const relativeToAllowed = relative(allowedRoot, resolvedRoot);
    if (relativeToAllowed && (relativeToAllowed.startsWith("..") || isAbsolute(relativeToAllowed))) {
      throw new Error(`Requested root is outside the trusted workspace: ${resolvedRoot}`);
    }
    return resolvedRoot;
  };
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function ok<T extends object>(output: T) {
  return {
    content: [{ type: "text" as const, text: compactJson(output) }],
    structuredContent: output
  };
}

function okWithResourceLinks<T extends { resourceLinks?: Array<{ label: string; uri: string; mimeType: string }> }>(output: T) {
  return {
    content: [
      { type: "text" as const, text: compactJson(output) },
      ...(output.resourceLinks ?? []).map((link) => ({
        type: "resource_link" as const,
        uri: link.uri,
        name: link.label,
        description: link.label,
        mimeType: link.mimeType
      }))
    ],
    structuredContent: output
  };
}

const projectWriteChains = new Map<string, Promise<void>>();

async function enqueueProjectWrite<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = projectWriteChains.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  projectWriteChains.set(
    key,
    current.then(
      () => undefined,
      () => undefined
    )
  );
  return current;
}

async function ensureProject(root: string): Promise<ProjectIndex> {
  return enqueueProjectWrite(root, async () => {
    const currentScanSignature = await scanProjectSignature(root);
    const existing = await loadProjectIndex(root);
    if (existing && isSafeProjectIndex(root, existing)) {
      if (existing.scanSignature === currentScanSignature) {
        return existing;
      }
      const updated = await updateProjectIndexIncremental(root, existing);
      const current = updated.index;
      if (isFreshProjectIndex(existing, current)) {
        await saveProjectIndex(root, current);
        return current;
      }
      await saveProjectIndex(root, current);
      return current;
    }
    const indexed = await indexProject(root, { scanSignature: currentScanSignature });
    await saveProjectIndex(root, indexed);
    return indexed;
  });
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const segments = path.split(/[\\/]+/);
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function isSafeProjectIndex(root: string, project: ProjectIndex): boolean {
  if (project.root !== root) return false;
  const paths = [
    ...project.files.map((file) => file.path),
    ...project.symbols.map((symbol) => symbol.filePath),
    ...project.imports.flatMap((edge) => [edge.filePath, edge.resolvedPath].filter((path): path is string => Boolean(path))),
    ...project.sql.tables.map((item) => item.filePath),
    ...project.sql.relations.map((item) => item.filePath),
    ...project.sql.constraints.map((item) => item.filePath),
    ...project.sql.policies.map((item) => item.filePath),
    ...project.sql.indexes.map((item) => item.filePath),
    ...project.sql.triggers.map((item) => item.filePath),
    ...project.sql.functions.map((item) => item.filePath),
    ...project.sql.views.map((item) => item.filePath),
    ...project.sql.enums.map((item) => item.filePath),
    ...project.sql.extensions.map((item) => item.filePath),
    ...project.sql.grants.map((item) => item.filePath),
    ...project.sql.materializedViews.map((item) => item.filePath),
    ...project.sql.history.map((item) => item.filePath)
  ];
  return paths.every(isSafeRelativePath);
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
      constraints: project.sql.constraints.length,
      enums: project.sql.enums.length,
      extensions: project.sql.extensions.length,
      grants: project.sql.grants.length,
      materializedViews: project.sql.materializedViews.length,
      memories: 0
    },
    modules: project.files
      .filter((file) => !file.isTest && file.kind !== "sql")
      .slice(0, 20)
      .map((file) => ({ path: file.path, kind: file.kind, route: file.route })),
    database: {
      tables: project.sql.tables.map((table) => ({ name: table.name, columns: table.columns.length })),
      policies: project.sql.policies.map((policy) => ({ name: policy.name, table: policy.table, command: policy.command })),
      constraints: project.sql.constraints.map((constraint) => ({ name: constraint.name, table: constraint.table, kind: constraint.kind })),
      enums: project.sql.enums.map((enumObject) => ({ name: enumObject.name, values: enumObject.values.length })),
      extensions: project.sql.extensions.map((extension) => ({ name: extension.name })),
      materializedViews: project.sql.materializedViews.map((view) => ({ name: view.name })),
      warnings: project.sql.warnings
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
  const v05SqlRows = [
    ...project.sql.policies.map((policy) => ({
      kind: "sql_policy",
      name: policy.name,
      path: policy.filePath,
      score: score(`${policy.name} ${policy.table} ${policy.command ?? ""} ${policy.roles?.join(" ") ?? ""} ${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`)
    })),
    ...project.sql.constraints.map((constraint) => ({
      kind: "sql_constraint",
      name: constraint.name,
      path: constraint.filePath,
      score: score(`${constraint.name} ${constraint.table} ${constraint.kind} ${constraint.columns?.join(" ") ?? ""} ${constraint.expression ?? ""}`)
    })),
    ...project.sql.enums.map((enumObject) => ({
      kind: "sql_enum",
      name: enumObject.name,
      path: enumObject.filePath,
      score: score(`${enumObject.name} ${enumObject.values.join(" ")}`)
    })),
    ...project.sql.extensions.map((extension) => ({
      kind: "sql_extension",
      name: extension.name,
      path: extension.filePath,
      score: score(extension.name)
    })),
    ...project.sql.materializedViews.map((view) => ({
      kind: "sql_materialized_view",
      name: view.name,
      path: view.filePath,
      score: score(view.name)
    }))
  ];
  return [...fileRows, ...symbolRows, ...sqlRows, ...v05SqlRows]
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function explain(project: ProjectIndex, target: string) {
  const file = project.files.find((candidate) => candidate.path === target);
  const symbols = project.symbols.filter((symbol) => symbol.filePath === target || symbol.name === target);
  const targetPaths = new Set([file?.path, ...symbols.map((symbol) => symbol.filePath)].filter((path): path is string => Boolean(path)));
  const outboundReferences = project.imports.filter((edge) => targetPaths.has(edge.filePath));
  const inboundReferences = project.imports.filter((edge) => edge.resolvedPath !== undefined && targetPaths.has(edge.resolvedPath));
  return {
    target,
    file,
    symbols,
    imports: outboundReferences,
    inboundReferences,
    outboundReferences,
    explanation: file
      ? `${target} is indexed as ${file.kind}${file.route ? ` for route ${file.route}` : ""}.`
      : symbols.length
        ? `${target} is a symbol in ${symbols.map((symbol) => symbol.filePath).join(", ")} with ${inboundReferences.length} inbound reference(s).`
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
      reason: `Policy on ${policy.table}${policy.command ? ` for ${policy.command}` : ""}`,
      score: score(`${policy.name} ${policy.table} ${policy.command ?? ""} ${policy.roles?.join(" ") ?? ""} ${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`)
    })),
    ...project.sql.constraints.map((constraint) => ({
      kind: "constraint" as const,
      name: constraint.name,
      filePath: constraint.filePath,
      reason: `${constraint.kind} constraint on ${constraint.table}`,
      score: score(`${constraint.name} ${constraint.table} ${constraint.kind} ${constraint.columns?.join(" ") ?? ""} ${constraint.expression ?? ""}`)
    })),
    ...project.sql.enums.map((enumObject) => ({
      kind: "enum" as const,
      name: enumObject.name,
      filePath: enumObject.filePath,
      reason: `Enum values: ${enumObject.values.join(", ")}`,
      score: score(`${enumObject.name} ${enumObject.values.join(" ")}`)
    })),
    ...project.sql.extensions.map((extension) => ({
      kind: "extension" as const,
      name: extension.name,
      filePath: extension.filePath,
      reason: "PostgreSQL extension",
      score: score(extension.name)
    })),
    ...project.sql.grants.map((grant) => ({
      kind: "grant" as const,
      name: `${grant.objectName} to ${grant.grantee}`,
      filePath: grant.filePath,
      reason: `Grant ${grant.privileges.join(", ")} to ${grant.grantee}`,
      score: score(`${grant.objectName} ${grant.grantee} ${grant.privileges.join(" ")} ${grant.objectType ?? ""}`)
    })),
    ...project.sql.materializedViews.map((view) => ({
      kind: "materializedView" as const,
      name: view.name,
      filePath: view.filePath,
      reason: "Materialized view",
      score: score(view.name)
    }))
  ];
  return rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function createTokenGraphServer(options: { trustedWorkspace?: TrustedWorkspaceProvider } = {}): McpServer {
  const server = new McpServer({ name: "tokengraph", version: "0.18.0" });
  const workspaceRoot = createWorkspaceResolver(server, options.trustedWorkspace);

  server.registerTool(
    "tokengraph_index_project",
    {
      title: "Index Project",
      description: "Use this when the coding agent needs a compact local project map before reading raw files.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root to index. Defaults to the MCP server current working directory."),
        fullReindex: z.boolean().optional().describe("Force a complete rebuild instead of using compatible incremental index data.")
      })
    },
    async ({ root, fullReindex }) => {
      const resolvedRoot = await workspaceRoot(root);
      const existing = fullReindex ? undefined : await loadProjectIndex(resolvedRoot);
      const result = existing && isSafeProjectIndex(resolvedRoot, existing)
        ? await updateProjectIndexIncremental(resolvedRoot, existing)
        : {
            index: await indexProject(resolvedRoot),
            mode: "full" as const,
            addedFiles: [],
            changedFiles: [],
            deletedFiles: [],
            parsedFiles: []
          };
      const project = result.index;
      await saveProjectIndex(resolvedRoot, project);
      const config = await loadTokenGraphConfig(resolvedRoot);
      let wikiRefreshed = false;
      let wikiWarning: string | undefined;
      if (config.wikiGenerationEnabled) {
        try {
          const memories = await new MemoryStore(memoryPath(resolvedRoot)).list();
          await saveProjectWiki(resolvedRoot, buildProjectWiki(project, memories));
          wikiRefreshed = true;
        } catch (error) {
          wikiWarning = `Wiki refresh failed: ${(error as Error).message}`;
        }
      }
      return ok({
        status: "indexed",
        indexingMode: fullReindex ? "full" : result.mode,
        wikiRefreshed,
        ...(wikiWarning ? { wikiWarning } : {}),
        changes: {
          addedFiles: result.addedFiles,
          changedFiles: result.changedFiles,
          deletedFiles: result.deletedFiles,
          parsedFiles: result.parsedFiles
        },
        map: projectMap(project),
        exclusions: project.exclusions.slice(0, 25)
      });
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
    async ({ root }) => ok(await getIndexStatus(await workspaceRoot(root)))
  );

  server.registerTool(
    "tokengraph_reset_project",
    {
      title: "Reset Project State",
      description: "Use this to clear TokenGraph local state. The default mode clears the persisted index and derived wiki while preserving memories.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root to reset. Defaults to the MCP server current working directory."),
        mode: z.enum(["index", "all"]).default("index").describe("index clears index.json and derived wiki pages; all clears the full .tokengraph state directory.")
      })
    },
    async ({ root, mode }) => {
      const resolvedRoot = await workspaceRoot(root);
      if (mode === "all") {
        await clearProjectState(resolvedRoot);
      } else {
        await clearProjectIndex(resolvedRoot);
      }
      return ok({ status: "reset", mode, root: resolvedRoot });
    }
  );

  server.registerTool(
    "tokengraph_get_config",
    {
      title: "Get TokenGraph Config",
      description: "Use this to read local TokenGraph settings from .tokengraph/config.json.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory.")
      })
    },
    async ({ root }) => ok(await loadTokenGraphConfig(await workspaceRoot(root)))
  );

  server.registerTool(
    "tokengraph_set_profile",
    {
      title: "Set Token Saving Profile",
      description: "Use this to switch the active local token-saving profile.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        profile: z.enum(["conservative", "balanced", "aggressive"])
      })
    },
    async ({ root, profile }) => ok({ status: "updated", config: await setTokenSavingProfile(await workspaceRoot(root), profile) })
  );

  server.registerTool(
    "tokengraph_update_config",
    {
      title: "Update TokenGraph Config",
      description: "Use this to update explicit local TokenGraph settings while preserving unspecified defaults.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        tokenSavingProfile: z.enum(["conservative", "balanced", "aggressive"]).optional(),
        maxFiles: z.number().int().min(1).max(50).optional(),
        maxSqlObjects: z.number().int().min(0).max(50).optional(),
        maxMemories: z.number().int().min(0).max(50).optional(),
        maxPlannedContextTokens: z.number().int().min(1).optional(),
        rawReadWarningThreshold: z.number().int().min(1).optional(),
        sqlIndexingEnabled: z.boolean().optional(),
        memoryEnabled: z.boolean().optional(),
        wikiGenerationEnabled: z.boolean().optional()
      })
    },
    async ({ root, ...update }) => ok({ status: "updated", config: await updateTokenGraphConfig(await workspaceRoot(root), update) })
  );

  server.registerTool(
    "tokengraph_list_rules",
    {
      title: "List Architecture Rules",
      description: "Use this to list local TokenGraph architecture rules from .tokengraph/rules.json.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory.")
      })
    },
    async ({ root }) => {
      const resolvedRoot = await workspaceRoot(root);
      return ok({ root: resolvedRoot, rules: await new ArchitectureRuleStore(rulesPath(resolvedRoot)).list() });
    }
  );

  server.registerTool(
    "tokengraph_add_rule",
    {
      title: "Add Architecture Rule",
      description: "Use this to add a local architecture rule to .tokengraph/rules.json.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory."),
        ...architectureRuleFields
      })
    },
    async ({ root, ...input }) => {
      const resolvedRoot = await workspaceRoot(root);
      const rule = await new ArchitectureRuleStore(rulesPath(resolvedRoot)).add(input);
      return ok({ status: "added", root: resolvedRoot, rule });
    }
  );

  server.registerTool(
    "tokengraph_update_rule",
    {
      title: "Update Architecture Rule",
      description: "Use this to update a local architecture rule in .tokengraph/rules.json.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory."),
        id: z.string().min(1),
        type: architectureRuleTypeSchema.optional(),
        name: z.string().min(3).optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        severity: architectureRuleSeveritySchema.optional(),
        fromPattern: z.string().optional(),
        targetPattern: z.string().optional(),
        allowedTargetPattern: z.string().optional(),
        modulePattern: z.string().optional(),
        testPattern: z.string().optional(),
        namePattern: z.string().optional(),
        sqlPattern: z.string().optional(),
        message: z.string().optional()
      })
    },
    async ({ root, id, ...update }) => {
      const resolvedRoot = await workspaceRoot(root);
      const rule = await new ArchitectureRuleStore(rulesPath(resolvedRoot)).update(id, update);
      if (!rule) {
        throw new Error(`No architecture rule found for id ${id}.`);
      }
      return ok({ status: "updated", root: resolvedRoot, rule });
    }
  );

  server.registerTool(
    "tokengraph_delete_rule",
    {
      title: "Delete Architecture Rule",
      description: "Use this to delete a local architecture rule from .tokengraph/rules.json.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory."),
        id: z.string().min(1)
      })
    },
    async ({ root, id }) => {
      const resolvedRoot = await workspaceRoot(root);
      const deleted = await new ArchitectureRuleStore(rulesPath(resolvedRoot)).delete(id);
      if (!deleted) {
        throw new Error(`No architecture rule found for id ${id}.`);
      }
      return ok({ status: "deleted", root: resolvedRoot, id });
    }
  );

  server.registerTool(
    "tokengraph_check_architecture",
    {
      title: "Check Architecture",
      description: "Use this to check imports, selected module tests, SQL security warnings, and marketplace target sanity against local architecture rules.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory."),
        files: z.array(z.string()).optional().describe("Optional selected module paths for required-test checks.")
      })
    },
    async ({ root, files }) => {
      const resolvedRoot = await workspaceRoot(root);
      const project = await ensureProject(resolvedRoot);
      const rules = await new ArchitectureRuleStore(rulesPath(resolvedRoot)).list();
      return ok(await checkArchitecture({ root: resolvedRoot, project, rules, files }));
    }
  );

  server.registerTool(
    "tokengraph_trace_failure",
    {
      title: "Trace Failure",
      description: "Use this to compress failure output and route debugging through graph-related files, imports, SQL, memories, hypotheses, and first reads.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory."),
        kind: z.enum(["test", "build", "runtime", "install", "log"]),
        text: z.string().min(1),
        task: z.string().optional(),
        profile: z.enum(["conservative", "balanced", "aggressive"]).optional()
      })
    },
    async ({ root, kind, text, task, profile }) => {
      const resolvedRoot = await workspaceRoot(root);
      const project = await ensureProject(resolvedRoot);
      const memories = await new MemoryStore(memoryPath(resolvedRoot)).search(`${task ?? ""}\n${text}`, 8);
      return ok(await traceFailure({ root: resolvedRoot, kind, text, task, profile, project, memories }));
    }
  );

  server.registerTool(
    "tokengraph_assess_change_risk",
    {
      title: "Assess Change Risk",
      description: "Use this to estimate regression risk for changed files using graph, routes, tests, SQL, architecture rules, memories, and targeted test recommendations.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root. Defaults to the MCP server current working directory."),
        changedFiles: z.array(z.string().min(1)).min(1),
        diffSummary: z.string().optional(),
        task: z.string().optional(),
        profile: z.enum(["conservative", "balanced", "aggressive"]).optional()
      })
    },
    async ({ root, changedFiles, diffSummary, task, profile }) => {
      const resolvedRoot = await workspaceRoot(root);
      const project = await ensureProject(resolvedRoot);
      const rules = await new ArchitectureRuleStore(rulesPath(resolvedRoot)).list();
      const memories = await new MemoryStore(memoryPath(resolvedRoot)).search(`${task ?? ""}\n${diffSummary ?? ""}\n${changedFiles.join("\n")}`, 8);
      return ok(await assessChangeRisk({ root: resolvedRoot, changedFiles, diffSummary, task, profile, project, rules, memories }));
    }
  );

  server.registerTool(
    "tokengraph_project_map",
    {
      title: "Show Project Map",
      description: "Use this when the coding agent needs a compact overview of indexed modules, symbols, SQL objects, and freshness.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional() })
    },
    async ({ root }) => {
      const resolvedRoot = await workspaceRoot(root);
      const project = await ensureProject(resolvedRoot);
      const memories = await new MemoryStore(memoryPath(resolvedRoot)).list();
      const map = projectMap(project);
      map.counts.memories = memories.length;
      return ok(map);
    }
  );

  server.registerTool(
    "tokengraph_generate_wiki",
    {
      title: "Generate Project Wiki",
      description:
        "Use this to generate compact local wiki pages from the persisted TokenGraph index and memory records. Explicit generation works regardless of wikiGenerationEnabled; that flag only controls automatic refresh after indexing.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root whose persisted index should be used. Defaults to the MCP server current working directory.")
      })
    },
    async ({ root }) => {
      const resolvedRoot = await workspaceRoot(root);
      const project = await loadProjectIndex(resolvedRoot);
      if (!project || !isSafeProjectIndex(resolvedRoot, project)) {
        throw new Error("No safe persisted TokenGraph index was found. Run tokengraph_index_project before tokengraph_generate_wiki.");
      }
      const memories = await new MemoryStore(memoryPath(resolvedRoot)).list();
      const wiki = buildProjectWiki(project, memories);
      await saveProjectWiki(resolvedRoot, wiki);
      return ok({
        status: "generated",
        root: resolvedRoot,
        wikiStatus: await getWikiStatus(resolvedRoot),
        pages: wiki.pages.map((page) => ({ slug: page.slug, title: page.title, estimatedTokens: page.estimatedTokens }))
      });
    }
  );

  server.registerTool(
    "tokengraph_show_wiki_page",
    {
      title: "Show Wiki Page",
      description:
        "Use this to read a generated local wiki page before opening raw files. Explicit reads work regardless of wikiGenerationEnabled; that flag only controls automatic refresh after indexing.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional().describe("Workspace root whose generated wiki should be read. Defaults to the MCP server current working directory."),
        slug: z.string().min(1).describe("Wiki page slug to read, such as overview, structure, routes, database, or decisions.")
      })
    },
    async ({ root, slug }) => {
      const resolvedRoot = await workspaceRoot(root);
      const wiki = await loadProjectWiki(resolvedRoot);
      if (!wiki) {
        throw new Error("No generated TokenGraph wiki was found. Run tokengraph_generate_wiki first.");
      }
      const page = wiki.pages.find((candidate) => candidate.slug === slug);
      if (!page) {
        throw new Error(`Unknown wiki page slug "${slug}". Available slugs: ${wiki.pages.map((candidate) => candidate.slug).join(", ") || "none"}.`);
      }
      return ok({
        slug: page.slug,
        title: page.title,
        body: page.body,
        estimatedTokens: page.estimatedTokens,
        wikiStatus: await getWikiStatus(resolvedRoot)
      });
    }
  );

  server.registerTool(
    "tokengraph_plan_context",
    {
      title: "Plan Context",
      description: "Use this before raw file exploration to get the smallest likely files, SQL objects, tests, and memories for a task.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        task: z.string().min(3).describe("The coding task or question to route."),
        profile: z.enum(["conservative", "balanced", "aggressive"]).optional(),
        maxFiles: z.number().int().min(1).max(20).optional(),
        maxSqlObjects: z.number().int().min(0).max(20).optional(),
        maxMemories: z.number().int().min(0).max(20).optional(),
        maxEstimatedTokens: z.number().int().min(1).optional(),
        allowRawReads: z.boolean().optional()
      })
    },
    async ({ root, task, profile, maxFiles, maxSqlObjects, maxMemories, maxEstimatedTokens, allowRawReads }) => {
      const resolvedRoot = await workspaceRoot(root);
      const config = await loadTokenGraphConfig(resolvedRoot);
      const project = await ensureProject(resolvedRoot);
      const memory = new MemoryStore(memoryPath(resolvedRoot));
      const memories = config.memoryEnabled ? await memory.search(task, maxMemories ?? 20) : [];
      const plan = await buildContextPlan({
        root: resolvedRoot,
        task,
        project,
        memories,
        budget: {
          profile: profile ?? config.tokenSavingProfile,
          maxFiles,
          maxSqlObjects,
          maxMemories,
          maxEstimatedTokens,
          rawReadWarningThreshold: undefined,
          allowRawReads
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        query: z.string().min(2),
        limit: z.number().int().min(1).max(50).optional()
      })
    },
    async ({ root, query, limit }) => {
      const project = await ensureProject(await workspaceRoot(root));
      return ok({ query, results: searchProject(project, query, limit ?? 10) });
    }
  );

  server.registerTool(
    "tokengraph_explain_symbol",
    {
      title: "Explain Symbol",
      description: "Use this when the coding agent needs to know why a file or symbol is relevant before reading it.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional(), target: z.string().min(1) })
    },
    async ({ root, target }) => {
      const project = await ensureProject(await workspaceRoot(root));
      return ok(explain(project, target));
    }
  );

  server.registerTool(
    "tokengraph_summarize_sql",
    {
      title: "Summarize SQL",
      description: "Use this when a task touches data, auth, reports, RLS, migrations, or persistence.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional(), query: z.string().min(2), limit: z.number().int().min(1).max(50).optional() })
    },
    async ({ root, query, limit }) => {
      const project = await ensureProject(await workspaceRoot(root));
      return ok({ query, sql: sqlSummary(project, query, limit ?? 10) });
    }
  );

  server.registerTool(
    "tokengraph_compress_output",
    {
      title: "Compress Output",
      description: "Use this to compress test, build, install, diff, or log output before the coding agent reads a long raw output.",
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
    "tokengraph_compress_context",
    {
      title: "Compress Context",
      description:
        "Use this to compress prompts, memories, diffs, SQL, wiki text, logs, or mixed context while preserving exact implementation-critical references and first-read recommendations.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        task: z.string().min(1),
        contentKind: contextCompressionKindSchema,
        text: z.string().optional(),
        profile: tokenSavingProfileSchema.optional(),
        preserveRawReferences: z.boolean().optional()
      })
    },
    async ({ root, task, contentKind, text, profile, preserveRawReferences }) => {
      const resolvedRoot = await workspaceRoot(root);
      const [project, config, wiki] = await Promise.all([ensureProject(resolvedRoot), loadTokenGraphConfig(resolvedRoot), loadProjectWiki(resolvedRoot)]);
      const memoryQuery = [task, text ?? ""].join("\n");
      const memories = config.memoryEnabled ? await new MemoryStore(memoryPath(resolvedRoot)).search(memoryQuery, config.maxMemories) : [];
      return ok(
        await compressContext({
          root: resolvedRoot,
          task,
          contentKind,
          text,
          profile: profile ?? config.tokenSavingProfile,
          preserveRawReferences,
          project,
          memories,
          wiki
        })
      );
    }
  );

  server.registerTool(
    "tokengraph_remember_decision",
    {
      title: "Remember Decision",
      description: "Use this only when the user or task outcome provides a durable project decision worth recalling later.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        type: memoryTypeSchema,
        title: z.string().min(3),
        body: z.string().min(3),
        tags: z.array(z.string()).default([]),
        confidence: memoryConfidenceSchema.optional(),
        source: z.string().optional(),
        evidence: z.array(z.string()).optional(),
        linkedFiles: z.array(z.string()).optional(),
        linkedSymbols: z.array(z.string()).optional(),
        linkedSqlObjects: z.array(z.string()).optional(),
        linkedRules: z.array(z.string()).optional(),
        supersedes: z.array(z.string()).optional(),
        importance: z.enum(["normal", "important"]).optional(),
        approved: z.boolean().optional()
      })
    },
    async ({ root, type, title, body, tags, confidence, source, evidence, linkedFiles, linkedSymbols, linkedSqlObjects, linkedRules, supersedes, importance, approved }) => {
      if (importance === "important" && approved !== true) {
        throw new Error("Important durable memories require explicit approval. Retry with approved: true only when the user requested or approved storing it.");
      }
      const resolvedRoot = await workspaceRoot(root);
      const entry = await new MemoryStore(memoryPath(resolvedRoot)).add({
        type,
        title,
        body,
        tags,
        confidence,
        source,
        evidence,
        linkedFiles,
        linkedSymbols,
        linkedSqlObjects,
        linkedRules,
        supersedes
      });
      return ok({ status: "remembered", memory: entry });
    }
  );

  server.registerTool(
    "tokengraph_update_memory",
    {
      title: "Update Memory",
      description: "Use this to update a local memory's text, tags, confidence, links, source, or evidence without deleting history.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        id: z.string().min(1),
        type: memoryTypeSchema.optional(),
        title: z.string().min(3).optional(),
        body: z.string().min(3).optional(),
        tags: z.array(z.string()).optional(),
        confidence: memoryConfidenceSchema.optional(),
        source: z.string().optional(),
        evidence: z.array(z.string()).optional(),
        linkedFiles: z.array(z.string()).optional(),
        linkedSymbols: z.array(z.string()).optional(),
        linkedSqlObjects: z.array(z.string()).optional(),
        linkedRules: z.array(z.string()).optional(),
        supersedes: z.array(z.string()).optional(),
        supersededBy: z.array(z.string()).optional()
      })
    },
    async ({ root, id, ...update }) => {
      const resolvedRoot = await workspaceRoot(root);
      const memory = await new MemoryStore(memoryPath(resolvedRoot)).update(id, update);
      if (!memory) {
        throw new Error(`No memory found for id ${id}.`);
      }
      return ok({ status: "updated", root: resolvedRoot, memory });
    }
  );

  server.registerTool(
    "tokengraph_delete_memory",
    {
      title: "Delete Memory",
      description: "Use this to soft-delete a memory by default. Deleted memories are hidden from normal recall and visible only in audit mode.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        id: z.string().min(1),
        hard: z.boolean().optional()
      })
    },
    async ({ root, id, hard }) => {
      const resolvedRoot = await workspaceRoot(root);
      const deleted = await new MemoryStore(memoryPath(resolvedRoot)).delete(id, { hard: hard === true });
      if (!deleted) {
        throw new Error(`No memory found for id ${id}.`);
      }
      return ok({ status: "deleted", root: resolvedRoot, id, hard: hard === true });
    }
  );

  server.registerTool(
    "tokengraph_deprecate_memory",
    {
      title: "Deprecate Memory",
      description: "Use this to mark a memory stale without deleting it. Deprecated memories are excluded from normal planning and recall.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        id: z.string().min(1),
        supersededBy: z.array(z.string()).optional(),
        evidence: z.array(z.string()).optional()
      })
    },
    async ({ root, id, supersededBy, evidence }) => {
      const resolvedRoot = await workspaceRoot(root);
      const memory = await new MemoryStore(memoryPath(resolvedRoot)).deprecate(id, supersededBy ?? [], evidence ?? []);
      if (!memory) {
        throw new Error(`No memory found for id ${id}.`);
      }
      return ok({ status: "deprecated", root: resolvedRoot, memory });
    }
  );

  server.registerTool(
    "tokengraph_confirm_memory",
    {
      title: "Confirm Memory",
      description: "Use this to mark a memory as confirmed with evidence and raise or set confidence.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        id: z.string().min(1),
        evidence: z.array(z.string()).optional(),
        confidence: memoryConfidenceSchema.optional()
      })
    },
    async ({ root, id, evidence, confidence }) => {
      const resolvedRoot = await workspaceRoot(root);
      const memory = await new MemoryStore(memoryPath(resolvedRoot)).confirm(id, evidence ?? [], confidence ?? "high");
      if (!memory) {
        throw new Error(`No memory found for id ${id}.`);
      }
      return ok({ status: "confirmed", root: resolvedRoot, memory });
    }
  );

  server.registerTool(
    "tokengraph_find_memory_conflicts",
    {
      title: "Find Memory Conflicts",
      description: "Use this to surface potentially conflicting active memories. It never resolves or edits conflicts automatically.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        id: z.string().optional(),
        query: z.string().optional(),
        candidate: z
          .object({
            type: memoryTypeSchema,
            title: z.string().min(3),
            body: z.string().min(3),
            tags: z.array(z.string()).default([])
          })
          .optional(),
        limit: z.number().int().min(1).max(50).optional()
      })
    },
    async ({ root, id, query, candidate, limit }) => {
      const resolvedRoot = await workspaceRoot(root);
      const conflicts = await new MemoryStore(memoryPath(resolvedRoot)).findConflicts({ id, query, candidate, limit });
      return ok({
        root: resolvedRoot,
        conflicts,
        policy: "Memory conflicts are surfaced for review and not automatically resolved."
      });
    }
  );

  server.registerTool(
    "tokengraph_link_memory",
    {
      title: "Link Memory",
      description: "Use this to link a memory to files, symbols, SQL objects, architecture rules, source, and evidence.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        id: z.string().min(1),
        linkedFiles: z.array(z.string()).optional(),
        linkedSymbols: z.array(z.string()).optional(),
        linkedSqlObjects: z.array(z.string()).optional(),
        linkedRules: z.array(z.string()).optional(),
        evidence: z.array(z.string()).optional(),
        source: z.string().optional()
      })
    },
    async ({ root, id, ...links }) => {
      const resolvedRoot = await workspaceRoot(root);
      const memory = await new MemoryStore(memoryPath(resolvedRoot)).link(id, links);
      if (!memory) {
        throw new Error(`No memory found for id ${id}.`);
      }
      return ok({ status: "linked", root: resolvedRoot, memory });
    }
  );

  server.registerTool(
    "tokengraph_recall_memory",
    {
      title: "Recall Memory",
      description: "Use this to retrieve relevant active memories. Audit mode is required to include deprecated or deleted memories.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        auditMode: z.boolean().optional()
      })
    },
    async ({ root, query, limit, auditMode }) => {
      const resolvedRoot = await workspaceRoot(root);
      const recall = await new MemoryStore(memoryPath(resolvedRoot)).recall(query ?? "", { limit, auditMode: auditMode === true });
      return ok({ root: resolvedRoot, ...recall });
    }
  );

  server.registerTool(
    "tokengraph_review_memories",
    {
      title: "Review Memories",
      description: "Use this to review local TokenGraph memories before relying on them. This is read-only and never edits memory state.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        query: z.string().optional().describe("Optional review focus. Empty query returns recent memories for manual review."),
        limit: z.number().int().min(1).max(100).optional()
      })
    },
    async ({ root, query, limit }) => {
      const resolvedRoot = await workspaceRoot(root);
      const memories = await new MemoryStore(memoryPath(resolvedRoot)).list();
      return ok(await reviewMemories({ memories, query: query ?? "", limit: limit ?? 20 }));
    }
  );

  server.registerTool(
    "tokengraph_export_project_map",
    {
      title: "Export Project Map",
      description: "Use this to export a compact visual project map without raw source content.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        root: z.string().optional(),
        format: z.enum(["mermaid", "json"]).default("mermaid"),
        limit: z.number().int().min(1).max(200).optional()
      })
    },
    async ({ root, format, limit }) => {
      const project = await ensureProject(await workspaceRoot(root));
      return okWithResourceLinks(exportProjectMap(project, { format, limit: limit ?? 50 }));
    }
  );

  server.registerTool(
    "tokengraph_show_token_savings",
    {
      title: "Show Token Savings",
      description: "Use this to estimate how many tokens TokenGraph avoided by using the compact local index.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional() })
    },
    async ({ root }) => {
      const project = await ensureProject(await workspaceRoot(root));
      const original = project.files.reduce((total, file) => total + file.estimatedTokens, 0);
      const compact = estimateTokens(compactJson(projectMap(project)));
      return ok({ original, compact, avoided: Math.max(0, original - compact), unit: "estimated tokens" });
    }
  );

  return server;
}
