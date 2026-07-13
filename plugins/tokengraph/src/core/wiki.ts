import { createHash } from "node:crypto";
import { posix } from "node:path";

import { estimateTokens } from "./token.js";
import type { AppliedKnowledge } from "./knowledgeReviewQueue.js";
import type { CodeFile, MemoryEntry, ProjectIndex, ProjectWiki, WikiPage } from "./types.js";

export const CURRENT_WIKI_SCHEMA_VERSION = 1;

const LIST_LIMIT = 20;

interface PageDraft {
  slug: string;
  title: string;
  lines: string[];
  sourcePaths: string[];
  links: string[];
}

function page(slug: string, title: string, lines: string[], sourcePaths: string[] = [], links: string[] = []): PageDraft {
  return { slug, title, lines, sourcePaths, links };
}

function yamlList(label: string, values: string[]): string[] {
  return values.length ? [`${label}:`, ...values.map((value) => `  - ${JSON.stringify(value)}`)] : [`${label}: []`];
}

function wikiLink(fromSlug: string, target: PageDraft): string {
  const relativeSlug = posix.relative(posix.dirname(fromSlug), target.slug) || posix.basename(target.slug);
  const alias = target.title.replaceAll("]", " ").replaceAll("|", " ").replace(/\r?\n/g, " ");
  return `[[${relativeSlug}|${alias}]]`;
}

function pageSourceFingerprints(index: ProjectIndex, draft: PageDraft, applications: AppliedKnowledge[]): string[] {
  const indexed = draft.sourcePaths
    .map((path) => index.scanMetadata?.files[path])
    .filter((metadata): metadata is NonNullable<typeof metadata> => Boolean(metadata))
    .map((metadata) => `path:${metadata.path}:${metadata.contentHash}`);
  const reviewed = applications.flatMap((application) =>
    application.sources.map((source) => `${source.kind}:${source.sourceId}:${source.fingerprint}`)
  );
  const indexedFingerprint = indexed.length
    ? [`index:${createHash("sha256").update(JSON.stringify(indexed.sort())).digest("hex")}`]
    : [];
  return Array.from(new Set([...indexedFingerprint, ...reviewed])).sort();
}

function sourceIsStale(index: ProjectIndex, application: AppliedKnowledge): boolean {
  return application.sources.some((source) => {
    if (source.kind !== "path") return false;
    const indexed = index.scanMetadata?.files[source.sourceId];
    return !indexed || indexed.contentHash !== source.fingerprint;
  });
}

function renderPage(
  index: ProjectIndex,
  draft: PageDraft,
  drafts: PageDraft[],
  backlinks: string[],
  applications: AppliedKnowledge[]
): WikiPage {
  const relevant = applications.filter((application) => application.affectedTargets.wikiPages.includes(draft.slug));
  const contradictions = Array.from(new Set(relevant.flatMap((application) => application.conflictNotes))).sort();
  const freshness = relevant.some((application) => sourceIsStale(index, application)) ? "stale" : "fresh";
  const sourceFingerprints = pageSourceFingerprints(index, draft, relevant);
  const links = draft.links
    .map((slug) => drafts.find((candidate) => candidate.slug === slug))
    .filter((candidate): candidate is PageDraft => Boolean(candidate));
  const backlinkDrafts = backlinks
    .map((slug) => drafts.find((candidate) => candidate.slug === slug))
    .filter((candidate): candidate is PageDraft => Boolean(candidate));
  const body = [
    "---",
    `title: ${JSON.stringify(draft.title)}`,
    `slug: ${JSON.stringify(draft.slug)}`,
    `freshness: ${JSON.stringify(freshness)}`,
    ...yamlList("source_fingerprints", sourceFingerprints),
    ...yamlList("backlinks", backlinks),
    "---",
    "",
    `# ${draft.title}`,
    "",
    ...draft.lines,
    ...(links.length ? ["", "## Related Pages", ...links.map((candidate) => `- ${wikiLink(draft.slug, candidate)}`)] : []),
    ...(backlinkDrafts.length ? ["", "## Backlinks", ...backlinkDrafts.map((candidate) => `- ${wikiLink(draft.slug, candidate)}`)] : []),
    ...(relevant.length ? ["", "## Reviewed Knowledge", ...relevant.flatMap((application) => [
      `### ${application.title}`,
      application.proposedContent
    ])] : []),
    ...(contradictions.length ? ["", "## Contradictions", ...contradictions.map((note) => `> [!warning] Conflict: ${note}`)] : [])
  ].join("\n").trimEnd() + "\n";
  return {
    slug: draft.slug,
    title: draft.title,
    body,
    estimatedTokens: estimateTokens(body),
    sourceFingerprints,
    backlinks,
    contradictions,
    freshness
  };
}

function topLevelDirectory(path: string): string {
  const [first] = path.split("/");
  return first || ".";
}

function cappedLines<T>(items: T[], render: (item: T) => string, limit = LIST_LIMIT): string[] {
  const visible = items.slice(0, limit).map(render);
  const remaining = items.length - visible.length;
  return remaining > 0 ? [...visible, `- and ${remaining} more`] : visible;
}

function byPath(a: { path?: string; filePath?: string }, b: { path?: string; filePath?: string }): number {
  return (a.path ?? a.filePath ?? "").localeCompare(b.path ?? b.filePath ?? "");
}

function buildOverviewPage(index: ProjectIndex): PageDraft {
  const kindCounts = new Map<string, number>();
  for (const file of index.files) {
    kindCounts.set(file.kind, (kindCounts.get(file.kind) ?? 0) + 1);
  }
  const directories = Array.from(new Set(index.files.map((file) => topLevelDirectory(file.path)))).sort();
  const lines = [
    "## Frameworks",
    `- Frameworks: ${index.frameworks.length ? index.frameworks.join(", ") : "none detected"}`,
    "",
    "## Files By Kind",
    ...Array.from(kindCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `- ${kind}: ${count}`),
    "",
    "## Top-Level Directories",
    `- Top-level directories: ${directories.length ? directories.join(", ") : "."}`
  ];
  return page("overview", "Project Overview", lines, index.files.map((file) => file.path), ["structure", "routes", "database", "decisions"]);
}

function exportedSymbolsForFile(index: ProjectIndex, filePath: string): string {
  const names = index.symbols
    .filter((symbol) => symbol.filePath === filePath && symbol.exported)
    .map((symbol) => symbol.name)
    .sort();
  return names.length ? `exports ${names.join(", ")}` : "exports none";
}

function buildStructurePage(index: ProjectIndex): PageDraft {
  const files = [...index.files].sort(byPath);
  const grouped = new Map<string, CodeFile[]>();
  for (const file of files) {
    const directory = topLevelDirectory(file.path);
    grouped.set(directory, [...(grouped.get(directory) ?? []), file]);
  }
  const lines: string[] = [];
  for (const [directory, entries] of Array.from(grouped).sort(([a], [b]) => a.localeCompare(b))) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(`## ${directory}`);
    lines.push(...cappedLines(entries, (file) => `- ${file.path} (${file.kind}) ${exportedSymbolsForFile(index, file.path)}`));
  }
  return page("structure", "Project Structure", lines, files.map((file) => file.path), ["overview"]);
}

function buildRoutesPage(index: ProjectIndex): PageDraft | undefined {
  const routes = index.files
    .filter((file) => file.route)
    .sort((a, b) => (a.route ?? "").localeCompare(b.route ?? "") || a.path.localeCompare(b.path));
  if (!routes.length) {
    return undefined;
  }
  return page("routes", "Routes", cappedLines(routes, (file) => `- ${file.route} -> ${file.path}`), routes.map((file) => file.path), ["overview", "structure"]);
}

function hasDatabaseContent(index: ProjectIndex): boolean {
  return (
    index.sql.tables.length > 0 ||
    index.sql.policies.length > 0 ||
    index.sql.constraints.length > 0 ||
    index.sql.indexes.length > 0 ||
    index.sql.triggers.length > 0 ||
    index.sql.functions.length > 0 ||
    index.sql.views.length > 0 ||
    index.sql.enums.length > 0 ||
    index.sql.extensions.length > 0 ||
    index.sql.grants.length > 0 ||
    index.sql.materializedViews.length > 0 ||
    index.sql.history.length > 0
  );
}

function buildDatabasePage(index: ProjectIndex): PageDraft | undefined {
  if (!hasDatabaseContent(index)) {
    return undefined;
  }
  const lines: string[] = [];
  if (index.sql.tables.length) {
    lines.push("## Tables");
    lines.push(...cappedLines([...index.sql.tables].sort((a, b) => a.name.localeCompare(b.name)), (table) => `- Table ${table.name}`));
  }
  if (index.sql.policies.length) {
    if (lines.length) lines.push("");
    lines.push("## Policies");
    lines.push(
      ...cappedLines(
        [...index.sql.policies].sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)),
        (policy) => `- Policy ${policy.name} on ${policy.table}${policy.command ? ` for ${policy.command}` : ""}`
      )
    );
  }
  if (index.sql.materializedViews.length) {
    if (lines.length) lines.push("");
    lines.push("## Materialized Views");
    lines.push(
      ...cappedLines(
        [...index.sql.materializedViews].sort((a, b) => a.name.localeCompare(b.name)),
        (view) => `- Materialized view ${view.name}`
      )
    );
  }
  if (index.sql.history.length) {
    if (lines.length) lines.push("");
    lines.push("## Migration History");
    const history = [...index.sql.history].sort((a, b) => a.order - b.order || a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
    const visible = history.slice(0, LIST_LIMIT).map((entry, index) => `${index + 1}. ${entry.kind} ${entry.name} (${entry.action}; ${entry.filePath})`);
    lines.push(...visible);
    if (history.length > visible.length) {
      lines.push(`- and ${history.length - visible.length} more`);
    }
  }
  return page("database", "Database", lines, index.files.filter((file) => file.kind === "sql").map((file) => file.path), ["overview", "structure"]);
}

function buildDecisionsPage(memories: MemoryEntry[]): PageDraft | undefined {
  if (!memories.length) {
    return undefined;
  }
  const sorted = [...memories].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return page(
    "decisions",
    "Recorded Decisions",
    cappedLines(sorted, (memory) => `- ${memory.title} (${memory.type}; tags: ${memory.tags.slice().sort().join(", ") || "none"})`),
    [],
    ["overview"]
  );
}

export function buildProjectWiki(index: ProjectIndex, memories: MemoryEntry[], applications: AppliedKnowledge[] = []): ProjectWiki {
  const maybePages = [
    buildOverviewPage(index),
    buildStructurePage(index),
    buildRoutesPage(index),
    buildDatabasePage(index),
    buildDecisionsPage(memories)
  ];
  const drafts = maybePages.filter((candidate): candidate is PageDraft => Boolean(candidate));
  const customTargets = new Map<string, AppliedKnowledge[]>();
  for (const application of applications.filter((candidate) => candidate.type === "wiki")) {
    for (const slug of application.affectedTargets.wikiPages) {
      customTargets.set(slug, [...(customTargets.get(slug) ?? []), application]);
    }
  }
  for (const [slug, matches] of Array.from(customTargets).sort(([left], [right]) => left.localeCompare(right))) {
    if (drafts.some((draft) => draft.slug === slug)) continue;
    const sorted = matches.sort((left, right) => left.suggestionId.localeCompare(right.suggestionId));
    drafts.push(page(
      slug,
      sorted[0]!.title,
      ["This page contains explicitly reviewed local knowledge."],
      sorted.flatMap((application) => application.sources.filter((source) => source.kind === "path").map((source) => source.sourceId)),
      ["overview"]
    ));
  }
  const backlinkMap = new Map<string, string[]>();
  for (const draft of drafts) {
    for (const target of draft.links) {
      if (!drafts.some((candidate) => candidate.slug === target)) continue;
      backlinkMap.set(target, [...(backlinkMap.get(target) ?? []), draft.slug]);
    }
  }
  return {
    schemaVersion: CURRENT_WIKI_SCHEMA_VERSION,
    fingerprint: index.fingerprint,
    pages: drafts.map((draft) => renderPage(
      index,
      draft,
      drafts,
      (backlinkMap.get(draft.slug) ?? []).sort(),
      applications.filter((application) => application.type === "wiki")
    ))
  };
}
