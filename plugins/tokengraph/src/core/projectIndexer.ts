import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { resolveProjectImports, scanProject, scanProjectFile, scanProjectFileMetadata, type ScanBudget } from "./fileScanner.js";
import { mergeSqlGraphs, parsePostgresMigration } from "./sqlParser.js";
import type { CodeGraph, FileScanMetadata, ProjectIndex, ProjectScanMetadata, SqlGraph } from "./types.js";
import { buildSymbolChunks } from "./symbolChunks.js";
import { parseConfigurationDataBounded, type ConfigurationLimits } from "./configData.js";
import { getGitFileRecency, getRepositoryIdentity } from "./repositoryIdentity.js";
import { resolveConfinedPath } from "./storage.js";

export const CURRENT_INDEX_SCHEMA_VERSION = 4;

export interface IndexUpdateResult {
  index: ProjectIndex;
  mode: "full" | "incremental";
  addedFiles: string[];
  changedFiles: string[];
  deletedFiles: string[];
  parsedFiles: string[];
  fallbackReason?: string;
}

export interface ParserResourceLimits extends ConfigurationLimits, ScanBudget {
  maxTsconfigChain?: number;
  maxAliases?: number;
}

export interface ProjectIndexOptions {
  scanSignature?: string;
  parserLimits?: ParserResourceLimits;
  /** B7 parser activation remains opt-in until the B6 promotion gate has passed. */
  polyglotEnabled?: boolean;
}

function fingerprintPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function detectFrameworks(files: { path: string }[]): string[] {
  const frameworks = new Set<string>();
  if (files.some((file) => file.path.startsWith("app/") || file.path.startsWith("pages/"))) {
    frameworks.add("Next.js");
  }
  if (files.some((file) => file.path.endsWith(".tsx") || file.path.endsWith(".jsx"))) {
    frameworks.add("React");
  }
  if (files.some((file) => file.path.includes("supabase/") || file.path.endsWith(".sql"))) {
    frameworks.add("PostgreSQL/Supabase");
  }
  if (files.some((file) => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))) {
    frameworks.add("TypeScript");
  }
  return Array.from(frameworks).sort();
}

function unsupportedLanguageCounts(graph: CodeGraph): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const exclusion of graph.exclusions) {
    if (exclusion.reason !== "unsupported") continue;
    const extension = extname(exclusion.path).toLowerCase() || "<extensionless>";
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function scanMetadataFromFiles(files: FileScanMetadata[]): ProjectScanMetadata {
  return {
    files: Object.fromEntries(files.map((file) => [file.path, file]))
  };
}

function isCompatibleIndex(index: ProjectIndex): boolean {
  return index.schemaVersion === CURRENT_INDEX_SCHEMA_VERSION && Boolean(index.scanMetadata?.files);
}

function emptySqlGraph(): SqlGraph {
  return {
    tables: [],
    relations: [],
    constraints: [],
    policies: [],
    indexes: [],
    triggers: [],
    functions: [],
    views: [],
    enums: [],
    extensions: [],
    grants: [],
    materializedViews: [],
    history: [],
    warnings: []
  };
}

function sqlGraphForFiles(sql: SqlGraph, filePaths: Set<string>): SqlGraph {
  return {
    tables: sql.tables.filter((entry) => filePaths.has(entry.filePath)),
    relations: sql.relations.filter((entry) => filePaths.has(entry.filePath)),
    constraints: sql.constraints.filter((entry) => filePaths.has(entry.filePath)),
    policies: sql.policies.filter((entry) => filePaths.has(entry.filePath)),
    indexes: sql.indexes.filter((entry) => filePaths.has(entry.filePath)),
    triggers: sql.triggers.filter((entry) => filePaths.has(entry.filePath)),
    functions: sql.functions.filter((entry) => filePaths.has(entry.filePath)),
    views: sql.views.filter((entry) => filePaths.has(entry.filePath)),
    enums: sql.enums.filter((entry) => filePaths.has(entry.filePath)),
    extensions: sql.extensions.filter((entry) => filePaths.has(entry.filePath)),
    grants: sql.grants.filter((entry) => filePaths.has(entry.filePath)),
    materializedViews: sql.materializedViews.filter((entry) => filePaths.has(entry.filePath)),
    history: sql.history.filter((entry) => filePaths.has(entry.filePath)),
    warnings: sql.warnings.filter((entry) => filePaths.has(entry.filePath))
  };
}

function sortGraph(graph: CodeGraph): void {
  graph.files.sort((a, b) => a.path.localeCompare(b.path));
  graph.symbols.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
  graph.imports.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.source.localeCompare(b.source));
  graph.exclusions.sort((a, b) => a.path.localeCompare(b.path));
}

function configurationExtends(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || !("extends" in parsed)) return [];
  const value = (parsed as { extends?: unknown }).extends;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (value === undefined) return [];
  throw new Error("Configuration extends must be a string or an array of strings.");
}

function configurationAliasCount(parsed: unknown): number {
  if (!parsed || typeof parsed !== "object") return 0;
  const compilerOptions = (parsed as { compilerOptions?: unknown }).compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== "object") return 0;
  const paths = (compilerOptions as { paths?: unknown }).paths;
  return paths && typeof paths === "object" && !Array.isArray(paths) ? Object.keys(paths).length : 0;
}

async function validateTsconfigChain(
  root: string,
  configPath: string,
  parsed: unknown,
  limits: ParserResourceLimits | undefined,
  visited = new Set<string>(),
  depth = 1,
  aliases = { count: 0 }
): Promise<void> {
  const maxChain = limits?.maxTsconfigChain ?? 8;
  const maxAliases = limits?.maxAliases ?? 500;
  if (depth > maxChain) throw new Error("Configuration extends-chain limit exceeded.");
  const key = configPath.replaceAll("\\", "/").toLowerCase();
  if (visited.has(key)) throw new Error("Cyclic configuration extends chain detected.");
  visited.add(key);
  aliases.count += configurationAliasCount(parsed);
  if (aliases.count > maxAliases) throw new Error("Configuration path-alias limit exceeded.");

  for (const extended of configurationExtends(parsed)) {
    if (isAbsolute(extended) || !extended.startsWith(".")) {
      throw new Error("Only workspace-relative configuration extends entries are supported.");
    }
    const candidate = resolve(dirname(resolve(root, configPath)), extended);
    const withExtension = extname(candidate) ? candidate : `${candidate}.json`;
    const relativePath = relative(resolve(root), withExtension).replaceAll("\\", "/");
    const absolute = await resolveConfinedPath(root, relativePath);
    const source = await readFile(absolute, "utf8");
    const nested = await parseConfigurationDataBounded(source, limits);
    await validateTsconfigChain(root, relativePath, nested, limits, visited, depth + 1, aliases);
  }
  visited.delete(key);
}

async function configurationEvidence(root: string, limits?: ParserResourceLimits): Promise<NonNullable<ProjectIndex["configuration"]>> {
  const candidates = ["tsconfig.json", "jsconfig.json", ".eslintrc.json", ".prettierrc.json"];
  const evidence: NonNullable<ProjectIndex["configuration"]> = [];
  for (const path of candidates) {
    const absolute = `${root}/${path}`;
    try {
      await access(absolute);
      const source = await readFile(absolute, "utf8");
      const contentHash = createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex");
      try {
        const parsed = await parseConfigurationDataBounded(source, limits);
        if (path === "tsconfig.json" || path === "jsconfig.json") {
          await validateTsconfigChain(root, path, parsed, limits);
        }
        evidence.push({ path, status: "parsed", contentHash });
      } catch (error) {
        evidence.push({ path, status: "degraded", contentHash, reason: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") evidence.push({ path, status: "degraded", contentHash: "", reason: "unreadable" });
    }
  }
  return evidence;
}

async function buildProjectIndex(root: string, graph: CodeGraph, sql: SqlGraph, scanSignature: string, scanMetadata: ProjectScanMetadata, parserLimits?: ParserResourceLimits): Promise<ProjectIndex> {
  const [configuration, repositoryIdentity, retrievalSignals] = await Promise.all([
    configurationEvidence(root, parserLimits),
    getRepositoryIdentity(root),
    getGitFileRecency(root, graph.files.map((file) => file.path), 50)
  ]);
  const fingerprint = fingerprintPayload({
    files: graph.files,
    symbols: graph.symbols,
    imports: graph.imports,
    exclusions: graph.exclusions,
    sql,
    configuration,
    unsupportedLanguageCounts: unsupportedLanguageCounts(graph),
    retrievalSignals
  });

  return {
    ...graph,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    repositoryIdentity,
    scannedAt: new Date().toISOString(),
    fingerprint,
    scanSignature,
    scanMetadata,
    frameworks: detectFrameworks(graph.files),
    sql,
    symbolChunks: buildSymbolChunks(graph),
    unsupportedLanguageCounts: unsupportedLanguageCounts(graph),
    retrievalSignals,
    ...(configuration.length ? { configuration } : {})
  };
}

export async function indexProject(root: string, options: ProjectIndexOptions = {}): Promise<ProjectIndex> {
  const scanLimits: ScanBudget = {
    maxFileBytes: options.parserLimits?.maxFileBytes ?? options.parserLimits?.maxBytes,
    maxTotalBytes: options.parserLimits?.maxTotalBytes,
    maxSymbols: options.parserLimits?.maxSymbols,
    maxNodes: options.parserLimits?.maxNodes,
    perFileTimeoutMs: options.parserLimits?.perFileTimeoutMs ?? options.parserLimits?.timeoutMs,
    wholeIndexTimeoutMs: options.parserLimits?.wholeIndexTimeoutMs,
    maxDepth: options.parserLimits?.maxDepth,
    maxGeneratedFiles: options.parserLimits?.maxGeneratedFiles,
    polyglotEnabled: options.polyglotEnabled === true
  };
  const metadata = await scanProjectFileMetadata(root, scanLimits);
  const sqlContents = new Map<string, string>();
  const graph = await scanProject(root, {
    ...scanLimits,
    onFileContent: (file) => {
      if (file.language === "sql") {
        sqlContents.set(file.path, file.content);
      }
    }
  });
  for (const file of options.polyglotEnabled === true ? metadata.files.filter((candidate) => [".py", ".go", ".rs", ".java"].includes(candidate.extension)) : []) {
    const parsed = await scanProjectFile(root, file, scanLimits);
    if (parsed) {
      graph.symbols.push(...parsed.symbols);
      if (parsed.degradedReason) graph.exclusions.push({ path: file.path, reason: "budget" });
    }
  }
  graph.symbols.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name) || (a.startLine ?? 0) - (b.startLine ?? 0));
  const sqlGraphs = [];
  for (const file of graph.files.filter((candidate) => candidate.language === "sql").sort((a, b) => a.path.localeCompare(b.path))) {
    const sql = sqlContents.get(file.path);
    if (sql === undefined) {
      continue;
    }
    sqlGraphs.push(parsePostgresMigration(file.path, sql));
  }

  return buildProjectIndex(root, graph, mergeSqlGraphs(sqlGraphs), options.scanSignature ?? metadata.scanSignature, scanMetadataFromFiles(metadata.files), options.parserLimits);
}

function metadataChanged(previous: FileScanMetadata | undefined, current: FileScanMetadata): boolean {
  return !previous || previous.contentHash !== current.contentHash || previous.language !== current.language || previous.extension !== current.extension;
}

export async function updateProjectIndexIncremental(root: string, existingIndex: ProjectIndex, options: Omit<ProjectIndexOptions, "scanSignature"> = {}): Promise<IndexUpdateResult> {
  const scanLimits: ScanBudget = {
    maxFileBytes: options.parserLimits?.maxFileBytes ?? options.parserLimits?.maxBytes,
    maxTotalBytes: options.parserLimits?.maxTotalBytes,
    maxSymbols: options.parserLimits?.maxSymbols,
    maxNodes: options.parserLimits?.maxNodes,
    perFileTimeoutMs: options.parserLimits?.perFileTimeoutMs ?? options.parserLimits?.timeoutMs,
    wholeIndexTimeoutMs: options.parserLimits?.wholeIndexTimeoutMs,
    maxDepth: options.parserLimits?.maxDepth,
    maxGeneratedFiles: options.parserLimits?.maxGeneratedFiles,
    polyglotEnabled: options.polyglotEnabled === true
  };
  if (existingIndex.root !== root) {
    return {
      index: await indexProject(root, options),
      mode: "full",
      addedFiles: [],
      changedFiles: [],
      deletedFiles: [],
      parsedFiles: [],
      fallbackReason: "Stored index root does not match requested root."
    };
  }
  if (!isCompatibleIndex(existingIndex)) {
    return {
      index: await indexProject(root, options),
      mode: "full",
      addedFiles: [],
      changedFiles: [],
      deletedFiles: [],
      parsedFiles: [],
      fallbackReason: "Stored index schema metadata is incompatible with incremental indexing."
    };
  }

  const metadata = await scanProjectFileMetadata(root, scanLimits);
  const currentByPath = new Map(metadata.files.map((file) => [file.path, file]));
  const previousMetadata = existingIndex.scanMetadata?.files ?? {};
  const previousPaths = new Set(existingIndex.files.map((file) => file.path));
  const currentPaths = new Set(currentByPath.keys());
  const addedFiles = metadata.files.filter((file) => !previousPaths.has(file.path)).map((file) => file.path).sort();
  const changedFiles = metadata.files
    .filter((file) => previousPaths.has(file.path) && metadataChanged(previousMetadata[file.path], file))
    .map((file) => file.path)
    .sort();
  const deletedFiles = Array.from(previousPaths).filter((path) => !currentPaths.has(path)).sort();
  const parsedPaths = [...new Set([...addedFiles, ...changedFiles])].sort();
  const parsedFiles = [];
  const parsedSqlGraphs = [];
  const parsedPathSet = new Set(parsedPaths);
  const deletedPathSet = new Set(deletedFiles);
  const unchangedPathSet = new Set(Array.from(currentPaths).filter((path) => !parsedPathSet.has(path)));

  for (const path of parsedPaths) {
    const fileMetadata = currentByPath.get(path);
    if (!fileMetadata) {
      continue;
    }
    const parsed = await scanProjectFile(root, fileMetadata, scanLimits);
    if (!parsed) {
      continue;
    }
    parsedFiles.push(parsed);
    if (parsed.file.language === "sql") {
      parsedSqlGraphs.push(parsePostgresMigration(parsed.file.path, parsed.content));
    }
  }

  const graph: CodeGraph = {
    root,
    files: [
      ...existingIndex.files.filter((file) => unchangedPathSet.has(file.path) && !deletedPathSet.has(file.path)),
      ...parsedFiles.map((entry) => entry.file)
    ],
    symbols: [
      ...existingIndex.symbols.filter((symbol) => unchangedPathSet.has(symbol.filePath) && !deletedPathSet.has(symbol.filePath)),
      ...parsedFiles.flatMap((entry) => entry.symbols)
    ],
    imports: [
      ...existingIndex.imports
        .filter((edge) => unchangedPathSet.has(edge.filePath) && !deletedPathSet.has(edge.filePath))
        .map((edge) => ({ filePath: edge.filePath, source: edge.source })),
      ...parsedFiles.flatMap((entry) => entry.imports)
    ],
    exclusions: metadata.exclusions
  };
  resolveProjectImports(root, graph);
  sortGraph(graph);

  const sql = mergeSqlGraphs([
    sqlGraphForFiles(existingIndex.sql ?? emptySqlGraph(), unchangedPathSet),
    ...parsedSqlGraphs
  ]);
  return {
    index: await buildProjectIndex(root, graph, sql, metadata.scanSignature, scanMetadataFromFiles(metadata.files), options.parserLimits),
    mode: "incremental",
    addedFiles,
    changedFiles,
    deletedFiles,
    parsedFiles: parsedPaths
  };
}
