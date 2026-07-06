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
  reason: "dependency" | "build-output" | "secret" | "binary" | "large-file" | "hidden" | "unsupported" | "ignored" | "budget";
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

export interface SqlConstraint {
  name: string;
  table: string;
  kind: "primary key" | "foreign key" | "unique" | "check" | "exclude" | "constraint";
  columns?: string[];
  expression?: string;
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
  roles?: string[];
  usingExpression?: string;
  checkExpression?: string;
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

export interface SqlEnum {
  name: string;
  values: string[];
  filePath: string;
}

export interface SqlExtension {
  name: string;
  filePath: string;
}

export interface SqlGrant {
  privileges: string[];
  objectType?: string;
  objectName: string;
  grantee: string;
  filePath: string;
}

export interface SqlMaterializedView {
  name: string;
  filePath: string;
}

export interface SqlHistoryEntry {
  kind:
    | "table"
    | "constraint"
    | "policy"
    | "index"
    | "trigger"
    | "function"
    | "view"
    | "enum"
    | "extension"
    | "grant"
    | "materializedView";
  name: string;
  action: "create" | "alter" | "grant";
  filePath: string;
  order: number;
}

export interface SqlGraph {
  tables: SqlTable[];
  relations: SqlRelation[];
  constraints: SqlConstraint[];
  policies: SqlPolicy[];
  indexes: SqlIndex[];
  triggers: SqlTrigger[];
  functions: SqlFunction[];
  views: SqlView[];
  enums: SqlEnum[];
  extensions: SqlExtension[];
  grants: SqlGrant[];
  materializedViews: SqlMaterializedView[];
  history: SqlHistoryEntry[];
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
  kind:
    | "table"
    | "constraint"
    | "policy"
    | "index"
    | "trigger"
    | "function"
    | "view"
    | "enum"
    | "extension"
    | "grant"
    | "materializedView";
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

export interface MemoryReviewMatch {
  id: string;
  type: MemoryType;
  title: string;
  tags: string[];
  createdAt: string;
  score: number;
  matchedTerms: string[];
  action: "keep" | "review";
  reason: string;
}

export interface MemoryReview {
  query: string;
  totalMemories: number;
  matches: MemoryReviewMatch[];
  policy: string;
}

export interface ProjectMapExport {
  format: "mermaid" | "json";
  root: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  content: string;
}
