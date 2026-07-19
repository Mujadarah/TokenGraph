import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { ArchitectureRuleStore, checkArchitecture } from "./core/architectureRules.js";
import { artifactKey, createStableArtifact, loadStableArtifact, saveStableArtifact, shouldSuppressArtifact, type RoutingDecision } from "./core/artifact.js";
import { buildAdaptiveProjectBrief, composeMemoryContext } from "./core/memoryCore.js";
import { compressContext } from "./core/contextCompressor.js";
import { compressOutput } from "./core/compressor.js";
import {
  compactCompressionResponse,
  compactFailureResponse,
  hasSqlIntent,
  compactMemoryRecallResponse,
  compactPlanResponse,
  compactRecallResponse,
  compactRiskResponse,
  compactSliceResponse,
  compactWikiResponse
} from "./core/compactResponses.js";
import {
  analyzeInputSchema,
  compactCompressionEnvelope,
  compactModeEnvelope,
  compactPrepareEnvelope,
  compactToolResultEnvelope,
  compressInputSchema,
  prepareContextInputSchema,
  proposeKnowledgeInputSchema,
  queryContextInputSchema,
  recallInputSchema,
  taskReportInputSchema
} from "./core/toolContracts.js";
import { loadTokenGraphConfig, setTokenSavingProfile, updateTokenGraphConfig } from "./core/config.js";
import { adviseRouting, failOpenRouting } from "./core/routingAdvisor.js";
import { isValidatedPromotion, loadRoutingControl } from "./core/routingControl.js";
import { getRepositoryIdentity, getRepositorySetupWarnings } from "./core/repositoryIdentity.js";
import { buildEvidenceBackedSliceRecommendation, buildRetrievalCapsule, capsuleArtifact, escalateReadPolicy, rankFilesBm25, readExactSlice, recommendExactRead, startReadPolicyResponse } from "./core/retrieval.js";
import { loadRun, summarizeRun } from "./core/runner.js";
import { assertStorageReplacementAllowed, enforceStorageClassQuotas } from "./core/storagePolicy.js";
import { scanProjectSignature } from "./core/fileScanner.js";
import { getIndexStatus, isFreshProjectIndex } from "./core/indexStatus.js";
import { traceFailure } from "./core/failureTracer.js";
import { MemoryStore } from "./core/memoryStore.js";
import { buildContextPlan } from "./core/planner.js";
import { indexProject, updateProjectIndexIncremental, type ProjectIndexOptions } from "./core/projectIndexer.js";
import { assessChangeRisk } from "./core/regressionRisk.js";
import {
  clearProjectIndex,
  clearProjectState,
  getWikiStatus,
  loadProjectIndex,
  loadProjectWiki,
  repositoryMemoryPath,
  saveVaultProjection,
  repositoryRulesPath,
  saveProjectIndex,
  saveProjectWiki
} from "./core/persistence.js";
import { exportProjectMap, reviewMemories } from "./core/review.js";
import { estimateTokens, tokenize } from "./core/token.js";
import { buildTaskReport, formatTaskReportFooter } from "./core/taskEstimator.js";
import type { ContextPlan, ProjectIndex, RankedSqlObject } from "./core/types.js";
import { buildProjectWiki } from "./core/wiki.js";
import { projectToVault } from "./core/vaultProjection.js";
import { createTaskLedger, discardEmptyTaskLedger, listCompletedTaskOutcomes, loadTaskLedger, recordTaskArtifactDelivery, recordTaskEvent, setTaskDisposition, updateTaskReadPolicy, updateTaskRoutingObservation, type TaskHost } from "./core/taskLedger.js";
import { listAppliedKnowledge, listKnowledgeSuggestions, proposeKnowledgeChange, reviewKnowledgeSuggestion } from "./core/knowledgeReviewQueue.js";

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

const CORE_TOOL_NAMES = [
  "tokengraph_setup",
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
] as const;
type ToolSurface = "core" | "full";

function selectedToolSurface(): ToolSurface {
  const value = process.env.TOKENGRAPH_TOOL_SURFACE;
  if (value === undefined || value === "core") return "core";
  if (value === "full") return "full";
  throw new Error(`Invalid TOKENGRAPH_TOOL_SURFACE value "${process.env.TOKENGRAPH_TOOL_SURFACE}". Valid values are "core" and "full".`);
}

function legacyDescription(description: string | undefined): string {
  return `Legacy compatibility tool; prefer the intent-level core tools. Deprecated surface. ${description ?? ""}`.trim();
}

function taskHost(value: string | undefined): TaskHost {
  if (value === "codex") return "codex";
  if (value === "claude" || value === "claude-code") return "claude";
  return "unknown";
}

function eventFingerprint(taskId: string, toolName: string, category: string, operation: unknown): string {
  return createHash("sha256").update(JSON.stringify({ taskId, toolName, category, operation })).digest("hex");
}

async function recordCoreEvent(input: {
  root: string;
  taskId: string;
  toolName: string;
  category: string;
  operation: unknown;
  originalTokens: number;
  compactTokens: number;
  overheadTokens?: number;
}): Promise<number> {
  const overheadTokens = input.overheadTokens ?? coreEventOverheadTokens(input.taskId, input.toolName, input.category);
  await recordTaskEvent(input.root, input.taskId, {
    id: randomUUID(),
    fingerprint: eventFingerprint(input.taskId, input.toolName, input.category, input.operation),
    category: input.category,
    toolName: input.toolName,
    originalTokens: input.originalTokens,
    compactTokens: input.compactTokens,
    overheadTokens,
    confidence: "low",
    timestamp: new Date().toISOString(),
    qualityChecks: [{ name: "compact-output-produced", passed: true }]
  });
  return overheadTokens;
}

function coreEventOverheadTokens(taskId: string, toolName: string, category: string): number {
  return estimateTokens(compactJson({ taskId, toolName, category }));
}

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
type TrustedWorkspaceSource = "CLAUDE_PROJECT_DIR" | "TOKENGRAPH_WORKSPACE_ROOT" | "mcp-roots" | "process-cwd" | "injected";

interface TrustedWorkspaceCandidate {
  source: TrustedWorkspaceSource;
  root: string;
}

interface WorkspaceSetupStatus {
  status: "ready" | "blocked";
  host: "claude-code" | "codex" | "unknown";
  trustedWorkspace: TrustedWorkspaceCandidate | null;
  blockingReason: "missing-trusted-workspace" | "unsafe-trusted-workspace" | "unreadable-trusted-workspace" | null;
  pluginRootLaunch: boolean;
  message: string;
  nextSteps: string[];
}

async function resolveTrustedWorkspace(server: McpServer): Promise<TrustedWorkspaceCandidate | undefined> {
  const claudeRoot = process.env.CLAUDE_PROJECT_DIR?.trim();
  if (claudeRoot) return { source: "CLAUDE_PROJECT_DIR", root: claudeRoot };
  const codexRoot = process.env.TOKENGRAPH_WORKSPACE_ROOT?.trim();
  if (codexRoot) return { source: "TOKENGRAPH_WORKSPACE_ROOT", root: codexRoot };

  try {
    const roots = await server.server.listRoots({}, { timeout: 1_000 });
    const fileRoot = roots.roots.find((root) => root.uri.startsWith("file://"));
    return fileRoot ? { source: "mcp-roots", root: fileURLToPath(fileRoot.uri) } : undefined;
  } catch {
    return undefined;
  }
}

function detectedHost(): WorkspaceSetupStatus["host"] {
  if (process.env.CLAUDE_PROJECT_DIR?.trim() || process.env.CLAUDE_CODE) return "claude-code";
  if (Object.keys(process.env).some((name) => name.startsWith("CODEX_"))) return "codex";
  return "unknown";
}

async function inspectWorkspaceSetup(server: McpServer, provider?: TrustedWorkspaceProvider): Promise<WorkspaceSetupStatus> {
  const cwd = await realpath(process.cwd());
  const pluginRootLaunch = await isPluginRoot(cwd);
  const injected = provider ? await provider() : undefined;
  const candidate = injected
    ? { source: "injected" as const, root: injected }
    : await resolveTrustedWorkspace(server) ?? (!pluginRootLaunch ? { source: "process-cwd" as const, root: cwd } : undefined);
  const nextSteps = [
    "Codex PowerShell: $env:TOKENGRAPH_WORKSPACE_ROOT=(Get-Location).Path; codex",
    "Codex POSIX shell: TOKENGRAPH_WORKSPACE_ROOT=\"$PWD\" codex",
    "Claude Code normally forwards CLAUDE_PROJECT_DIR automatically.",
    "After changing host configuration, start a new Codex task or run /reload-plugins in Claude Code."
  ];

  if (!candidate) {
    return {
      status: "blocked",
      host: detectedHost(),
      trustedWorkspace: null,
      blockingReason: "missing-trusted-workspace",
      pluginRootLaunch,
      message: "TokenGraph needs a trusted workspace from the host before project tools can access files.",
      nextSteps
    };
  }

  let root: string;
  try {
    root = await realpath(candidate.root);
  } catch {
    return {
      status: "blocked",
      host: detectedHost(),
      trustedWorkspace: { ...candidate, root: resolve(candidate.root) },
      blockingReason: "unreadable-trusted-workspace",
      pluginRootLaunch,
      message: "The host-provided TokenGraph workspace does not exist or is not readable.",
      nextSteps
    };
  }

  const home = await realpath(homedir());
  const trustedWorkspace = { ...candidate, root };
  if (root === parse(root).root || root === home) {
    return {
      status: "blocked",
      host: detectedHost(),
      trustedWorkspace,
      blockingReason: "unsafe-trusted-workspace",
      pluginRootLaunch,
      message: "TokenGraph refuses filesystem and home directories as trusted workspace roots.",
      nextSteps
    };
  }

  return {
    status: "ready",
    host: detectedHost(),
    trustedWorkspace,
    blockingReason: null,
    pluginRootLaunch,
    message: "TokenGraph has a safe host-provided workspace boundary.",
    nextSteps: []
  };
}

function createWorkspaceResolver(server: McpServer, provider?: TrustedWorkspaceProvider) {
  return async (inputRoot?: string): Promise<string> => {
    const setup = await inspectWorkspaceSetup(server, provider);
    if (setup.blockingReason === "missing-trusted-workspace") {
      throw new Error("TokenGraph needs a trusted workspace root from the host before it can access project files.");
    }
    if (setup.blockingReason === "unsafe-trusted-workspace") {
      throw new Error("TokenGraph refuses filesystem and home directories as workspace roots.");
    }
    if (setup.blockingReason === "unreadable-trusted-workspace") {
      throw new Error(setup.message);
    }
    const allowedRoot = setup.trustedWorkspace?.root;
    if (!allowedRoot) throw new Error(setup.message);

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
  return compactToolResultEnvelope(output);
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

function projectIndexOptions(
  config: Awaited<ReturnType<typeof loadTokenGraphConfig>>,
  control: Awaited<ReturnType<typeof loadRoutingControl>>
): ProjectIndexOptions {
  return {
    parserLimits: {
      maxFileBytes: config.parser.maxFileBytes,
      maxTotalBytes: config.parser.maxTotalBytes,
      maxSymbols: config.parser.maxSymbols,
      maxNodes: config.parser.maxNodes,
      perFileTimeoutMs: config.parser.perFileTimeoutMs,
      wholeIndexTimeoutMs: config.parser.wholeIndexTimeoutMs,
      maxDepth: config.parser.maxRecursionDepth,
      maxGeneratedFiles: config.parser.maxGeneratedFiles,
      maxTsconfigChain: config.parser.maxTsconfigChain,
      maxAliases: config.parser.maxAliases
    },
    // B7 stays dark until a complete B6 promotion report proves every gate.
    polyglotEnabled: isValidatedPromotion(control.promotion) && control.promotion.enforcementEnabled
  };
}

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
    const [config, control] = await Promise.all([loadTokenGraphConfig(root), loadRoutingControl(root)]);
    const options = projectIndexOptions(config, control);
    const currentScanSignature = await scanProjectSignature(root, options.parserLimits);
    const existing = await loadProjectIndex(root);
    if (existing && isSafeProjectIndex(root, existing)) {
      if (existing.scanSignature === currentScanSignature) {
        return existing;
      }
      const updated = await updateProjectIndexIncremental(root, existing, options);
      const current = updated.index;
      if (isFreshProjectIndex(existing, current)) {
        await saveProjectIndex(root, current);
        await enforceStorageClassQuotas(root, config.storage);
        return current;
      }
      await saveProjectIndex(root, current);
      await enforceStorageClassQuotas(root, config.storage);
      return current;
    }
    const indexed = await indexProject(root, { ...options, scanSignature: currentScanSignature });
    await saveProjectIndex(root, indexed);
    await enforceStorageClassQuotas(root, config.storage);
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
      unsupportedLanguages: project.exclusions.filter((exclusion) => exclusion.reason === "unsupported").length,
      unsupportedLanguageCounts: project.unsupportedLanguageCounts ?? {},
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
  const bm25Scores = new Map(rankFilesBm25(project, query, Math.max(limit, project.files.length)).map((row) => [row.path, row.score]));
  const fileRows = project.files.map((file) => ({
    kind: "file",
    name: file.path,
    path: file.path,
    score: bm25Scores.get(file.path) ?? score(`${file.path} ${file.kind} ${file.route ?? ""}`)
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

function recommendedExactRead(plan: ContextPlan, project: ProjectIndex) {
  const first = plan.recommendedFirstReads.find((candidate) => candidate.startLine !== undefined && candidate.endLine !== undefined);
  if (!first || first.startLine === undefined || first.endLine === undefined) return undefined;
  const file = project.files.find((candidate) => candidate.path === first.path);
  if (!file) return undefined;
  return buildEvidenceBackedSliceRecommendation(first.path, first.startLine, first.endLine, file.contentHash);
}

export function createTokenGraphServer(options: { trustedWorkspace?: TrustedWorkspaceProvider } = {}): McpServer {
  const toolSurface = selectedToolSurface();
  const server = new McpServer(
    { name: "tokengraph", version: "0.21.1" },
    {
      instructions:
        "Use TokenGraph for task-scoped context routing, debugging failures, change risk, architecture checks, memory recall, SQL/wiki lookup, and compression before broad raw reads. " +
        "Call tokengraph_setup once and capture its trusted workspace root. Use tokengraph_prepare_context only when planning is needed; otherwise omit taskId from the first query, compress, recall, or analyze call and capture the returned taskId. Complete or pause with tokengraph_task_report. " +
        "TokenGraph tools are task-scoped: never reuse a taskId across workspaces or merge unrelated tasks."
    }
  );
  const workspaceRoot = createWorkspaceResolver(server, options.trustedWorkspace);

  async function requireTaskRoot(root: string | undefined, taskId: string, allowTerminal = false): Promise<string> {
    const resolvedRoot = await workspaceRoot(root);
    const ledger = await loadTaskLedger(resolvedRoot, taskId);
    if (!ledger) throw new Error(`Task ledger ${taskId} was not found under the requested trusted root.`);
    if (!allowTerminal && ledger.status !== "open") {
      throw new Error(`${ledger.status === "paused" ? "Paused" : "Completed"} task ${taskId} is terminal and cannot accept task-aware calls. Start a new task with tokengraph_prepare_context or omit taskId on a direct intent call.`);
    }
    return resolvedRoot;
  }

  async function beginOrRequireTask(root: string | undefined, taskId?: string): Promise<{ root: string; taskId: string; autoStarted: boolean }> {
    const resolvedRoot = await workspaceRoot(root);
    if (taskId) {
      const ledger = await loadTaskLedger(resolvedRoot, taskId);
      if (!ledger) throw new Error(`Task ledger ${taskId} was not found under the requested trusted root.`);
      if (ledger.status !== "open") {
        throw new Error(`${ledger.status === "paused" ? "Paused" : "Completed"} task ${taskId} is terminal and cannot accept task-aware calls. Start a new task by omitting taskId or with tokengraph_prepare_context.`);
      }
      return { root: resolvedRoot, taskId, autoStarted: false };
    }
    const ledger = await createTaskLedger(resolvedRoot, { host: taskHost(detectedHost()) });
    return { root: resolvedRoot, taskId: ledger.taskId, autoStarted: true };
  }

  async function withTaskIntent<T>(
    root: string | undefined,
    taskId: string | undefined,
    operation: (task: { root: string; taskId: string; autoStarted: boolean }) => Promise<T>
  ): Promise<T> {
    const task = await beginOrRequireTask(root, taskId);
    try {
      return await operation(task);
    } catch (error) {
      if (task.autoStarted) await discardEmptyTaskLedger(task.root, task.taskId);
      throw error;
    }
  }

  async function probeRoutingState(resolvedRoot: string) {
    try {
      const [status, config, control] = await Promise.all([
        getIndexStatus(resolvedRoot, { probeOnly: true }),
        loadTokenGraphConfig(resolvedRoot),
        loadRoutingControl(resolvedRoot)
      ]);
      return { status, config, control };
    } catch {
      return undefined;
    }
  }

  async function routeBeforeLedger(root: string | undefined, task: string | undefined, routingOverride: "auto" | "force-on" | "force-bypass" | undefined): Promise<RoutingDecision | undefined> {
    if (!task?.trim()) return undefined;
    const resolvedRoot = await workspaceRoot(root);
    const probe = await probeRoutingState(resolvedRoot);
    if (!probe) return failOpenRouting();
    return adviseRouting({
      task,
      routingOverride,
      routingMode: probe.config.routingMode,
      indexAvailable: probe.status.hasIndex,
      cachedStatus: probe.status.state === "fresh" ? "fresh" : probe.status.state === "missing" ? "missing" : "stale",
      killSwitch: probe.config.routingKillSwitch || probe.control.killSwitch,
      promotion: probe.control.promotion
    });
  }

  function directHostFallback(routing: RoutingDecision): object {
    return {
      mode: "direct-host",
      routing,
      guidance: "This bounded task does not require TokenGraph context. Continue with the host tools directly; use routingOverride force-on for discovery when needed."
    };
  }

  function shouldBypassHost(routing: RoutingDecision | undefined, routingOverride: "auto" | "force-on" | "force-bypass" | undefined): boolean {
    return Boolean(routing && !routing.useTokenGraph && (routing.enforced || routingOverride === "force-bypass"));
  }

  server.registerTool(
    "tokengraph_setup",
    {
      title: "Set Up TokenGraph",
      description: "Check workspace trust and the selected surface.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({})
    },
    async () => {
      const setup = await inspectWorkspaceSetup(server, options.trustedWorkspace);
      const repositoryIdentity = setup.trustedWorkspace ? await getRepositoryIdentity(setup.trustedWorkspace.root) : null;
      return ok({
      ...setup,
      repositoryIdentity,
      warnings: setup.trustedWorkspace ? getRepositorySetupWarnings(setup.trustedWorkspace.root) : [],
      surface: toolSurface,
      capabilities: {
        taskScoped: true,
        coreTools: [...CORE_TOOL_NAMES],
        legacyCompatibility: toolSurface === "full"
      }
      });
    }
  );

  server.registerTool(
    "tokengraph_prepare_context",
    {
      title: "Prepare Task Context",
      description: "Plan compact context and start a task; verbose adds diagnostics.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: prepareContextInputSchema
    },
    async ({ root, task, profile, maxTokens, allowRawReads, constraints, responseMode, refreshIndex, host, routingOverride, knownArtifacts }) => {
      const resolvedRoot = await workspaceRoot(root);
      const probe = await probeRoutingState(resolvedRoot);
      if (!probe) {
        const routing = failOpenRouting();
        const response = { mode: "direct-host" as const, routing, guidance: "TokenGraph routing was unavailable, so this request is being left to the host tools. Retry discovery after the workspace state is repaired." };
        return ok(responseMode === "verbose" ? { ...response, root: resolvedRoot } : response);
      }
      const { status: cachedStatus, config, control } = probe;
      const indexOptions = projectIndexOptions(config, control);
      await enforceStorageClassQuotas(resolvedRoot, config.storage);
      const identity = await getRepositoryIdentity(resolvedRoot);
      const routing = adviseRouting({
        task,
        knownArtifacts,
        routingOverride,
        routingMode: config.routingMode,
        indexAvailable: cachedStatus.hasIndex,
        cachedStatus: cachedStatus.state === "fresh" ? "fresh" : cachedStatus.state === "missing" ? "missing" : "stale",
        killSwitch: config.routingKillSwitch || control.killSwitch,
        promotion: control.promotion
      });
      if (shouldBypassHost(routing, routingOverride)) {
        const response = {
          mode: "direct-host" as const,
          routing,
          guidance: "This bounded task does not require TokenGraph context. Continue with the host tools directly; call tokengraph_prepare_context again for discovery, architecture, debugging, or migration work."
        };
        return ok(responseMode === "verbose" ? { ...response, root: resolvedRoot } : response);
      }
      const statusBefore = await getIndexStatus(resolvedRoot, { projectOptions: indexOptions });
      const existing = await loadProjectIndex(resolvedRoot);
      let project: ProjectIndex;
      let indexingMode: "existing" | "full" | "incremental" = "existing";
      let changes = { addedFiles: [] as string[], changedFiles: [] as string[], deletedFiles: [] as string[], parsedFiles: [] as string[] };

      if (statusBefore.state === "fresh" && existing && isSafeProjectIndex(resolvedRoot, existing)) {
        project = existing;
      } else if (!refreshIndex) {
        throw new Error("The TokenGraph index is missing or stale and refreshIndex is false.");
      } else if (existing && isSafeProjectIndex(resolvedRoot, existing)) {
        const updated = await updateProjectIndexIncremental(resolvedRoot, existing, indexOptions);
        project = updated.index;
        indexingMode = updated.mode;
        changes = {
          addedFiles: updated.addedFiles,
          changedFiles: updated.changedFiles,
          deletedFiles: updated.deletedFiles,
          parsedFiles: updated.parsedFiles
        };
        await saveProjectIndex(resolvedRoot, project);
        await enforceStorageClassQuotas(resolvedRoot, config.storage);
      } else {
        project = await indexProject(resolvedRoot, indexOptions);
        indexingMode = "full";
        changes.parsedFiles = project.files.map((file) => file.path);
        await saveProjectIndex(resolvedRoot, project);
        await enforceStorageClassQuotas(resolvedRoot, config.storage);
      }

      const appliedKnowledge = await listAppliedKnowledge(resolvedRoot);
      if (indexingMode !== "existing" && config.wikiGenerationEnabled) {
        const wikiMemories = config.memoryEnabled ? await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).list() : [];
        await saveProjectWiki(resolvedRoot, buildProjectWiki(project, wikiMemories, appliedKnowledge));
      }
      const memoryLimit = config.maxMemories;
      const memories = config.memoryEnabled ? await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).search(task, memoryLimit) : [];
      const plan = await buildContextPlan({
        root: resolvedRoot,
        task,
        project,
        memories,
        budget: {
          profile: profile ?? config.tokenSavingProfile,
          maxEstimatedTokens: maxTokens,
          allowRawReads
        }
      });
      const projectBrief = buildAdaptiveProjectBrief({
        repositoryId: identity.repositoryId,
        sourceFingerprint: project.fingerprint,
        sections: [
          { id: "frameworks", text: project.frameworks.join(", "), evidenceClass: "indexed", confidence: "high", source: "index:project-frameworks" },
          { id: "first-reads", text: plan.recommendedFirstReads.map((file) => file.path).join("\n"), evidenceClass: "derived", confidence: "high", source: "planner:recommended-first-reads" }
        ]
      }, Math.max(150, Math.min(config.memory.projectBriefTargetTokens, config.memory.projectBriefMaxTokens)));
      const ledger = await createTaskLedger(resolvedRoot, { host: taskHost(host ?? detectedHost()) });
      await updateTaskRoutingObservation(resolvedRoot, ledger.taskId, {
        decision: routing.useTokenGraph ? "activate" : "bypass",
        stage: routing.stage,
        reason: routing.reason,
        expectedOverheadTokens: routing.expectedOverheadTokens,
        mode: config.routingMode,
        enforced: routing.enforced
      });
      const capsule = buildRetrievalCapsule(ledger.taskId, task, project, plan.recommendedFirstReads.map((file) => file.path), config.parser.maxGraphDepth);
      const capsuleStableArtifact = capsuleArtifact(capsule);
      await saveStableArtifact(resolvedRoot, capsuleStableArtifact);
      const outcomes = await listCompletedTaskOutcomes(resolvedRoot);
      const memoryContext = composeMemoryContext({
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
        branch: identity.branch,
        sourceFingerprint: project.fingerprint,
        projectBrief,
        indexedFacts: project.files.slice(0, config.maxFiles).map((file) => `${file.path}:${file.language}`),
        capsules: [capsuleStableArtifact.hash],
        reviewedDecisions: [
          ...appliedKnowledge.map((entry) => `${entry.title}: ${entry.proposedContent}`),
          ...memories.filter((memory) => Boolean(memory.confirmedAt)).map((memory) => `${memory.title}: ${memory.body}`)
        ],
        maxTokens: config.memory.maxRetrievalTokens,
        outcomes
      });
      if (memories.length) {
        const vaultNotes = projectToVault(memories.map((memory) => ({ id: memory.id, title: memory.title, body: memory.body, links: memory.linkedFiles, archived: memory.status !== "active", updatedAt: memory.updatedAt })));
        const vaultManifest = `${JSON.stringify({ schemaVersion: 1, notes: vaultNotes.map(({ path, title, hash, backlinks, archived }) => ({ path, title, hash, backlinks, archived })) }, null, 2)}\n`;
        const vaultBytes = vaultNotes.reduce((total, note) => total + Buffer.byteLength(note.body, "utf8"), Buffer.byteLength(vaultManifest, "utf8"));
        await assertStorageReplacementAllowed(resolvedRoot, "vault", vaultBytes, config.storage);
        await saveVaultProjection(resolvedRoot, vaultNotes);
      }
      const readPolicy = escalateReadPolicy({ level: "L1", allowRawReads: false, reason: "capsule-first retrieval" }, plan.budget.allowRawReads ? "L3" : "L1");
      await updateTaskReadPolicy(resolvedRoot, ledger.taskId, readPolicy);
      const recommendedRead = readPolicy.allowRawReads ? recommendedExactRead(plan, project) : undefined;
      const projectedPlan = responseMode === "verbose" ? plan : compactPlanResponse(plan, { constraints, allowRawReads: plan.budget.allowRawReads });
      const artifactContent = compactPlanResponse(plan, { constraints, allowRawReads: plan.budget.allowRawReads });
      const stableArtifact = createStableArtifact(
        `context/${createHash("sha256").update(task.trim().toLocaleLowerCase()).digest("hex")}`,
        artifactContent,
        1,
        {
          // The artifact remains repository-scoped through persistence and lookup
          // validation, while the hash fingerprint is derived from the canonical
          // indexed state so equivalent LF/CRLF checkouts produce the same artifact.
          repositoryFingerprint: identity.repositoryFingerprint,
          sourceFingerprint: project.fingerprint,
          parserVersion: "tokengraph-index-v4",
          normalizedIntent: task.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
          retrievalConfig: { profile: plan.profile, maxEstimatedTokens: plan.budget.maxEstimatedTokens, allowRawReads: plan.budget.allowRawReads },
          memoryFingerprint: createHash("sha256").update(JSON.stringify(memories.map((memory) => memory.id))).digest("hex"),
          decisionFingerprint: createHash("sha256").update(JSON.stringify(appliedKnowledge.map((entry) => ({ id: entry.suggestionId, fingerprint: entry.fingerprint })))).digest("hex")
        }
      );
      await saveStableArtifact(resolvedRoot, stableArtifact);
      const artifactDelivery = shouldSuppressArtifact(stableArtifact, knownArtifacts)
        ? { artifactReference: { id: stableArtifact.id, hash: stableArtifact.hash }, deliveredArtifacts: [] as string[] }
        : { artifact: stableArtifact, deliveredArtifacts: [artifactKey(stableArtifact)] };
      if (artifactDelivery.deliveredArtifacts.length) {
        await recordTaskArtifactDelivery(resolvedRoot, ledger.taskId, artifactDelivery.deliveredArtifacts);
      }
      const statusAfter = await getIndexStatus(resolvedRoot, { projectOptions: indexOptions });
      const wikiStatus = await getWikiStatus(resolvedRoot);
      const response = responseMode === "verbose"
        ? {
            root: resolvedRoot, taskId: ledger.taskId,
            index: { status: indexingMode === "existing" ? statusAfter.state : "refreshed", previousStatus: statusBefore.state, postStatus: statusAfter.state, indexingMode, changes },
            plan: projectedPlan, wikiStatus, routing, retrieval: { capsuleHash: capsuleStableArtifact.hash, readPolicy, ...(recommendedRead ? { recommendedRead } : {}) }, memory: memoryContext, unsupportedLanguageCounts: project.unsupportedLanguageCounts ?? {}, ...artifactDelivery
          }
        : compactPrepareEnvelope({
            root: resolvedRoot, taskId: ledger.taskId, plan: projectedPlan, routing, retrieval: { capsuleHash: capsuleStableArtifact.hash, readPolicy, ...(recommendedRead ? { recommendedRead } : {}) }, unsupportedLanguageCounts: project.unsupportedLanguageCounts ?? {}, ...artifactDelivery, deliveredArtifacts: artifactDelivery.deliveredArtifacts
          });
      await recordCoreEvent({
        root: resolvedRoot,
        taskId: ledger.taskId,
        toolName: "tokengraph_prepare_context",
        category: "context-routing",
        operation: {
          taskHash: createHash("sha256").update(task).digest("hex"),
          profile: plan.profile,
          indexingMode,
          routingObservation: {
            decision: routing.useTokenGraph ? "activate" : "bypass",
            stage: routing.stage,
            reason: routing.reason,
            expectedOverheadTokens: routing.expectedOverheadTokens,
            mode: config.routingMode,
            enforced: routing.enforced
          }
        },
        originalTokens: project.files.reduce((total, file) => total + file.estimatedTokens, 0),
        compactTokens: estimateTokens(compactJson(compactToolResultEnvelope(response)))
      });
      return ok(response);
    }
  );

  server.registerTool(
    "tokengraph_query_context",
    {
      title: "Query Task Context",
      description: "Query graph, SQL, or wiki context; omit taskId to start a task.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: queryContextInputSchema
    },
    async (input) => {
      const { taskId, root, mode, responseMode } = input;
      const directRouting = await routeBeforeLedger(root, input.query ?? input.target, input.routingOverride);
      if (!taskId && shouldBypassHost(directRouting, input.routingOverride)) {
        const fallback = directHostFallback(directRouting!);
        return ok(responseMode === "verbose" ? { ...fallback, root: await workspaceRoot(root) } : fallback);
      }
      return withTaskIntent(root, taskId, async (task) => {
      const resolvedRoot = task.root;
      const project = ["wiki", "artifact", "run"].includes(mode) ? undefined : await ensureProject(resolvedRoot);
      let result: object;
      if (mode === "overview") {
        result = projectMap(project!);
      } else if (mode === "search") {
        const { query, limit } = input;
        result = { query, results: searchProject(project!, query!, limit ?? 10) };
      } else if (mode === "symbol") {
        const { target } = input;
        result = explain(project!, target!);
      } else if (mode === "sql") {
        const { query, limit } = input;
        result = { query, sql: sqlSummary(project!, query!, limit ?? 10) };
      } else if (mode === "artifact") {
        const artifact = await loadStableArtifact(resolvedRoot, input.artifactHash!);
        result = artifact
          ? { artifactHash: input.artifactHash, status: "found", artifact }
          : { artifactHash: input.artifactHash, status: "not-found", message: "The requested stable artifact is not present or failed validation." };
      } else if (mode === "run") {
        const selectedRun = await loadRun(resolvedRoot, input.runId!);
        const selector = input.test ? { test: input.test } : input.file ? { file: input.file } : { errorClass: input.errorClass! };
        const matchesSelector = selectedRun !== undefined && Object.entries(selector).every(([key, value]) => selectedRun.metadata?.[key as keyof NonNullable<typeof selectedRun.metadata>] === value);
        result = {
          runId: input.runId,
          selector,
          status: matchesSelector ? "found" : "not-found",
          run: matchesSelector ? summarizeRun(selectedRun!) : undefined
        };
      } else if (mode === "slice") {
        const file = project!.files.find((candidate) => candidate.path === input.file);
        if (!file || file.contentHash !== input.contentHash) throw new Error("The requested exact slice does not match the current indexed file hash.");
        const [ledger, config] = await Promise.all([loadTaskLedger(resolvedRoot, task.taskId), loadTokenGraphConfig(resolvedRoot)]);
        if (!ledger) throw new Error(`Task ledger ${task.taskId} was not found or was corrupt.`);
        const currentPolicy = startReadPolicyResponse(escalateReadPolicy(
          ledger.readPolicy ?? { level: "L1", allowRawReads: false, reason: "capsule-first retrieval" },
          "L3"
        ));
        const recommendation = recommendExactRead(currentPolicy, { reassessed: input.evidenceReassessed, evidenceGap: input.evidenceGap });
        if (!recommendation.allowed) throw new Error(recommendation.reason);
        const slice = await readExactSlice(
          resolvedRoot,
          input.file!,
          input.startLine!,
          input.endLine!,
          Math.min(config.parser.maxFileBytes, 64 * 1024),
          input.contentHash,
          config.parser.maxFileBytes
        );
        result = responseMode === "verbose" ? slice : compactSliceResponse(slice);
        await updateTaskReadPolicy(resolvedRoot, task.taskId, recommendation.state);
      } else {
        const { slug, constraints, responseMode } = input;
        const wiki = await loadProjectWiki(resolvedRoot);
        if (!wiki) throw new Error("No generated TokenGraph wiki was found.");
        if (!slug && responseMode === "verbose") throw new Error("A wiki slug is required for verbose wiki responses.");
        if (responseMode !== "verbose") {
          const selectedWiki = slug ? { ...wiki, pages: wiki.pages.filter((candidate) => candidate.slug === slug) } : wiki;
          if (slug && selectedWiki.pages.length === 0) throw new Error(`Unknown wiki page slug "${slug}".`);
          result = compactWikiResponse(selectedWiki, { constraints });
        } else {
          const page = wiki.pages.find((candidate) => candidate.slug === slug);
          if (!page) throw new Error(`Unknown wiki page slug "${slug}".`);
          result = { slug: page.slug, title: page.title, body: page.body, estimatedTokens: page.estimatedTokens, wikiStatus: await getWikiStatus(resolvedRoot) };
        }
      }
      const response = responseMode === "verbose" ? { mode, result } : compactModeEnvelope(mode, result);
      const compactTokens = estimateTokens(compactJson(compactToolResultEnvelope(response)));
      const originalTokens = project ? project.files.reduce((total, file) => total + file.estimatedTokens, 0) : compactTokens;
      await recordCoreEvent({
        root: resolvedRoot, taskId: task.taskId, toolName: "tokengraph_query_context", category: `query-${mode}`,
        operation: { mode, queryHash: createHash("sha256").update(input.query ?? input.target ?? input.slug ?? mode).digest("hex"), limit: input.limit ?? null },
        originalTokens, compactTokens
      });
      return ok(task.autoStarted ? { ...response, taskId: task.taskId } : response);
      });
    }
  );

  server.registerTool(
    "tokengraph_compress",
    {
      title: "Compress Task Material",
      description: "Compress output or context; omit taskId to start a task.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: compressInputSchema
    },
    async (input) => {
      const { taskId, root, mode } = input;
      const directRouting = await routeBeforeLedger(root, input.task, input.routingOverride);
      if (!taskId && shouldBypassHost(directRouting, input.routingOverride)) {
        const fallback = directHostFallback(directRouting!);
        return ok(input.responseMode === "verbose" ? { ...fallback, root: await workspaceRoot(root) } : fallback);
      }
      return withTaskIntent(root, taskId, async (task) => {
      const resolvedRoot = task.root;
      let result: object;
      let estimates: { baselineTokens: number };
      if (mode === "output") {
        const { kind, text, maxLines } = input;
        const compressed = compressOutput({ kind: kind!, text: text!, maxLines });
        result = compressed;
        estimates = compressed.estimatedTokens;
      } else {
        const { task, contentKind, text, preserveRawReferences, constraints, responseMode } = input;
        const [project, config, wiki] = await Promise.all([ensureProject(resolvedRoot), loadTokenGraphConfig(resolvedRoot), loadProjectWiki(resolvedRoot)]);
        const memories = config.memoryEnabled ? await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).search(`${task}\n${text ?? ""}`, config.maxMemories) : [];
        const compressed = await compressContext({
          root: resolvedRoot, task: task!, contentKind: contentKind!, text, profile: config.tokenSavingProfile,
          preserveRawReferences, project, memories, wiki
        });
        result = responseMode === "verbose" ? compressed : compactCompressionResponse(compressed, { constraints });
        estimates = compressed.estimatedTokens;
      }
      const compactResponse = compactCompressionEnvelope(mode, result);
      const category = `compression-${mode}`;
      const overheadTokens = coreEventOverheadTokens(task.taskId, "tokengraph_compress", category);
      const includeEstimates = mode !== "context" || input.responseMode === "verbose";
      let returnedResponse: object = compactResponse;
      let compactTokens = estimateTokens(compactJson(compactToolResultEnvelope(returnedResponse)));
      if (includeEstimates) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          returnedResponse = compactCompressionEnvelope(mode, result, { original: estimates.baselineTokens, compact: compactTokens, overhead: overheadTokens });
          const measured = estimateTokens(compactJson(compactToolResultEnvelope(returnedResponse)));
          if (measured === compactTokens) break;
          compactTokens = measured;
        }
      }
      await recordCoreEvent({
        root: resolvedRoot, taskId: task.taskId, toolName: "tokengraph_compress", category,
        operation: { mode, kind: mode === "output" ? input.kind : input.contentKind, inputHash: createHash("sha256").update(`${"task" in input ? input.task : ""}\n${input.text ?? ""}`).digest("hex") },
        originalTokens: estimates.baselineTokens, compactTokens, overheadTokens
      });
      return ok(task.autoStarted ? { ...returnedResponse, taskId: task.taskId } : returnedResponse);
      });
    }
  );

  server.registerTool(
    "tokengraph_recall",
    {
      title: "Recall Task Knowledge",
      description: "Recall or review memory; omit taskId to start a task.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: recallInputSchema
    },
    async ({ taskId, root, mode, query, limit, audit, constraints, responseMode, routingOverride }) => {
      const directRouting = await routeBeforeLedger(root, query, routingOverride);
      if (!taskId && shouldBypassHost(directRouting, routingOverride)) {
        const fallback = directHostFallback(directRouting!);
        return ok(responseMode === "verbose" ? { ...fallback, root: await workspaceRoot(root) } : fallback);
      }
      return withTaskIntent(root, taskId, async (task) => {
      const resolvedRoot = task.root;
      const store = new MemoryStore(await repositoryMemoryPath(resolvedRoot));
      const project = await ensureProject(resolvedRoot);
      const memories = await store.list({ includeDeprecated: audit === true, includeDeleted: audit === true });
      const terms = tokenize(query ?? "");
      const recalled = memories
        .filter((memory) => terms.length === 0 || terms.some((term) => tokenize(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")}`).some((part) => part.includes(term) || term.includes(part))))
        .slice(0, limit ?? 10);
      const verboseResult = mode === "review"
        ? await reviewMemories({ memories, query: query ?? "", limit: limit ?? 20 })
        : { query: query ?? "", auditMode: audit === true, memories: recalled };
      const result = responseMode === "verbose"
        ? verboseResult
        : mode === "review"
          ? compactRecallResponse(verboseResult as Awaited<ReturnType<typeof reviewMemories>>, { constraints }, memories, project)
          : compactMemoryRecallResponse(recalled, { constraints });
      const response = responseMode === "verbose" ? { mode, result } : compactModeEnvelope(mode, result);
      const compactTokens = estimateTokens(compactJson(compactToolResultEnvelope(response)));
      await recordCoreEvent({
        root: resolvedRoot, taskId: task.taskId, toolName: "tokengraph_recall", category: `memory-${mode}`,
        operation: { mode, queryHash: createHash("sha256").update(query ?? "").digest("hex"), limit: limit ?? null, audit: audit === true },
        originalTokens: estimateTokens(compactJson(memories)), compactTokens
      });
      return ok(task.autoStarted ? { ...response, taskId: task.taskId } : response);
      });
    }
  );

  server.registerTool(
    "tokengraph_analyze",
    {
      title: "Analyze Task Evidence",
      description: "Trace failures, assess risk, or check architecture; omit taskId to start a task.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: analyzeInputSchema
    },
    async (input) => {
      const { taskId, root, mode } = input;
      const directRouting = await routeBeforeLedger(root, input.task ?? input.text, input.routingOverride);
      if (!taskId && shouldBypassHost(directRouting, input.routingOverride)) {
        const fallback = directHostFallback(directRouting!);
        return ok(input.responseMode === "verbose" ? { ...fallback, root: await workspaceRoot(root) } : fallback);
      }
      return withTaskIntent(root, taskId, async (task) => {
      const resolvedRoot = task.root;
      const project = await ensureProject(resolvedRoot);
      const store = new MemoryStore(await repositoryMemoryPath(resolvedRoot));
      let result: object;
      if (mode === "failure") {
        const { kind, text, task } = input;
        const memories = await store.search(`${task ?? ""}\n${text}`, 8);
        const verbose = await traceFailure({ root: resolvedRoot, kind: kind!, text: text!, task, project, memories });
        result = input.responseMode === "verbose" ? verbose : compactFailureResponse(verbose, { constraints: input.constraints, includeSql: hasSqlIntent(`${task ?? ""}\n${text}`) });
      } else if (mode === "risk") {
        const { changedFiles, diffSummary, task } = input;
        const rules = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).list();
        const memories = await store.search(`${task ?? ""}\n${diffSummary ?? ""}\n${changedFiles!.join("\n")}`, 8);
        const verbose = await assessChangeRisk({ root: resolvedRoot, changedFiles: changedFiles!, diffSummary, task, project, rules, memories });
        result = input.responseMode === "verbose" ? verbose : compactRiskResponse(verbose, { constraints: input.constraints });
      } else {
        const { files } = input;
        const rules = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).list();
        result = await checkArchitecture({ root: resolvedRoot, project, rules, files });
      }
      const response = input.responseMode === "verbose" ? { mode, result } : compactModeEnvelope(mode, result);
      const compactTokens = estimateTokens(compactJson(compactToolResultEnvelope(response)));
      await recordCoreEvent({
        root: resolvedRoot, taskId: task.taskId, toolName: "tokengraph_analyze", category: `analysis-${mode}`,
        operation: { mode, inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") },
        originalTokens: Math.max(compactTokens, project.files.reduce((total, file) => total + file.estimatedTokens, 0)), compactTokens
      });
      return ok(task.autoStarted ? { ...response, taskId: task.taskId } : response);
      });
    }
  );

  server.registerTool(
    "tokengraph_propose_knowledge",
    {
      title: "Propose Task Knowledge",
      description: "Review local knowledge. propose requires type, title, rationale, proposedContent, sourceFingerprints, and affectedIdentifiers; approve/reject require id.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: proposeKnowledgeInputSchema
    },
    async (input) => {
      const { taskId, root, action } = input;
      const resolvedRoot = await requireTaskRoot(root, taskId);
      let output: object;
      if (action === "propose") {
        const { type, title, rationale, proposedContent, sourceFingerprints, affectedIdentifiers, sources, affectedTargets, conflictNotes, expiresAt } = input;
        output = { suggestion: await proposeKnowledgeChange(resolvedRoot, {
          type: type!, title: title!, rationale: rationale!, proposedContent: proposedContent!,
          sourceFingerprints: sourceFingerprints!, affectedIdentifiers: affectedIdentifiers!,
          ...(sources ? { sources } : {}), ...(affectedTargets ? { affectedTargets } : {}),
          ...(conflictNotes ? { conflictNotes } : {}), ...(expiresAt ? { expiresAt } : {})
        }) };
      } else if (action === "list") {
        const { type, status } = input;
        output = { suggestions: await listKnowledgeSuggestions(resolvedRoot, { type, status }) };
      } else {
        output = await reviewKnowledgeSuggestion(resolvedRoot, input.id!, action, input.reason);
        if (action === "approve") {
          const [project, existingWiki, memories, applications] = await Promise.all([
            loadProjectIndex(resolvedRoot), loadProjectWiki(resolvedRoot),
            new MemoryStore(await repositoryMemoryPath(resolvedRoot)).list(), listAppliedKnowledge(resolvedRoot)
          ]);
          if (project && existingWiki) await saveProjectWiki(resolvedRoot, buildProjectWiki(project, memories, applications));
        }
      }
      const compactTokens = estimateTokens(compactJson(output));
      await recordCoreEvent({
        root: resolvedRoot, taskId, toolName: "tokengraph_propose_knowledge", category: `knowledge-${action}`,
        operation: action === "propose"
          ? { action, proposalHash: createHash("sha256").update(JSON.stringify({ type: input.type, title: input.title, rationale: input.rationale, proposedContent: input.proposedContent, sourceFingerprints: input.sourceFingerprints, affectedIdentifiers: input.affectedIdentifiers, sources: input.sources, affectedTargets: input.affectedTargets, conflictNotes: input.conflictNotes, expiresAt: input.expiresAt })).digest("hex") }
          : { action, id: "id" in input ? input.id : null, filters: action === "list" ? { type: input.type ?? null, status: input.status ?? null } : null },
        originalTokens: compactTokens, compactTokens
      });
      return ok(output);
    }
  );

  server.registerTool(
    "tokengraph_task_report",
    {
      title: "Set Task Disposition",
      description: "Complete by default with the canonical footer, or pause; verbose adds the report.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: taskReportInputSchema
    },
    async ({ taskId, root, disposition, responseMode }) => {
      const resolvedRoot = await requireTaskRoot(root, taskId, true);
      if (disposition === "pause") {
        await setTaskDisposition(resolvedRoot, taskId, disposition);
        return ok({ status: "paused", taskId, reportingStatus: "paused" });
      }

      const ledger = await loadTaskLedger(resolvedRoot, taskId);
      if (!ledger) throw new Error(`Task ledger ${taskId} was not found or was corrupt.`);
      const previewFooter = formatTaskReportFooter(buildTaskReport(ledger));
      const result = await setTaskDisposition(
        resolvedRoot,
        taskId,
        disposition,
        undefined,
        undefined,
        estimateTokens(previewFooter)
      );
      if (!result.report) throw new Error(`Task ledger ${taskId} did not produce a completion report.`);
      const footer = formatTaskReportFooter(result.report);
      const compact = { status: "completed", taskId, footer, reportingStatus: "ready" } as const;
      return ok(responseMode === "verbose" ? { ...compact, report: result.report } : compact);
    }
  );

  if (toolSurface === "full") {
    // The legacy description patch is scoped to the compatibility surface only;
    // the eight default intent tools retain their compact, canonical metadata.
    const registerTool = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: { description?: string }, handler: unknown) =>
      registerTool(name, { ...config, description: legacyDescription(config.description) } as never, handler as never)) as typeof server.registerTool;

  server.registerTool(
    "tokengraph_setup_status",
    {
      title: "TokenGraph Setup Status",
      description: "Use this when TokenGraph project tools are blocked to diagnose host workspace trust without reading project files.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({})
    },
    async () => ok(await inspectWorkspaceSetup(server, options.trustedWorkspace))
  );

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
      const [config, control] = await Promise.all([loadTokenGraphConfig(resolvedRoot), loadRoutingControl(resolvedRoot)]);
      const indexOptions = projectIndexOptions(config, control);
      const existing = fullReindex ? undefined : await loadProjectIndex(resolvedRoot);
      const result = existing && isSafeProjectIndex(resolvedRoot, existing)
        ? await updateProjectIndexIncremental(resolvedRoot, existing, indexOptions)
        : {
            index: await indexProject(resolvedRoot, indexOptions),
            mode: "full" as const,
            addedFiles: [],
            changedFiles: [],
            deletedFiles: [],
            parsedFiles: []
          };
      const project = result.index;
      await saveProjectIndex(resolvedRoot, project);
      await enforceStorageClassQuotas(resolvedRoot, config.storage);
      let wikiRefreshed = false;
      let wikiWarning: string | undefined;
      if (config.wikiGenerationEnabled) {
        try {
          const memories = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).list();
          await saveProjectWiki(resolvedRoot, buildProjectWiki(project, memories, await listAppliedKnowledge(resolvedRoot)));
          await enforceStorageClassQuotas(resolvedRoot, config.storage);
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
    async ({ root }) => {
      const resolvedRoot = await workspaceRoot(root);
      const [config, control] = await Promise.all([loadTokenGraphConfig(resolvedRoot), loadRoutingControl(resolvedRoot)]);
      return ok(await getIndexStatus(resolvedRoot, { projectOptions: projectIndexOptions(config, control) }));
    }
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
        routingMode: z.enum(["shadow", "enforced", "always-activate", "always-advisory"]).optional(),
        maxFiles: z.number().int().min(1).max(50).optional(),
        maxSqlObjects: z.number().int().min(0).max(50).optional(),
        maxMemories: z.number().int().min(0).max(50).optional(),
        maxPlannedContextTokens: z.number().int().min(1).optional(),
        rawReadWarningThreshold: z.number().int().min(1).optional(),
        sqlIndexingEnabled: z.boolean().optional(),
        memoryEnabled: z.boolean().optional(),
        wikiGenerationEnabled: z.boolean().optional(),
        routingKillSwitch: z.boolean().optional(),
        routing: z.object({ mode: z.enum(["shadow", "enforced", "always-activate", "always-advisory"]).optional(), killSwitch: z.boolean().optional() }).optional(),
        parser: z.object({ maxFileBytes: z.number().int().min(1).optional(), maxTotalBytes: z.number().int().min(1).optional(), maxSymbols: z.number().int().min(1).optional(), maxNodes: z.number().int().min(1).optional(), perFileTimeoutMs: z.number().int().min(1).optional(), wholeIndexTimeoutMs: z.number().int().min(1).optional(), maxRecursionDepth: z.number().int().min(1).optional(), maxGraphDepth: z.number().int().min(0).optional(), maxGeneratedFiles: z.number().int().min(0).optional(), maxTsconfigChain: z.number().int().min(1).optional(), maxAliases: z.number().int().min(0).optional() }).optional(),
        storage: z.object({
          maxBytes: z.number().int().min(1).optional(),
          runsMaxBytes: z.number().int().min(0).optional(),
          cacheMaxBytes: z.number().int().min(0).optional(),
          vaultMaxBytes: z.number().int().min(0).optional(),
          durableMaxBytes: z.number().int().min(0).optional(),
          runRetentionDays: z.number().int().min(0).optional(),
          cacheRetentionDays: z.number().int().min(0).optional()
        }).optional(),
        runner: z.object({ maxBytes: z.number().int().min(256).optional(), timeoutMs: z.number().int().min(1).optional(), terminateGraceMs: z.number().int().min(1).optional() }).optional(),
        memory: z.object({ projectBriefTargetTokens: z.number().int().min(150).optional(), projectBriefMaxTokens: z.number().int().min(1).optional(), maxRetrievalTokens: z.number().int().min(1).optional() }).optional(),
        responseFormat: z.object({ default: z.enum(["json", "compact-tabular"]).optional() }).optional()
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
      return ok({ root: resolvedRoot, rules: await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).list() });
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
      const rule = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).add(input);
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
      const rule = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).update(id, update);
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
      const deleted = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).delete(id);
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
      const rules = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).list();
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
      const memories = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).search(`${task ?? ""}\n${text}`, 8);
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
      const rules = await new ArchitectureRuleStore(await repositoryRulesPath(resolvedRoot)).list();
      const memories = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).search(`${task ?? ""}\n${diffSummary ?? ""}\n${changedFiles.join("\n")}`, 8);
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
      const memories = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).list();
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
      const memories = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).list();
      const wiki = buildProjectWiki(project, memories, await listAppliedKnowledge(resolvedRoot));
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
      const memory = new MemoryStore(await repositoryMemoryPath(resolvedRoot));
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
      const memories = config.memoryEnabled ? await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).search(memoryQuery, config.maxMemories) : [];
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
      const entry = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).add({
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
      const memory = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).update(id, update);
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
      const deleted = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).delete(id, { hard: hard === true });
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
      const memory = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).deprecate(id, supersededBy ?? [], evidence ?? []);
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
      const memory = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).confirm(id, evidence ?? [], confidence ?? "high");
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
      const conflicts = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).findConflicts({ id, query, candidate, limit });
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
      const memory = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).link(id, links);
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
      const recall = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).recall(query ?? "", { limit, auditMode: auditMode === true });
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
      const memories = await new MemoryStore(await repositoryMemoryPath(resolvedRoot)).list();
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
      description: "Use this to compare the compact local index with an explicitly labeled full-index-dump baseline.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ root: z.string().optional() })
    },
    async ({ root }) => {
      const project = await ensureProject(await workspaceRoot(root));
      const baselineTokens = project.files.reduce((total, file) => total + file.estimatedTokens, 0);
      const compactTokens = estimateTokens(compactJson(projectMap(project)));
      return ok({
        baseline: "full-index-dump",
        baselineTokens,
        compactTokens,
        avoidedVsBaseline: Math.max(0, baselineTokens - compactTokens),
        unit: "estimated-tokens"
      });
    }
  );
  }

  return server;
}
