import { PROFILE_DEFAULTS } from "./config.js";
import { buildContextPlan } from "./planner.js";
import { estimateSavings, tokenize } from "./token.js";
import type { ContextCompressionInput, ContextCompressionReport, MemoryEntry, ProjectWiki, RankedFile, WikiReference } from "./types.js";

const FILE_PATH_PATTERN_SOURCE = "((?:[A-Za-z0-9_.-]+[\\\\/])+[A-Za-z0-9_.-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|sql|md|json|css|scss|yml|yaml))(?:[:](\\d+)(?::\\d+)?)?";
const FILE_PATH_PATTERN = new RegExp(FILE_PATH_PATTERN_SOURCE, "g");
const FILE_PATH_LINE_PATTERN = new RegExp(FILE_PATH_PATTERN_SOURCE);
const MIGRATION_PATTERN = /\b\d{8,}[_A-Za-z0-9-]*\.sql\b/;
const ERROR_PATTERN = /\b(?:FAIL|AssertionError|Error:|TypeError|ReferenceError|SyntaxError|RangeError|Unhandled|Exception)\b/;
const TEST_PATTERN = /\b(?:test|it|describe|spec|suite|failed|failing|FAIL)\b/i;
const SECURITY_PATTERN = /\b(?:security warning|security|tenant isolation|tenant_id|auth\.uid|rls|row level security|policy|permission|secret|token|credential)\b/i;
const CONSTRAINT_PATTERN = /\b(?:user constraint|constraint|must|never|do not|don't|preserve|required|cannot|public api|breaking change|migration)\b/i;
const STACK_PATTERN = /^\s*at\s+\S+/;

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function normalizedLine(line: string): string {
  return line.trim();
}

function shouldPreserveLine(line: string): boolean {
  const trimmed = normalizedLine(line);
  if (!trimmed) return false;
  return (
    ERROR_PATTERN.test(trimmed) ||
    STACK_PATTERN.test(trimmed) ||
    MIGRATION_PATTERN.test(trimmed) ||
    SECURITY_PATTERN.test(trimmed) ||
    CONSTRAINT_PATTERN.test(trimmed) ||
    (TEST_PATTERN.test(trimmed) && FILE_PATH_LINE_PATTERN.test(trimmed))
  );
}

function extractPreservedLines(task: string, text = ""): string[] {
  const lines = [task, ...text.split(/\r?\n/)];
  return unique(lines.map(normalizedLine).filter(shouldPreserveLine));
}

function extractFileReads(lines: string[], projectPaths: Set<string>): RankedFile[] {
  const reads = new Map<string, RankedFile>();
  for (const line of lines) {
    for (const match of line.matchAll(new RegExp(FILE_PATH_PATTERN.source, "g"))) {
      const path = match[1].replace(/\\/g, "/");
      if (!projectPaths.has(path)) continue;
      const parsedLine = match[2] ? Number.parseInt(match[2], 10) : undefined;
      const existing = reads.get(path);
      const startLine = Number.isFinite(parsedLine) ? parsedLine : existing?.startLine;
      reads.set(path, {
        path,
        startLine,
        endLine: startLine,
        score: Math.max(existing?.score ?? 0, startLine ? 100 : 80),
        reason: startLine ? "Preserved stack trace path and line number." : "Preserved affected file path from compressed context."
      });
    }
  }
  return [...reads.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function referencedMemories(memories: MemoryEntry[], query: string, limit: number): MemoryEntry[] {
  const terms = tokenize(query);
  const seen = new Set<string>();
  return memories
    .map((memory) => {
      const haystack = tokenize(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")} ${memory.linkedFiles.join(" ")} ${memory.linkedSqlObjects.join(" ")}`);
      const score = terms.reduce((total, term) => total + (haystack.some((part) => part.includes(term) || term.includes(part)) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((entry) => entry.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
    .map((entry) => entry.memory)
    .filter((memory) => {
      const key = memory.id || memory.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function referencedWikiPages(wiki: ProjectWiki | undefined, query: string, limit = 5): WikiReference[] {
  if (!wiki) return [];
  const terms = tokenize(query);
  return wiki.pages
    .map((page) => {
      const haystack = tokenize(`${page.slug} ${page.title} ${page.body}`);
      const score = terms.reduce((total, term) => total + (haystack.some((part) => part.includes(term) || term.includes(part)) ? 1 : 0), 0);
      return { page, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug))
    .slice(0, limit)
    .map(({ page, score }) => ({
      slug: page.slug,
      title: page.title,
      estimatedTokens: page.estimatedTokens,
      reason: `Matched ${score} task/context term${score === 1 ? "" : "s"}; reference the wiki page instead of repeating background.`
    }));
}

function mergeFirstReads(preservedReads: RankedFile[], plannedReads: RankedFile[]): RankedFile[] {
  const merged = new Map<string, RankedFile>();
  for (const read of [...preservedReads, ...plannedReads]) {
    const existing = merged.get(read.path);
    if (!existing) {
      merged.set(read.path, read);
      continue;
    }
    merged.set(read.path, {
      ...existing,
      score: Math.max(existing.score, read.score),
      startLine: existing.startLine ?? read.startLine,
      endLine: existing.endLine ?? read.endLine,
      reason: existing.reason.includes(read.reason) ? existing.reason : `${existing.reason} ${read.reason}`
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 8);
}

function confidenceFor(preservedConstraints: string[], recommendedFirstReads: RankedFile[], referencedMemoryCount: number): ContextCompressionReport["confidence"] {
  if (preservedConstraints.length >= 3 && recommendedFirstReads.length > 0) return "high";
  if (preservedConstraints.length > 0 || recommendedFirstReads.length > 0 || referencedMemoryCount > 0) return "medium";
  return "low";
}

export async function compressContext(input: ContextCompressionInput): Promise<ContextCompressionReport> {
  const text = input.text ?? "";
  const preservedConstraints = extractPreservedLines(input.task, text);
  const contextForPlanning = unique([input.task, ...preservedConstraints]).join("\n");
  const profile = input.profile ?? "balanced";
  const plan = await buildContextPlan({
    root: input.root,
    task: contextForPlanning,
    project: input.project,
    memories: input.memories,
    budget: {
      profile,
      maxFiles: PROFILE_DEFAULTS[profile].maxFiles,
      maxSqlObjects: PROFILE_DEFAULTS[profile].maxSqlObjects,
      maxMemories: PROFILE_DEFAULTS[profile].maxMemories,
      firstReads: PROFILE_DEFAULTS[profile].firstReads,
      maxEstimatedTokens: PROFILE_DEFAULTS[profile].maxPlannedContextTokens,
      rawReadWarningThreshold: PROFILE_DEFAULTS[profile].rawReadWarningThreshold,
      allowRawReads: false
    }
  });
  const projectPaths = new Set(input.project.files.map((file) => file.path));
  const preservedReads = extractFileReads(preservedConstraints, projectPaths);
  const recommendedFirstReads = mergeFirstReads(preservedReads, plan.recommendedFirstReads);
  const memoryRefs = referencedMemories([...plan.relevantMemories, ...input.memories], contextForPlanning, PROFILE_DEFAULTS[profile].maxMemories);
  const wikiRefs = referencedWikiPages(input.wiki, contextForPlanning);
  const rawLineCount = text ? text.split(/\r?\n/).filter((line) => line.trim().length > 0).length : 0;
  const omittedLineCount = Math.max(0, rawLineCount - preservedConstraints.length);
  const confidence = confidenceFor(preservedConstraints, recommendedFirstReads, memoryRefs.length);
  const omissions = [
    `${omittedLineCount} non-critical line(s) omitted from ${input.contentKind} context.`,
    "Preserved exact detected error messages, test names, stack paths and line numbers, security warnings, migration identifiers, affected file paths, public API names, and user constraints."
  ];
  if (input.preserveRawReferences) {
    omissions.push("Raw-reference preservation is enabled: use the preserved lines and recommended first reads before any broad raw read.");
  }
  if (wikiRefs.length > 0) {
    omissions.push("Repeated background should be replaced with referenced wiki pages instead of copied into the prompt.");
  }
  if (confidence === "low") {
    omissions.push("Low confidence: read the raw source or original context around the affected paths before implementing or reviewing changes.");
  }

  const compressedTask = [
    input.task.trim(),
    preservedConstraints.length ? `Critical preserved references: ${preservedConstraints.slice(0, 8).join(" | ")}` : "",
    recommendedFirstReads.length ? `Start with: ${recommendedFirstReads.map((read) => (read.startLine ? `${read.path}:${read.startLine}` : read.path)).join(", ")}` : "",
    wikiRefs.length ? `Wiki refs: ${wikiRefs.map((ref) => ref.slug).join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  const compactForEstimate = [
    input.task,
    ...preservedConstraints,
    ...memoryRefs.map((memory) => `memory:${memory.title}`),
    ...wikiRefs.map((ref) => `wiki:${ref.slug}`),
    ...recommendedFirstReads.map((read) => `read:${read.startLine ? `${read.path}:${read.startLine}` : read.path}`),
    omissions[0],
    `confidence:${confidence}`
  ].join("\n");
  const originalForEstimate = [input.task, text, ...input.memories.map((memory) => `${memory.title}\n${memory.body}`), ...(input.wiki?.pages ?? []).map((page) => `${page.title}\n${page.body}`)].join("\n");

  return {
    compressedTask,
    preservedConstraints,
    referencedMemories: memoryRefs,
    referencedWikiPages: wikiRefs,
    recommendedFirstReads,
    omissions,
    confidence,
    estimatedTokens: estimateSavings(originalForEstimate, compactForEstimate)
  };
}
