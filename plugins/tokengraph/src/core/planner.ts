import { estimateSavings, estimateTokens, tokenize } from "./token.js";
import { PROFILE_DEFAULTS } from "./config.js";
import type {
  CodeFile,
  ContextBudget,
  ContextPlan,
  ContextPlanInput,
  MemoryEntry,
  ProjectIndex,
  RankedFile,
  RankedSqlObject,
  TokenSavingProfile
} from "./types.js";
import { classifyTask } from "./taskClassifier.js";

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

function rankedFiles(project: ProjectIndex, terms: string[], includeTests: boolean, includeZero = false): RankedFile[] {
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
    .filter((entry) => includeZero || entry.score > 0)
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
  for (const constraint of project.sql.constraints) {
    rows.push({
      kind: "constraint",
      name: constraint.name,
      filePath: constraint.filePath,
      reason: `${constraint.kind} constraint on ${constraint.table}`,
      score: scoreText(`${constraint.name} ${constraint.table} ${constraint.kind} ${constraint.columns?.join(" ") ?? ""} ${constraint.expression ?? ""}`, terms)
    });
  }
  for (const policy of project.sql.policies) {
    rows.push({
      kind: "policy",
      name: policy.name,
      filePath: policy.filePath,
      reason: `Policy on ${policy.table}${policy.command ? ` for ${policy.command}` : ""}`,
      score: scoreText(
        `${policy.name} ${policy.table} ${policy.command ?? ""} ${policy.roles?.join(" ") ?? ""} ${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`,
        terms
      )
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
  for (const enumObject of project.sql.enums) {
    rows.push({
      kind: "enum",
      name: enumObject.name,
      filePath: enumObject.filePath,
      reason: `Enum values: ${enumObject.values.join(", ")}`,
      score: scoreText(`${enumObject.name} ${enumObject.values.join(" ")}`, terms)
    });
  }
  for (const extension of project.sql.extensions) {
    rows.push({ kind: "extension", name: extension.name, filePath: extension.filePath, reason: "PostgreSQL extension", score: scoreText(extension.name, terms) });
  }
  for (const grant of project.sql.grants) {
    rows.push({
      kind: "grant",
      name: `${grant.objectName} to ${grant.grantee}`,
      filePath: grant.filePath,
      reason: `Grant ${grant.privileges.join(", ")} to ${grant.grantee}`,
      score: scoreText(`${grant.objectName} ${grant.grantee} ${grant.privileges.join(" ")} ${grant.objectType ?? ""}`, terms)
    });
  }
  for (const materializedView of project.sql.materializedViews) {
    rows.push({
      kind: "materializedView",
      name: materializedView.name,
      filePath: materializedView.filePath,
      reason: "Materialized view",
      score: scoreText(materializedView.name, terms)
    });
  }
  return rows.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function selectSqlAcrossFiles(rows: RankedSqlObject[], limit: number): RankedSqlObject[] {
  const representatives: RankedSqlObject[] = [];
  const represented = new Set<string>();
  for (const row of rows) {
    if (represented.has(row.filePath)) continue;
    represented.add(row.filePath);
    representatives.push(row);
  }
  const selected = [...representatives, ...rows.filter((row) => !representatives.includes(row))];
  return selected.slice(0, limit);
}

function planText(plan: Omit<ContextPlan, "estimatedTokens">): string {
  return JSON.stringify(plan);
}

type ResolvedContextBudget = Required<Omit<ContextBudget, "profile">> & { profile: TokenSavingProfile };

function resolveBudget(budget: ContextBudget): ResolvedContextBudget {
  const profile = budget.profile ?? "balanced";
  const profileDefaults = PROFILE_DEFAULTS[profile];
  return {
    profile,
    maxFiles: budget.maxFiles ?? profileDefaults.maxFiles,
    maxSqlObjects: budget.maxSqlObjects ?? profileDefaults.maxSqlObjects,
    maxMemories: budget.maxMemories ?? profileDefaults.maxMemories,
    firstReads: budget.firstReads ?? profileDefaults.firstReads,
    maxEstimatedTokens: budget.maxEstimatedTokens ?? profileDefaults.maxPlannedContextTokens,
    rawReadWarningThreshold: budget.rawReadWarningThreshold ?? profileDefaults.rawReadWarningThreshold,
    allowRawReads: budget.allowRawReads ?? true
  };
}

function trimPlanToBudget(plan: Omit<ContextPlan, "estimatedTokens">): Omit<ContextPlan, "estimatedTokens"> {
  const budgetExclusions = new Set(plan.budgetExclusions);
  const next = { ...plan, budgetExclusions: Array.from(budgetExclusions) };
  const estimateCompact = () => estimateTokens(planText(next));
  while (estimateCompact() > next.budget.maxEstimatedTokens) {
    const before = estimateCompact();
    if (next.filesToAvoid.length) {
      next.filesToAvoid = next.filesToAvoid.slice(0, -1);
      budgetExclusions.add("Removed low-priority avoid-list entries to stay within the estimated context budget.");
    } else if (next.relevantSql.length) {
      const pathCounts = new Map<string, number>();
      for (const sql of next.relevantSql) pathCounts.set(sql.filePath, (pathCounts.get(sql.filePath) ?? 0) + 1);
      let redundantIndex = -1;
      for (let index = next.relevantSql.length - 1; index >= 0; index -= 1) {
        if ((pathCounts.get(next.relevantSql[index]!.filePath) ?? 0) > 1) {
          redundantIndex = index;
          break;
        }
      }
      if (redundantIndex < 0 && next.taskType === "database") {
        if (next.relevantTests.length) {
          next.relevantTests = next.relevantTests.slice(0, -1);
          budgetExclusions.add("Excluded lower-ranked tests to preserve focused SQL evidence within the context budget.");
        } else if (next.relevantMemories.length) {
          next.relevantMemories = next.relevantMemories.slice(0, -1);
          budgetExclusions.add("Excluded lower-ranked memories to preserve focused SQL evidence within the context budget.");
        } else if (next.relevantFiles.length > 1) {
          next.relevantFiles = next.relevantFiles.slice(0, -1);
          budgetExclusions.add("Excluded lower-ranked files to preserve focused SQL evidence within the context budget.");
        } else {
          budgetExclusions.add("Estimated compact database plan retains one SQL object per relevant migration despite exceeding the requested token budget.");
          next.budgetExclusions = Array.from(budgetExclusions);
          break;
        }
      } else {
        const removeAt = redundantIndex >= 0 ? redundantIndex : next.relevantSql.length - 1;
        next.relevantSql = next.relevantSql.filter((_, index) => index !== removeAt);
        budgetExclusions.add("Excluded a lower-ranked SQL object to stay within the estimated context budget.");
      }
    } else if (next.relevantTests.length) {
      next.relevantTests = next.relevantTests.slice(0, -1);
      budgetExclusions.add("Excluded lower-ranked tests to stay within the estimated context budget.");
    } else if (next.relevantMemories.length) {
      next.relevantMemories = next.relevantMemories.slice(0, -1);
      budgetExclusions.add("Excluded lower-ranked memories to stay within the estimated context budget.");
    } else if (next.relevantFiles.length > 1) {
      next.relevantFiles = next.relevantFiles.slice(0, -1);
      budgetExclusions.add("Excluded lower-ranked files to stay within the estimated context budget.");
    } else {
      budgetExclusions.add("Estimated compact plan still exceeds the requested token budget; token counts are approximate.");
      next.budgetExclusions = Array.from(budgetExclusions);
      break;
    }
    next.recommendedFirstReads = next.relevantFiles.slice(0, Math.min(next.budget.firstReads, next.relevantFiles.length));
    next.budgetExclusions = Array.from(budgetExclusions);
    if (estimateCompact() >= before && before > next.budget.maxEstimatedTokens) {
      break;
    }
  }
  next.budgetExclusions = Array.from(budgetExclusions);
  return next;
}

export async function buildContextPlan(input: ContextPlanInput): Promise<ContextPlan> {
  const terms = tokenize(input.task);
  const budget = resolveBudget(input.budget);
  const allRelevantFiles = rankedFiles(input.project, terms, false);
  const allRelevantTests = rankedFiles(input.project, terms, true);
  const allRelevantSql = rankedSql(input.project, terms);
  const relevantFiles = allRelevantFiles.slice(0, budget.maxFiles);
  const relevantTests = allRelevantTests.slice(0, Math.max(1, Math.ceil(budget.maxFiles / 2)));
  const relevantSql = selectSqlAcrossFiles(allRelevantSql, budget.maxSqlObjects);
  const relevantMemories = rankedMemories(input.memories, terms, budget.maxMemories);
  const budgetExclusions = [];
  if (allRelevantFiles.length > relevantFiles.length) budgetExclusions.push(`${allRelevantFiles.length - relevantFiles.length} lower-ranked file(s) excluded by profile or explicit file budget.`);
  if (allRelevantTests.length > relevantTests.length) budgetExclusions.push(`${allRelevantTests.length - relevantTests.length} lower-ranked test file(s) excluded by profile or explicit file budget.`);
  if (allRelevantSql.length > relevantSql.length) budgetExclusions.push(`${allRelevantSql.length - relevantSql.length} lower-ranked SQL object(s) excluded by profile or explicit SQL budget.`);
  const selectedPaths = new Set([...relevantFiles, ...relevantTests].map((file) => file.path));
  const recommendedFirstReads = relevantFiles.slice(0, Math.min(budget.firstReads, relevantFiles.length));
  const filesToAvoid = rankedFiles(input.project, terms, false, true)
    .filter((file) => !selectedPaths.has(file.path) && file.score === 0)
    .slice(0, 5)
    .map((file) => ({ ...file, reason: "No lexical overlap with the current task." }));

  const withoutEstimate = trimPlanToBudget({
    task: input.task,
    taskType: classifyTask(input.task),
    profile: budget.profile,
    budget,
    relevantMemories,
    relevantFiles,
    relevantTests,
    relevantSql,
    recommendedFirstReads,
    filesToAvoid,
    budgetExclusions,
    rawReadPolicy: budget.allowRawReads
      ? `Read targeted files or short snippets only after this patch scope has been reviewed. Warn before raw reads over about ${budget.rawReadWarningThreshold} estimated tokens.`
      : `Do not read broad raw files. Use targeted snippets and warn before any raw read over about ${budget.rawReadWarningThreshold} estimated tokens.`
  });
  const originalContext = [
    ...input.project.files.map((file) => `${file.path} ${file.estimatedTokens}`),
    ...input.project.symbols.map((symbol) => `${symbol.filePath} ${symbol.name}`),
    ...input.project.sql.tables.map((table) => `${table.name} ${table.columns.join(" ")}`),
    ...input.project.sql.policies.map((policy) => `${policy.name} ${policy.table} ${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`),
    ...input.project.sql.materializedViews.map((view) => view.name),
    ...input.project.sql.history.map((entry) => `${entry.filePath} ${entry.kind} ${entry.name}`),
    ...input.memories.map((memory) => `${memory.title} ${memory.body}`)
  ].join("\n");
  const compact = planText(withoutEstimate);

  return {
    ...withoutEstimate,
    estimatedTokens: estimateSavings(originalContext, compact, "full-index-dump")
  };
}
