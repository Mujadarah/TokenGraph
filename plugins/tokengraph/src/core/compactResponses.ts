import type {
  ChangeRiskReport,
  ContextCompressionReport,
  ContextPlan,
  FailureTraceReport,
  MemoryReview,
  MemoryEntry,
  ProjectWiki,
  ProjectIndex,
  RankedFile,
  RankedSqlObject
} from "./types.js";

export interface CompactResponseOptions {
  constraints?: string[];
  allowRawReads?: boolean;
  includeSql?: boolean;
  suggestedTests?: string[];
}

export const NO_RAW_READ_GUIDANCE = "Do not perform raw file reads; rely only on returned/indexed context and ask for an explicit policy change if evidence is insufficient.";

interface CompactFile {
  path: string;
  reason?: string;
}

export interface CompactCoreResponse {
  constraints: string[];
  files: CompactFile[];
  firstReads: number[];
  tests: string[];
  commands: string[];
  confidence: "low" | "medium" | "high";
  warnings?: string[];
  conflicts?: string[];
  rawReadGuidance?: string;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueVerbatim(values: string[]): string[] {
  return Array.from(new Set(values));
}

function compactFiles(files: Array<RankedFile | RankedSqlObject | CompactFile>): CompactFile[] {
  const selected = new Map<string, CompactFile>();
  for (const file of files) {
    const path = "path" in file ? file.path : file.filePath;
    const reason = compactReason(file.reason);
    if (!selected.has(path)) selected.set(path, { path, ...(reason ? { reason } : {}) });
  }
  return [...selected.values()];
}

function compactReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (/matches task terms/i.test(reason)) return undefined;
  if (/linked evidence/i.test(reason)) return "Memory evidence.";
  if (/imported by focused test/i.test(reason)) return "Test dependency.";
  if (/\b(table columns|policy on|index on|sql)\b/i.test(reason)) return "SQL evidence.";
  return reason.length <= 48 ? reason : `${reason.slice(0, 45).trimEnd()}...`;
}

function compactWarnings(warnings: string[]): string[] {
  return unique(warnings.map((warning) => {
    const count = warning.match(/^(\d+) lower-ranked .* excluded/i)?.[1];
    if (count) return `${count} lower-ranked item(s) omitted.`;
    if (/^manual review: tenant isolation changed or appears in affected sql/i.test(warning)) return "Review tenant isolation and affected SQL.";
    if (/^manual review: rls policy behavior is involved/i.test(warning)) return "Review RLS behavior.";
    if (/^manual review: audit logging behavior is involved/i.test(warning)) return "Review audit logging.";
    if (/^manual review: database migration changes can affect persisted data/i.test(warning)) return "Review migration data effects.";
    const omitted = warning.match(/^(\d+) non-critical line\(s\) omitted/i)?.[1];
    if (omitted) return `${omitted} non-critical line(s) omitted.`;
    if (/failure needs a targeted first read because no indexed path was detected/i.test(warning)) return "No indexed path detected; verify a targeted read.";
    return warning;
  }));
}

function firstReadIndices(files: CompactFile[], paths: string[], limit = 2): number[] {
  return unique(paths).map((path) => files.findIndex((file) => file.path === path)).filter((index) => index >= 0).slice(0, limit);
}

export function hasSqlIntent(task: string): boolean {
  return /\b(sql|database|table|migration|rls|policy|postgres|supabase|schema|index)\b/i.test(task) || /\b[a-z0-9_]+_(?:idx|pkey|fkey|key)\b/i.test(task);
}

function focusedSql(files: RankedSqlObject[], task: string): RankedSqlObject[] {
  if (!files.length) return [];
  const byPath = new Map<string, RankedSqlObject>();
  for (const file of files) {
    const current = byPath.get(file.filePath);
    if (!current || file.score > current.score) byPath.set(file.filePath, file);
  }
  const normalize = (term: string) => term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term;
  const terms = task.toLowerCase().match(/[a-z0-9]+/g)?.map(normalize).filter((term) => term.length >= 4 && !["review", "change", "policy", "migration", "database", "table", "tenant"].includes(term)) ?? [];
  const scored = [...byPath.values()].map((file) => ({
    file,
    lexical: terms.filter((term) => files.some((candidate) => {
      if (candidate.filePath !== file.filePath) return false;
      const candidateTerms = `${candidate.filePath} ${candidate.name}`.toLowerCase().match(/[a-z0-9]+/g)?.map(normalize) ?? [];
      return candidateTerms.includes(term);
    })).length
  }));
  if (scored.some((entry) => entry.lexical > 0)) return scored.filter((entry) => entry.lexical > 0).map((entry) => entry.file);
  const maximum = Math.max(...scored.map((entry) => entry.file.score));
  return scored.filter((entry) => entry.file.score === maximum).map((entry) => entry.file);
}

function guidance(allowRawReads = true, lowConfidence = false): string | undefined {
  if (!allowRawReads) return NO_RAW_READ_GUIDANCE;
  return lowConfidence
    ? "Low confidence: verify named evidence."
    : undefined;
}

export function testsExplicitlyLinkedToFiles(project: ProjectIndex, sourceFiles: string[]): string[] {
  const sources = new Set(sourceFiles);
  const tests = new Set(project.files.filter((file) => file.isTest).map((file) => file.path));
  return unique(project.imports
    .filter((edge) => tests.has(edge.filePath) && edge.resolvedPath !== undefined && sources.has(edge.resolvedPath))
    .map((edge) => edge.filePath));
}

function base(options: CompactResponseOptions, input: Partial<CompactCoreResponse>): CompactCoreResponse {
  const confidence = input.confidence ?? "medium";
  const rawReadGuidance = input.rawReadGuidance ?? guidance(options.allowRawReads, confidence === "low");
  const response: CompactCoreResponse = {
    constraints: uniqueVerbatim(options.constraints ?? []),
    files: input.files ?? [],
    firstReads: input.firstReads ?? [],
    tests: unique(input.tests ?? []),
    commands: unique(input.commands ?? []),
    confidence,
    ...(rawReadGuidance ? { rawReadGuidance } : {})
  };
  const warnings = compactWarnings(input.warnings ?? []);
  const conflicts = unique(input.conflicts ?? []);
  if (warnings.length) response.warnings = warnings;
  if (conflicts.length) response.conflicts = conflicts;
  return response;
}

export function compactModeEnvelope<T>(mode: string, result: T): T & { mode: string; result: T } {
  return { mode, result } as T & { mode: string; result: T };
}

export function compactCompressionEnvelope<T>(mode: string, result: T, estimates?: { original: number; compact: number; overhead: number }) {
  return estimates ? { mode, result, estimates } : result;
}

export function compactPrepareEnvelope<T>(input: {
  root: string;
  taskId: string;
  plan: T;
  routing?: unknown;
}) {
  return { taskId: input.taskId, plan: input.plan, ...(input.routing === undefined ? {} : { routing: input.routing }) };
}

export function compactPlanResponse(plan: ContextPlan, options: CompactResponseOptions = {}): CompactCoreResponse {
  const sql = hasSqlIntent(plan.task) ? focusedSql(plan.relevantSql, plan.task) : [];
  const files = compactFiles([...plan.recommendedFirstReads.slice(0, 3), ...plan.relevantTests, ...sql]);
  const tests = plan.relevantTests.map((test) => test.path);
  return base(options, {
    files,
    firstReads: firstReadIndices(files, plan.recommendedFirstReads.map((file) => file.path)),
    tests,
    commands: tests.map((test) => `pnpm test ${test}`),
    confidence: plan.recommendedFirstReads.length ? "high" : files.length ? "medium" : "low",
    warnings: plan.budgetExclusions,
    conflicts: [],
    rawReadGuidance: guidance(options.allowRawReads)
  });
}

export function compactFailureResponse(report: FailureTraceReport, options: CompactResponseOptions = {}): CompactCoreResponse {
  const tests = unique([
    ...(report.detectedTests ?? []),
    ...(report.relatedFiles ?? []).map((file) => file.path).filter((path) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path))
  ]);
  const warnings = [
    ...(report.hypotheses ?? []).map((hypothesis) => `${hypothesis.confidence} confidence hypothesis: ${hypothesis.statement}`)
  ];
  const files = compactFiles([
      ...(report.recommendedFirstReads ?? []),
      ...(report.relatedFiles ?? []).filter((file) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(file.path)),
      ...(options.includeSql ? focusedSql(report.relatedSql ?? [], "") : [])
    ]);
  return base(options, {
    files,
    firstReads: firstReadIndices(files, report.recommendedFirstReads.map((file) => file.path)),
    tests,
    commands: report.recommendedCommands,
    confidence: report.confidence,
    warnings,
    conflicts: [],
    rawReadGuidance: guidance(options.allowRawReads, report.confidence === "low")
  });
}

export function compactRiskResponse(report: ChangeRiskReport, options: CompactResponseOptions = {}): CompactCoreResponse {
  const files = compactFiles([...report.affectedFiles, ...report.affectedTests, ...report.affectedSql]);
  return base(options, {
    files,
    firstReads: firstReadIndices(files, [...report.affectedFiles, ...report.affectedTests].map((file) => file.path)),
    tests: report.affectedTests.map((test) => test.path),
    commands: report.recommendedTests,
    confidence: report.riskLevel,
    warnings: report.manualReviewWarnings,
    conflicts: report.affectedRules.map((finding) => finding.message)
  });
}

export function compactCompressionResponse(report: ContextCompressionReport, options: CompactResponseOptions = {}): CompactCoreResponse {
  const task = report.compressedTask.split("\n", 1)[0] ?? "";
  const firstReads = report.recommendedFirstReads.filter((file) => !file.path.endsWith(".sql"));
  const sqlReads = hasSqlIntent(task) ? report.recommendedFirstReads.filter((file) => file.path.endsWith(".sql")) : [];
  const taskTerms = task.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length >= 4 && !["review", "context", "policy", "migration", "security", "tenant"].includes(term)) ?? [];
  const sqlScores = sqlReads.map((file) => ({ file, score: taskTerms.filter((term) => file.path.toLowerCase().includes(term)).length }));
  const sqlMaximum = Math.max(0, ...sqlScores.map((entry) => entry.score));
  const selectedSql = sqlMaximum > 0 ? sqlScores.filter((entry) => entry.score === sqlMaximum).map((entry) => entry.file) : sqlReads.slice(0, 1);
  const selected = [...firstReads, ...selectedSql];
  const files = compactFiles(selected);
  return base(options, {
    files,
    firstReads: firstReadIndices(files, selected.map((file) => file.path)),
    tests: selected.map((file) => file.path).filter((path) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path)),
    commands: selected.map((file) => file.path).filter((path) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path)).map((path) => `pnpm test ${path}`),
    confidence: report.confidence,
    warnings: report.omissions.filter((warning) => /non-critical|low confidence|wiki page/i.test(warning)),
    conflicts: []
  });
}

export function compactRecallResponse(review: MemoryReview, options: CompactResponseOptions = {}, sourceMemories: MemoryEntry[] = [], project?: ProjectIndex): CompactCoreResponse & {
  memories: Array<{ id: string; title: string; confidence: string; action: string; reason: string }>;
} {
  const bestScore = Math.max(0, ...review.matches.map((match) => match.score));
  const relevantMatches = bestScore > 0 ? review.matches.filter((match) => match.score === bestScore) : review.matches.slice(0, 1);
  const memories = relevantMatches.map((match) => ({
    id: match.id, title: match.title, confidence: match.confidence, action: match.action, reason: match.reason
  }));
  const confidence = memories.some((memory) => memory.confidence === "low" || memory.action === "review") ? "low" : memories.length ? "medium" : "low";
  const matchedIds = new Set(relevantMatches.map((match) => match.id));
  const linkedFiles = compactFiles(sourceMemories
    .filter((memory) => matchedIds.has(memory.id))
    .flatMap((memory) => memory.linkedFiles.map((path) => ({ path, reason: `Linked evidence for recalled memory ${memory.title}.` }))));
  const tests = unique([...(options.suggestedTests ?? []), ...(project ? testsExplicitlyLinkedToFiles(project, linkedFiles.map((file) => file.path)) : [])]);
  return {
    ...base(options, {
      files: linkedFiles,
      firstReads: firstReadIndices(linkedFiles, linkedFiles.map((file) => file.path)),
      tests,
      commands: tests.map((test) => `pnpm test ${test}`),
      confidence,
      warnings: [review.policy],
      conflicts: relevantMatches.filter((match) => match.action === "review").map((match) => `${match.title}: ${match.reason}`)
    }),
    memories
  };
}

export function compactMemoryRecallResponse(sourceMemories: MemoryEntry[], options: CompactResponseOptions = {}): CompactCoreResponse & {
  memories: Array<{ id: string; type: string; title: string; confidence: string; status: string }>;
} {
  const files = compactFiles(sourceMemories.flatMap((memory) =>
    memory.linkedFiles.map((path) => ({ path, reason: `Linked evidence for recalled memory ${memory.title}.` }))
  ));
  return {
    ...base(options, {
      files,
      firstReads: firstReadIndices(files, files.map((file) => file.path)),
      confidence: sourceMemories.some((memory) => memory.confidence === "low") ? "low" : sourceMemories.length ? "medium" : "low",
      warnings: sourceMemories.some((memory) => memory.confidence === "low") ? ["Verify low-confidence memory evidence before reuse."] : []
    }),
    memories: sourceMemories.map(({ id, type, title, confidence, status }) => ({ id, type, title, confidence, status }))
  };
}

export function compactWikiResponse(wiki: ProjectWiki, options: CompactResponseOptions = {}): CompactCoreResponse & {
  pages: Array<{ slug: string; title: string; freshness: string; backlinks: string[] }>;
} {
  const pages = wiki.pages.map((page) => ({
    slug: page.slug, title: page.title, freshness: page.freshness ?? "fresh", backlinks: page.backlinks ?? []
  }));
  const stale = wiki.pages.filter((page) => page.freshness === "stale");
  return {
    ...base(options, {
      confidence: stale.length ? "low" : pages.length ? "medium" : "low",
      warnings: stale.map((page) => `Wiki page ${page.slug} is stale.`),
      conflicts: wiki.pages.flatMap((page) => (page.contradictions ?? []).map((conflict) => `${page.slug}: ${conflict}`))
    }),
    pages
  };
}
