import { createHash } from "node:crypto";
import { resolveProjectImports, scanProject, scanProjectFile, scanProjectFileMetadata } from "./fileScanner.js";
import { mergeSqlGraphs, parsePostgresMigration } from "./sqlParser.js";
import type { CodeGraph, FileScanMetadata, ProjectIndex, ProjectScanMetadata, SqlGraph } from "./types.js";

export const CURRENT_INDEX_SCHEMA_VERSION = 3;

export interface IndexUpdateResult {
  index: ProjectIndex;
  mode: "full" | "incremental";
  addedFiles: string[];
  changedFiles: string[];
  deletedFiles: string[];
  parsedFiles: string[];
  fallbackReason?: string;
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

function buildProjectIndex(root: string, graph: CodeGraph, sql: SqlGraph, scanSignature: string, scanMetadata: ProjectScanMetadata): ProjectIndex {
  const fingerprint = fingerprintPayload({
    files: graph.files,
    symbols: graph.symbols,
    imports: graph.imports,
    exclusions: graph.exclusions,
    sql
  });

  return {
    ...graph,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    scannedAt: new Date().toISOString(),
    fingerprint,
    scanSignature,
    scanMetadata,
    frameworks: detectFrameworks(graph.files),
    sql
  };
}

export async function indexProject(root: string, options: { scanSignature?: string } = {}): Promise<ProjectIndex> {
  const metadata = await scanProjectFileMetadata(root);
  const sqlContents = new Map<string, string>();
  const graph = await scanProject(root, {
    onFileContent: (file) => {
      if (file.language === "sql") {
        sqlContents.set(file.path, file.content);
      }
    }
  });
  const sqlGraphs = [];
  for (const file of graph.files.filter((candidate) => candidate.language === "sql").sort((a, b) => a.path.localeCompare(b.path))) {
    const sql = sqlContents.get(file.path);
    if (sql === undefined) {
      continue;
    }
    sqlGraphs.push(parsePostgresMigration(file.path, sql));
  }

  return buildProjectIndex(root, graph, mergeSqlGraphs(sqlGraphs), options.scanSignature ?? metadata.scanSignature, scanMetadataFromFiles(metadata.files));
}

function metadataChanged(previous: FileScanMetadata | undefined, current: FileScanMetadata): boolean {
  return (
    !previous ||
    previous.size !== current.size ||
    previous.mtimeNs !== current.mtimeNs ||
    previous.ctimeNs !== current.ctimeNs ||
    previous.contentHash !== current.contentHash
  );
}

export async function updateProjectIndexIncremental(root: string, existingIndex: ProjectIndex): Promise<IndexUpdateResult> {
  if (existingIndex.root !== root) {
    return {
      index: await indexProject(root),
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
      index: await indexProject(root),
      mode: "full",
      addedFiles: [],
      changedFiles: [],
      deletedFiles: [],
      parsedFiles: [],
      fallbackReason: "Stored index schema metadata is incompatible with incremental indexing."
    };
  }

  const metadata = await scanProjectFileMetadata(root);
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
    const parsed = await scanProjectFile(root, fileMetadata);
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
    index: buildProjectIndex(root, graph, sql, metadata.scanSignature, scanMetadataFromFiles(metadata.files)),
    mode: "incremental",
    addedFiles,
    changedFiles,
    deletedFiles,
    parsedFiles: parsedPaths
  };
}
