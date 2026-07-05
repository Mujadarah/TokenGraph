export type TokenSavingProfile = "conservative" | "balanced" | "aggressive";

export type TaskType = "bug" | "feature" | "refactor" | "database" | "test" | "docs" | "architecture";

export type FileKind = "module" | "next-route" | "react-component" | "test" | "sql" | "doc";

export interface TokenEstimate {
  original: number;
  compressed: number;
  avoided: number;
}

export interface CodeFile {
  path: string;
  kind: FileKind;
  language: string;
  size: number;
  estimatedTokens: number;
  contentHash: string;
  route?: string;
  isTest: boolean;
}

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "component" | "const" | "type" | "interface";
  filePath: string;
  exported: boolean;
  startLine?: number;
  endLine?: number;
}

export interface ImportEdge {
  filePath: string;
  source: string;
  resolvedPath?: string;
}

export interface Exclusion {
  path: string;
  reason: "dependency" | "build-output" | "secret" | "binary" | "large-file" | "hidden" | "unsupported" | "ignored";
}

export interface CodeGraph {
  root: string;
  files: CodeFile[];
  symbols: CodeSymbol[];
  imports: ImportEdge[];
  exclusions: Exclusion[];
}

export interface SqlTable {
  name: string;
  columns: string[];
  filePath: string;
}

export interface SqlRelation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn?: string;
  filePath: string;
}

export interface SqlPolicy {
  name: string;
  table: string;
  command?: string;
  filePath: string;
}

export interface SqlIndex {
  name: string;
  table: string;
  columns: string[];
  filePath: string;
}

export interface SqlTrigger {
  name: string;
  table: string;
  functionName?: string;
  filePath: string;
}

export interface SqlFunction {
  name: string;
  filePath: string;
}

export interface SqlView {
  name: string;
  filePath: string;
}

export interface SqlGraph {
  tables: SqlTable[];
  relations: SqlRelation[];
  policies: SqlPolicy[];
  indexes: SqlIndex[];
  triggers: SqlTrigger[];
  functions: SqlFunction[];
  views: SqlView[];
}

export interface ProjectIndex extends CodeGraph {
  scannedAt: string;
  fingerprint: string;
  frameworks: string[];
  sql: SqlGraph;
}

export type IndexState = "missing" | "fresh" | "stale";

export interface IndexStatus {
  root: string;
  state: IndexState;
  hasIndex: boolean;
  storedScannedAt?: string;
  currentScannedAt: string;
  storedFingerprint?: string;
  currentFingerprint: string;
}

export type MemoryType = "architecture" | "convention" | "bug" | "migration" | "product" | "security" | "lesson";

export interface MemoryInput {
  type: MemoryType;
  title: string;
  body: string;
  tags: string[];
}

export interface MemoryEntry extends MemoryInput {
  id: string;
  createdAt: string;
}

export interface RankedFile {
  path: string;
  reason: string;
  score: number;
  startLine?: number;
  endLine?: number;
}

export interface RankedSqlObject {
  kind: "table" | "policy" | "index" | "trigger" | "function" | "view";
  name: string;
  filePath: string;
  reason: string;
  score: number;
}

export interface ContextBudget {
  maxFiles: number;
  maxSqlObjects: number;
  maxMemories: number;
}

export interface ContextPlanInput {
  root: string;
  task: string;
  project: ProjectIndex;
  memories: MemoryEntry[];
  budget: ContextBudget;
}

export interface ContextPlan {
  task: string;
  taskType: TaskType;
  relevantMemories: MemoryEntry[];
  relevantFiles: RankedFile[];
  relevantTests: RankedFile[];
  relevantSql: RankedSqlObject[];
  recommendedFirstReads: RankedFile[];
  filesToAvoid: RankedFile[];
  rawReadPolicy: string;
  estimatedTokens: TokenEstimate;
}

export interface CompressedOutput {
  kind: "test" | "build" | "install" | "diff" | "log";
  summary: string;
  keyLines: string[];
  omittedLineCount: number;
  estimatedTokens: TokenEstimate;
}
