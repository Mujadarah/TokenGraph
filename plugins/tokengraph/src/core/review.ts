import type { ImportEdge, MemoryEntry, MemoryReview, ProjectIndex, ProjectMapExport } from "./types.js";
import { tokenize } from "./token.js";

interface ReviewMemoriesInput {
  memories: MemoryEntry[];
  query?: string;
  limit?: number;
}

interface ExportProjectMapOptions {
  format?: ProjectMapExport["format"];
  limit?: number;
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function matchedTerms(memory: MemoryEntry, terms: string[]): string[] {
  const haystack = tokenize(`${memory.type} ${memory.title} ${memory.body} ${memory.tags.join(" ")}`);
  return terms.filter((term) => haystack.some((part) => part.includes(term) || term.includes(part)));
}

export async function reviewMemories({ memories, query = "", limit = 20 }: ReviewMemoriesInput): Promise<MemoryReview> {
  const normalizedLimit = Math.max(1, Math.min(limit, 100));
  const terms = tokenize(query);
  const matches = memories
    .map((memory) => {
      const hits = matchedTerms(memory, terms);
      return {
        id: memory.id,
        type: memory.type,
        title: memory.title,
        tags: memory.tags,
        createdAt: memory.createdAt,
        score: hits.length,
        matchedTerms: hits,
        action: hits.length > 0 || terms.length === 0 ? ("keep" as const) : ("review" as const),
        reason:
          hits.length > 0
            ? `Matched ${hits.length} review term${hits.length === 1 ? "" : "s"}: ${hits.join(", ")}.`
            : terms.length === 0
              ? "Included because no review query was provided."
              : "No query terms matched; review whether this memory is still useful."
      };
    })
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
    .slice(0, normalizedLimit);

  return {
    query,
    totalMemories: memories.length,
    matches,
    policy: "This review is read-only and does not modify, delete, or rewrite local memories."
  };
}

function edgeKey(edge: ImportEdge): string {
  return `${edge.filePath}\0${edge.resolvedPath ?? ""}`;
}

export function exportProjectMap(project: ProjectIndex, options: ExportProjectMapOptions = {}): ProjectMapExport {
  const format = options.format ?? "mermaid";
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const files = project.files.slice(0, limit);
  const indexedPaths = new Set(files.map((file) => file.path));
  const edges = Array.from(
    new Map(
      project.imports
        .filter((edge) => edge.resolvedPath && indexedPaths.has(edge.filePath) && indexedPaths.has(edge.resolvedPath))
        .map((edge) => [edgeKey(edge), edge])
    ).values()
  );
  const nodeIds = new Map(files.map((file, index) => [file.path, `n${index}`]));

  const content =
    format === "json"
      ? JSON.stringify(
          {
            nodes: files.map((file) => ({ id: nodeIds.get(file.path), path: file.path, kind: file.kind, route: file.route })),
            edges: edges.map((edge) => ({ from: edge.filePath, to: edge.resolvedPath, source: edge.source }))
          },
          null,
          2
        )
      : [
          "flowchart LR",
          ...files.map((file) => `  ${nodeIds.get(file.path)}["${escapeMermaidLabel(`${file.path} (${file.kind})`)}"]`),
          ...edges.map((edge) => `  ${nodeIds.get(edge.filePath)} --> ${nodeIds.get(edge.resolvedPath ?? "")}`)
        ].join("\n");

  return {
    format,
    root: project.root,
    nodeCount: files.length,
    edgeCount: edges.length,
    truncated: project.files.length > files.length,
    content
  };
}
