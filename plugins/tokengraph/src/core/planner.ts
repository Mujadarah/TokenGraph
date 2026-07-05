import { estimateSavings, estimateTokens, tokenize } from "./token.js";
import type {
  CodeFile,
  ContextPlan,
  ContextPlanInput,
  MemoryEntry,
  ProjectIndex,
  RankedFile,
  RankedSqlObject,
  TaskType
} from "./types.js";

function classifyTask(task: string): TaskType {
  const text = task.toLowerCase();
  if (/\b(fix|bug|error|failing|regression)\b/.test(text)) return "bug";
  if (/\b(refactor|cleanup|rename|split)\b/.test(text)) return "refactor";
  if (/\b(sql|database|table|migration|rls|policy|postgres|supabase)\b/.test(text)) return "database";
  if (/\b(test|spec|coverage)\b/.test(text)) return "test";
  if (/\b(doc|readme|guide|documentation)\b/.test(text)) return "docs";
  if (/\b(architecture|design|why|explain)\b/.test(text)) return "architecture";
  return "feature";
}

function scoreText(text: string, terms: string[], weight = 2): number {
  const haystack = tokenize(text);
  return terms.reduce((score, term) => {
    const matched = haystack.some((part) => part.includes(term) || term.includes(part));
    return score + (matched ? weight : 0);
  }, 0);
}

function firstMatchingSymbol(project: ProjectIndex, file: CodeFile, terms: string[]) {
  return project.symbols
    .filter((symbol) => symbol.filePath === file.path)
    .map((symbol) => ({ symbol, score: scoreText(`${symbol.name} ${symbol.kind}`, terms, 4) }))
    .filter((entry) => entry.score > 0 && entry.symbol.startLine !== undefined)
    .sort((a, b) => b.score - a.score || (a.symbol.startLine ?? 0) - (b.symbol.startLine ?? 0))[0]?.symbol;
}

function rankedFiles(project: ProjectIndex, terms: string[], includeTests: boolean): RankedFile[] {
  return project.files
    .filter((file) => (includeTests ? file.isTest : !file.isTest && file.kind !== "sql" && file.kind !== "doc"))
    .map((file) => {
      const pathScore = scoreText(`${file.path} ${file.kind} ${file.route ?? ""}`, terms, 2);
      const symbolScore = scoreText(
        project.symbols
          .filter((symbol) => symbol.filePath === file.path)
          .map((symbol) => `${symbol.name} ${symbol.kind}`)
          .join(" "),
        terms,
        4
      );
      const importScore = scoreText(
        project.imports
          .filter((edge) => edge.filePath === file.path)
          .map((edge) => `${edge.source} ${edge.resolvedPath ?? ""}`)
          .join(" "),
        terms,
        1
      );
      const lexicalScore = pathScore + symbolScore + importScore;
      const score = lexicalScore > 0 ? lexicalScore + (file.route ? 2 : 0) + (includeTests ? 1 : 0) : 0;
      const matchedSymbol = firstMatchingSymbol(project, file, terms);
      return {
        path: file.path,
        reason: lexicalScore > 0 ? `Matches task terms in ${file.kind} graph data.` : "Low lexical overlap with the task.",
        score,
        startLine: matchedSymbol?.startLine,
        endLine: matchedSymbol?.endLine
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function rankedMemories(memories: MemoryEntry[], terms: string[], limit: number): MemoryEntry[] {
  return memories
    .map((memory) => ({
      memory,
      score: scoreText(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")}`, terms, 3)
    }))
    .filter((entry) => entry.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
    .slice(0, limit)
    .map((entry) => entry.memory);
}

function rankedSql(project: ProjectIndex, terms: string[]): RankedSqlObject[] {
  const rows: RankedSqlObject[] = [];
  for (const table of project.sql.tables) {
    rows.push({
      kind: "table",
      name: table.name,
      filePath: table.filePath,
      reason: `Table columns: ${table.columns.slice(0, 6).join(", ")}`,
      score: scoreText(`${table.name} ${table.columns.join(" ")}`, terms)
    });
  }
  for (const policy of project.sql.policies) {
    rows.push({
      kind: "policy",
      name: policy.name,
      filePath: policy.filePath,
      reason: `Policy on ${policy.table}`,
      score: scoreText(`${policy.name} ${policy.table} ${policy.command ?? ""}`, terms)
    });
  }
  for (const index of project.sql.indexes) {
    rows.push({
      kind: "index",
      name: index.name,
      filePath: index.filePath,
      reason: `Index on ${index.table}`,
      score: scoreText(`${index.name} ${index.table} ${index.columns.join(" ")}`, terms)
    });
  }
  for (const trigger of project.sql.triggers) {
    rows.push({
      kind: "trigger",
      name: trigger.name,
      filePath: trigger.filePath,
      reason: `Trigger on ${trigger.table}`,
      score: scoreText(`${trigger.name} ${trigger.table} ${trigger.functionName ?? ""}`, terms)
    });
  }
  for (const fn of project.sql.functions) {
    rows.push({ kind: "function", name: fn.name, filePath: fn.filePath, reason: "Database function", score: scoreText(fn.name, terms) });
  }
  for (const view of project.sql.views) {
    rows.push({ kind: "view", name: view.name, filePath: view.filePath, reason: "Database view", score: scoreText(view.name, terms) });
  }
  return rows.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function planText(plan: Omit<ContextPlan, "estimatedTokens">): string {
  return JSON.stringify(plan);
}

export async function buildContextPlan(input: ContextPlanInput): Promise<ContextPlan> {
  const terms = tokenize(input.task);
  const relevantFiles = rankedFiles(input.project, terms, false).slice(0, input.budget.maxFiles);
  const relevantTests = rankedFiles(input.project, terms, true).slice(0, Math.max(1, Math.ceil(input.budget.maxFiles / 2)));
  const relevantSql = rankedSql(input.project, terms).slice(0, input.budget.maxSqlObjects);
  const relevantMemories = rankedMemories(input.memories, terms, input.budget.maxMemories);
  const selectedPaths = new Set([...relevantFiles, ...relevantTests].map((file) => file.path));
  const recommendedFirstReads = relevantFiles.slice(0, Math.min(3, relevantFiles.length));
  const filesToAvoid = input.project.files
    .filter((file) => !selectedPaths.has(file.path) && !file.isTest)
    .slice(0, 5)
    .map((file) => ({ path: file.path, score: 0, reason: "Not enough overlap with the current task." }));

  const withoutEstimate = {
    task: input.task,
    taskType: classifyTask(input.task),
    relevantMemories,
    relevantFiles,
    relevantTests,
    relevantSql,
    recommendedFirstReads,
    filesToAvoid,
    rawReadPolicy: "Read targeted files or short snippets only after this patch scope has been reviewed."
  };
  const originalContext = [
    ...input.project.files.map((file) => `${file.path} ${file.estimatedTokens}`),
    ...input.project.symbols.map((symbol) => `${symbol.filePath} ${symbol.name}`),
    ...input.project.sql.tables.map((table) => `${table.name} ${table.columns.join(" ")}`),
    ...input.memories.map((memory) => `${memory.title} ${memory.body}`)
  ].join("\n");
  const compact = planText(withoutEstimate);

  return {
    ...withoutEstimate,
    estimatedTokens: {
      ...estimateSavings(originalContext, compact),
      avoided: Math.max(1, estimateTokens(originalContext) - estimateTokens(compact))
    }
  };
}
