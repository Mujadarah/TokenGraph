import { checkArchitecture } from "./architectureRules.js";
import { estimateSavings, tokenize } from "./token.js";
import type {
  ArchitectureFinding,
  ArchitectureRule,
  ChangeRiskReport,
  ImportEdge,
  MemoryEntry,
  ProjectIndex,
  RankedFile,
  RankedSqlObject,
  TokenSavingProfile
} from "./types.js";

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function importTarget(edge: ImportEdge): string | undefined {
  return edge.resolvedPath;
}

function fileScore(path: string, reason: string, score: number): RankedFile {
  return { path, reason, score };
}

function isRouteFile(project: ProjectIndex, path: string): boolean {
  const file = project.files.find((candidate) => candidate.path === path);
  return Boolean(file?.route) || /^(app|pages)\//.test(path);
}

function routeLabel(project: ProjectIndex, path: string): string | undefined {
  const file = project.files.find((candidate) => candidate.path === path);
  if (file?.route) return file.route;
  const appMatch = path.match(/^app\/(.+)\/page\.[tj]sx?$/);
  if (appMatch?.[1]) return `/${appMatch[1].replace(/\/\([^/]+\)/g, "").replace(/\/$/, "")}`;
  const pagesMatch = path.match(/^pages\/(.+)\.[tj]sx?$/);
  if (pagesMatch?.[1]) return `/${pagesMatch[1].replace(/\/index$/, "")}`;
  return undefined;
}

function relatedCode(project: ProjectIndex, changedFiles: string[], task = ""): {
  affectedFiles: RankedFile[];
  affectedRoutes: string[];
  affectedTests: RankedFile[];
  inbound: ImportEdge[];
  outbound: ImportEdge[];
} {
  const changed = new Set(changedFiles);
  const inbound = project.imports.filter((edge) => {
    const target = importTarget(edge);
    return target !== undefined && changed.has(target);
  });
  const outbound = project.imports.filter((edge) => changed.has(edge.filePath));
  const rows: RankedFile[] = changedFiles.map((path) => fileScore(path, "Changed file.", 100));

  for (const edge of inbound) {
    rows.push(fileScore(edge.filePath, `Imports changed file ${edge.resolvedPath}.`, isRouteFile(project, edge.filePath) ? 90 : 75));
  }
  for (const edge of outbound) {
    if (edge.resolvedPath) {
      rows.push(fileScore(edge.resolvedPath, `Imported by changed file ${edge.filePath}.`, 45));
    }
  }

  const changedBases = changedFiles.map((path) => path.replace(/\.[^.]+$/, ""));
  const normalize = (term: string) => term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term;
  const taskTerms = new Set(tokenize(task).flatMap((term) => term.split(/[_/.$\[\]-]+/)).map(normalize).filter((term) => term.length >= 4 && !["asses", "change", "risk", "policy", "migration", "tenant"].includes(term)));
  const affectedTests = project.files
    .filter((file) => {
      if (!file.isTest) return false;
      if (changed.has(file.path)) return true;
      const importsChanged = project.imports.some((edge) => edge.filePath === file.path && edge.resolvedPath !== undefined && changed.has(edge.resolvedPath));
      const nameMatches = changedBases.some((base) => file.path.includes(base));
      const testTerms = new Set(tokenize(file.path).flatMap((term) => term.split(/[_/.$\[\]-]+/)).map(normalize));
      const taskMatches = [...taskTerms].some((term) => testTerms.has(term));
      return importsChanged || nameMatches || taskMatches;
    })
    .map((file) => fileScore(file.path, "Test is linked to a changed file.", 85));

  const routePaths = unique([...changedFiles, ...inbound.map((edge) => edge.filePath)].map((path) => routeLabel(project, path)).filter((route): route is string => Boolean(route)));
  const seen = new Set<string>();
  return {
    affectedFiles: rows
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .filter((row) => {
        if (seen.has(row.path)) return false;
        seen.add(row.path);
        return true;
      })
      .slice(0, 20),
    affectedRoutes: routePaths,
    affectedTests,
    inbound,
    outbound
  };
}

function sqlTextForObject(object: RankedSqlObject): string {
  return `${object.kind} ${object.name} ${object.reason} ${object.filePath}`;
}

function relatedSql(project: ProjectIndex, changedFiles: string[], text: string): RankedSqlObject[] {
  const changed = new Set(changedFiles);
  const terms = tokenize(text);
  const scoreTerms = (value: string) => terms.reduce((score, term) => score + (value.toLowerCase().includes(term) ? 1 : 0), 0);
  const rows: RankedSqlObject[] = [
    ...project.sql.tables.map((table) => ({
      kind: "table" as const,
      name: table.name,
      filePath: table.filePath,
      reason: `Columns: ${table.columns.join(", ")}`,
      score: (changed.has(table.filePath) ? 80 : 0) + scoreTerms(`${table.name} ${table.columns.join(" ")}`)
    })),
    ...project.sql.policies.map((policy) => ({
      kind: "policy" as const,
      name: policy.name,
      filePath: policy.filePath,
      reason: `Policy on ${policy.table}${policy.command ? ` for ${policy.command}` : ""}`,
      score: (changed.has(policy.filePath) ? 80 : 0) + scoreTerms(`${policy.name} ${policy.table} ${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`)
    })),
    ...project.sql.grants.map((grant) => ({
      kind: "grant" as const,
      name: grant.objectName,
      filePath: grant.filePath,
      reason: `Grant ${grant.privileges.join(", ")} to ${grant.grantee}`,
      score: (changed.has(grant.filePath) ? 80 : 0) + scoreTerms(`${grant.objectName} ${grant.grantee} ${grant.privileges.join(" ")}`)
    })),
    ...project.sql.functions.map((fn) => ({
      kind: "function" as const,
      name: fn.name,
      filePath: fn.filePath,
      reason: "SQL function may affect database behavior.",
      score: (changed.has(fn.filePath) ? 70 : 0) + scoreTerms(fn.name)
    })),
    ...project.sql.triggers.map((trigger) => ({
      kind: "trigger" as const,
      name: trigger.name,
      filePath: trigger.filePath,
      reason: `Trigger on ${trigger.table}${trigger.functionName ? ` executes ${trigger.functionName}` : ""}`,
      score: (changed.has(trigger.filePath) ? 70 : 0) + scoreTerms(`${trigger.name} ${trigger.table} ${trigger.functionName ?? ""}`)
    })),
    ...project.sql.materializedViews.map((view) => ({
      kind: "materializedView" as const,
      name: view.name,
      filePath: view.filePath,
      reason: "Materialized view may require refresh or dependent query review.",
      score: (changed.has(view.filePath) ? 60 : 0) + scoreTerms(view.name)
    }))
  ];
  const byKey = new Map<string, RankedSqlObject>();
  for (const row of rows.filter((row) => row.score > 0)) {
    byKey.set(`${row.kind}:${row.name}:${row.filePath}`, row);
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score || sqlTextForObject(a).localeCompare(sqlTextForObject(b))).slice(0, 20);
}

function filterRuleFindings(findings: ArchitectureFinding[], changedFiles: string[]): ArchitectureFinding[] {
  const changed = new Set(changedFiles);
  return findings.filter((finding) => {
    if (!finding.filePath && !finding.targetPath) return Boolean(finding.sourcePath);
    return (finding.filePath !== undefined && changed.has(finding.filePath)) || (finding.targetPath !== undefined && changed.has(finding.targetPath));
  });
}

function relatedMemories(memories: MemoryEntry[], text: string): MemoryEntry[] {
  const terms = tokenize(text);
  return memories
    .map((memory) => {
      const haystack = tokenize(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")}`);
      const score =
        (memory.type === "bug" ? 4 : 0) +
        (memory.tags.some((tag) => /fragile|bug|risk|regression/i.test(tag)) ? 3 : 0) +
        terms.reduce((total, term) => total + (haystack.some((part) => part.includes(term) || term.includes(part)) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
    .slice(0, 8)
    .map((entry) => entry.memory);
}

function reviewWarnings(input: {
  changedFiles: string[];
  text: string;
  affectedSql: RankedSqlObject[];
  affectedRoutes: string[];
  affectedRules: ArchitectureFinding[];
  affectedMemories: MemoryEntry[];
}): string[] {
  const text = `${input.text} ${input.affectedSql.map(sqlTextForObject).join(" ")}`.toLowerCase();
  const warnings: string[] = [];
  if (/tenant|tenant_id/.test(text)) warnings.push("Manual review: tenant isolation changed or appears in affected SQL.");
  if (/\brls\b|policy|using\s*\(/.test(text)) warnings.push("Manual review: RLS policy behavior is involved.");
  if (/auth|authenticated|auth\.uid/.test(text)) warnings.push("Manual review: auth-sensitive behavior is involved.");
  if (/audit/.test(text)) warnings.push("Manual review: audit logging behavior is involved.");
  if (input.changedFiles.some((path) => /migration|supabase|sql/i.test(path))) warnings.push("Manual review: database migration changes can affect persisted data.");
  if (input.affectedRoutes.length > 0) warnings.push("Manual review: user-facing route exposure is affected.");
  if (input.affectedRules.length > 0) warnings.push("Manual review: architecture rule findings overlap changed files.");
  if (input.affectedMemories.some((memory) => memory.type === "bug")) warnings.push("Manual review: known bug memories match this change.");
  return unique(warnings);
}

function riskScore(input: {
  changedFiles: string[];
  inboundCount: number;
  outboundCount: number;
  routeCount: number;
  testCount: number;
  sqlCount: number;
  ruleCount: number;
  memoryCount: number;
  warningCount: number;
}): number {
  const score =
    input.changedFiles.length * 8 +
    Math.min(input.inboundCount * 10, 30) +
    Math.min(input.outboundCount * 5, 15) +
    input.routeCount * 15 +
    input.sqlCount * 8 +
    input.ruleCount * 12 +
    input.memoryCount * 8 +
    input.warningCount * 5 -
    Math.min(input.testCount * 4, 12);
  return Math.max(0, Math.min(100, score));
}

function riskLevel(score: number): ChangeRiskReport["riskLevel"] {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function recommendedTests(tests: RankedFile[]): string[] {
  return unique(tests.map((test) => `pnpm test -- ${test.path}`)).slice(0, 10);
}

export async function assessChangeRisk(input: {
  root: string;
  changedFiles: string[];
  diffSummary?: string;
  task?: string;
  profile?: TokenSavingProfile;
  project: ProjectIndex;
  rules: ArchitectureRule[];
  memories: MemoryEntry[];
}): Promise<ChangeRiskReport> {
  const changedFiles = unique(input.changedFiles.map((path) => path.replace(/\\/g, "/"))).filter((path) => path.length > 0);
  const text = [input.task, input.diffSummary, changedFiles.join(" ")].filter(Boolean).join("\n");
  const code = relatedCode(input.project, changedFiles, input.task);
  const sql = relatedSql(input.project, changedFiles, text);
  const architecture = await checkArchitecture({ root: input.root, project: input.project, rules: input.rules, files: changedFiles });
  const ruleFindings = filterRuleFindings([...architecture.violations, ...architecture.warnings], changedFiles).slice(0, 20);
  const memories = relatedMemories(input.memories, text);
  const warnings = reviewWarnings({
    changedFiles,
    text,
    affectedSql: sql,
    affectedRoutes: code.affectedRoutes,
    affectedRules: ruleFindings,
    affectedMemories: memories
  });
  const score = riskScore({
    changedFiles,
    inboundCount: code.inbound.length,
    outboundCount: code.outbound.length,
    routeCount: code.affectedRoutes.length,
    testCount: code.affectedTests.length,
    sqlCount: sql.length,
    ruleCount: ruleFindings.length,
    memoryCount: memories.length,
    warningCount: warnings.length
  });
  const baselineText = `${text}\n${input.project.files.map((file) => file.path).join("\n")}\n${input.memories.map((memory) => `${memory.title}\n${memory.body}`).join("\n")}`;
  const compactText = [
    changedFiles.join("\n"),
    code.affectedFiles.map((file) => `${file.path}: ${file.reason}`).join("\n"),
    sql.map(sqlTextForObject).join("\n"),
    warnings.join("\n")
  ].join("\n");
  return {
    riskScore: score,
    riskLevel: riskLevel(score),
    affectedFiles: code.affectedFiles,
    affectedRoutes: code.affectedRoutes,
    affectedTests: code.affectedTests,
    affectedSql: sql,
    affectedRules: ruleFindings,
    affectedMemories: memories,
    recommendedTests: recommendedTests(code.affectedTests),
    manualReviewWarnings: warnings,
    tokenEstimate: estimateSavings(baselineText, compactText, "task-files-and-memories")
  };
}
