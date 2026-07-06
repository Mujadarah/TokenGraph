import { createHash } from "node:crypto";
import { scanProject, scanProjectSignature } from "./fileScanner.js";
import { mergeSqlGraphs, parsePostgresMigration } from "./sqlParser.js";
import type { ProjectIndex } from "./types.js";

function fingerprintPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function detectFrameworks(files: { path: string }[]): string[] {
  const frameworks = new Set<string>();
  if (files.some((file) => file.path.startsWith("app/") || file.path.startsWith("pages/"))) {
    frameworks.add("Next.js");
  }
  if (files.some((file) => file.path.endsWith(".tsx") || file.path.endsWith(".jsx"))) {
    frameworks.add("React");
  }
  if (files.some((file) => file.path.includes("supabase/") || file.path.endsWith(".sql"))) {
    frameworks.add("PostgreSQL/Supabase");
  }
  if (files.some((file) => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))) {
    frameworks.add("TypeScript");
  }
  return Array.from(frameworks).sort();
}

export async function indexProject(root: string, options: { scanSignature?: string } = {}): Promise<ProjectIndex> {
  const sqlContents = new Map<string, string>();
  const graph = await scanProject(root, {
    onFileContent: (file) => {
      if (file.language === "sql") {
        sqlContents.set(file.path, file.content);
      }
    }
  });
  const sqlGraphs = [];
  for (const file of graph.files.filter((candidate) => candidate.language === "sql").sort((a, b) => a.path.localeCompare(b.path))) {
    const sql = sqlContents.get(file.path);
    if (sql === undefined) {
      continue;
    }
    sqlGraphs.push(parsePostgresMigration(file.path, sql));
  }

  const sql = mergeSqlGraphs(sqlGraphs);
  const fingerprint = fingerprintPayload({
    files: graph.files,
    symbols: graph.symbols,
    imports: graph.imports,
    exclusions: graph.exclusions,
    sql
  });

  return {
    ...graph,
    scannedAt: new Date().toISOString(),
    fingerprint,
    scanSignature: options.scanSignature ?? (await scanProjectSignature(root)),
    frameworks: detectFrameworks(graph.files),
    sql
  };
}
