export type TokenSavingProfile = "conservative" | "balanced" | "aggressive";

export interface TokenGraphConfig {
  tokenSavingProfile: TokenSavingProfile;
  maxFiles: number;
  maxSqlObjects: number;
  maxMemories: number;
  maxPlannedContextTokens: number;
  rawReadWarningThreshold: number;
  sqlIndexingEnabled: boolean;
  memoryEnabled: boolean;
  wikiGenerationEnabled: boolean;
}

export type TokenGraphConfigUpdate = Partial<Omit<TokenGraphConfig, "tokenSavingProfile">> & {
  tokenSavingProfile?: TokenSavingProfile;
};

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
  reason: "dependency" | "build-output" | "secret" | "binary" | "large-file" | "hidden" | "unsupported" | "ignored" | "budget" | "unreadable" | "symlink";
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

export interface SqlParseWarning {
  filePath: string;
  message: string;
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
  warnings: SqlParseWarning[];
}

export interface ProjectIndex extends CodeGraph {
  schemaVersion?: number;
  scannedAt: string;
  fingerprint: string;
  scanSignature?: string;
  scanMetadata?: ProjectScanMetadata;
  frameworks: string[];
  sql: SqlGraph;
}

export interface WikiPage {
  slug: string;
  title: string;
  body: string;
  estimatedTokens: number;
  sourceFingerprints?: string[];
  backlinks?: string[];
  contradictions?: string[];
  freshness?: "fresh" | "stale";
}

export interface ProjectWiki {
  schemaVersion: number;
  fingerprint: string;
  pages: WikiPage[];
}

export interface FileScanMetadata {
  path: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  contentHash: string;
  language: string;
  extension: string;
  route?: string;
  isTest: boolean;
}

export interface ProjectScanMetadata {
  files: Record<string, FileScanMetadata>;
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
  storedScanSignature?: string;
  currentScanSignature?: string;
}

export type MemoryType = "architecture" | "convention" | "bug" | "migration" | "product" | "security" | "lesson";
export type MemoryStatus = "active" | "deprecated" | "deleted";
export type MemoryConfidence = "low" | "medium" | "high";

export type ArchitectureRuleType =
  | "forbidden-import"
  | "required-import"
  | "dependency-direction"
  | "naming-convention"
  | "required-test"
  | "security"
  | "rls"
  | "tenant-isolation"
  | "audit-logging"
  | "release-packaging";

export type ArchitectureRuleSeverity = "info" | "warning" | "error";

export interface ArchitectureRuleInput {
  type: ArchitectureRuleType;
  name: string;
  description?: string;
  enabled?: boolean;
  severity?: ArchitectureRuleSeverity;
  fromPattern?: string;
  targetPattern?: string;
  allowedTargetPattern?: string;
  modulePattern?: string;
  testPattern?: string;
  namePattern?: string;
  sqlPattern?: string;
  message?: string;
}

export interface ArchitectureRule extends ArchitectureRuleInput {
  id: string;
  enabled: boolean;
  severity: ArchitectureRuleSeverity;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureFinding {
  type: ArchitectureRuleType | "marketplace-target" | "tenant-isolation" | "rls" | "grant" | "auth" | "audit-logging";
  severity: ArchitectureRuleSeverity;
  message: string;
  ruleId?: string;
  ruleName?: string;
  filePath?: string;
  targetPath?: string;
  importSource?: string;
  sqlObject?: string;
  sourcePath?: string;
  evidence?: string[];
}

export interface ArchitectureCheckReport {
  status: "checked";
  root: string;
  ruleCount: number;
  checkedFiles: string[];
  violations: ArchitectureFinding[];
  warnings: ArchitectureFinding[];
}

export type FailureTraceKind = "test" | "build" | "runtime" | "install" | "log";

export interface FailureHypothesis {
  label: "hypothesis";
  statement: string;
  confidence: "low" | "medium" | "high";
  evidence: string[];
}

export interface FailureTraceReport {
  compressedOutput: CompressedOutput;
  detectedPaths: string[];
  detectedSymbols: string[];
  detectedTests: string[];
  relatedFiles: RankedFile[];
  relatedImports: ImportEdge[];
  relatedSql: RankedSqlObject[];
  relatedMemories: MemoryEntry[];
  hypotheses: FailureHypothesis[];
  recommendedFirstReads: RankedFile[];
  recommendedCommands: string[];
  confidence: "low" | "medium" | "high";
  tokenEstimate: TokenEstimate;
}

export type ChangeRiskLevel = "low" | "medium" | "high";

export interface ChangeRiskReport {
  riskScore: number;
  riskLevel: ChangeRiskLevel;
  affectedFiles: RankedFile[];
  affectedRoutes: string[];
  affectedTests: RankedFile[];
  affectedSql: RankedSqlObject[];
  affectedRules: ArchitectureFinding[];
  affectedMemories: MemoryEntry[];
  recommendedTests: string[];
  manualReviewWarnings: string[];
  tokenEstimate: TokenEstimate;
}

export interface MemoryInput {
  type: MemoryType;
  title: string;
  body: string;
  tags: string[];
  status?: MemoryStatus;
  linkedFiles?: string[];
  linkedSymbols?: string[];
  linkedSqlObjects?: string[];
  linkedRules?: string[];
  confidence?: MemoryConfidence;
  supersedes?: string[];
  supersededBy?: string[];
  source?: string;
  evidence?: string[];
  lastUsedAt?: string;
  confirmedAt?: string;
}

export interface MemoryEntry extends MemoryInput {
  id: string;
  createdAt: string;
  status: MemoryStatus;
  updatedAt: string;
  lastUsedAt?: string;
  confirmedAt?: string;
  linkedFiles: string[];
  linkedSymbols: string[];
  linkedSqlObjects: string[];
  linkedRules: string[];
  confidence: MemoryConfidence;
  supersedes: string[];
  supersededBy: string[];
  source: string;
  evidence: string[];
}

export interface MemoryUpdateInput {
  type?: MemoryType;
  title?: string;
  body?: string;
  tags?: string[];
  status?: MemoryStatus;
  linkedFiles?: string[];
  linkedSymbols?: string[];
  linkedSqlObjects?: string[];
  linkedRules?: string[];
  confidence?: MemoryConfidence;
  supersedes?: string[];
  supersededBy?: string[];
  source?: string;
  evidence?: string[];
  lastUsedAt?: string;
  confirmedAt?: string;
}

export interface MemoryConflict {
  memory: MemoryEntry;
  matchedTerms: string[];
  reason: string;
}

export interface MemoryRecall {
  query: string;
  auditMode: boolean;
  memories: MemoryEntry[];
  policy: string;
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
  profile?: TokenSavingProfile;
  maxFiles?: number;
  maxSqlObjects?: number;
  maxMemories?: number;
  firstReads?: number;
  maxEstimatedTokens?: number;
  rawReadWarningThreshold?: number;
  allowRawReads?: boolean;
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
  profile: TokenSavingProfile;
  budget: Required<Omit<ContextBudget, "profile">> & { profile: TokenSavingProfile };
  relevantMemories: MemoryEntry[];
  relevantFiles: RankedFile[];
  relevantTests: RankedFile[];
  relevantSql: RankedSqlObject[];
  recommendedFirstReads: RankedFile[];
  filesToAvoid: RankedFile[];
  budgetExclusions: string[];
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

export type ContextCompressionKind = "prompt" | "memory" | "diff" | "sql" | "wiki" | "mixed";

export interface WikiReference {
  slug: string;
  title: string;
  reason: string;
  estimatedTokens: number;
}

export interface ContextCompressionInput {
  root: string;
  task: string;
  contentKind: ContextCompressionKind;
  text?: string;
  profile?: TokenSavingProfile;
  preserveRawReferences?: boolean;
  project: ProjectIndex;
  memories: MemoryEntry[];
  wiki?: ProjectWiki;
}

export interface ContextCompressionReport {
  compressedTask: string;
  preservedConstraints: string[];
  referencedMemories: MemoryEntry[];
  referencedWikiPages: WikiReference[];
  recommendedFirstReads: RankedFile[];
  omissions: string[];
  confidence: "low" | "medium" | "high";
  estimatedTokens: TokenEstimate;
}

export interface MemoryReviewMatch {
  id: string;
  type: MemoryType;
  title: string;
  tags: string[];
  createdAt: string;
  status: MemoryStatus;
  confidence: MemoryConfidence;
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
  resourceLinks: Array<{
    label: string;
    uri: string;
    mimeType: string;
  }>;
  markdownFallback: string;
}
