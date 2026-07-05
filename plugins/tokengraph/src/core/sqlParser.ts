import type {
  SqlFunction,
  SqlGraph,
  SqlIndex,
  SqlPolicy,
  SqlRelation,
  SqlTable,
  SqlTrigger,
  SqlView
} from "./types.js";

function normalizeSqlName(name: string): string {
  return name.replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function splitColumns(body: string): string[] {
  const columns: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      columns.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    columns.push(current.trim());
  }
  return columns;
}

function emptyGraph(): SqlGraph {
  return {
    tables: [],
    relations: [],
    policies: [],
    indexes: [],
    triggers: [],
    functions: [],
    views: []
  };
}

export function parsePostgresMigration(filePath: string, sql: string): SqlGraph {
  const graph = emptyGraph();

  for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(([\s\S]*?)\)\s*;/gi)) {
    const tableName = normalizeSqlName(match[1]);
    const columnDefs = splitColumns(match[2]);
    const table: SqlTable = { name: tableName, columns: [], filePath };
    for (const columnDef of columnDefs) {
      const columnName = normalizeSqlName(columnDef.split(/\s+/)[0] ?? "");
      if (!columnName || /^(constraint|primary|foreign|unique|check)$/i.test(columnName)) {
        continue;
      }
      table.columns.push(columnName);
      const reference = columnDef.match(/references\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*(?:\(\s*("?[\w]+"?)\s*\))?/i);
      if (reference) {
        graph.relations.push({
          fromTable: tableName,
          fromColumn: columnName,
          toTable: normalizeSqlName(reference[1]),
          toColumn: reference[2] ? normalizeSqlName(reference[2]) : undefined,
          filePath
        });
      }
    }
    graph.tables.push(table);
  }

  for (const match of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|([\w_]+))\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)(?:[\s\S]*?\bfor\s+(\w+))?/gi)) {
    graph.policies.push({
      name: normalizeSqlName(match[1] ?? match[2]),
      table: normalizeSqlName(match[3]),
      command: match[4]?.toLowerCase(),
      filePath
    });
  }

  for (const match of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?("?[\w]+"?)\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(([^)]+)\)/gi)) {
    graph.indexes.push({
      name: normalizeSqlName(match[1]),
      table: normalizeSqlName(match[2]),
      columns: match[3].split(",").map(normalizeSqlName),
      filePath
    });
  }

  for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi)) {
    const fn: SqlFunction = { name: normalizeSqlName(match[1]), filePath };
    graph.functions.push(fn);
  }

  for (const match of sql.matchAll(/create\s+trigger\s+("?[\w]+"?)[\s\S]*?\son\s+((?:"?[\w]+"?\.)?"?[\w]+"?)[\s\S]*?execute\s+function\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi)) {
    const trigger: SqlTrigger = {
      name: normalizeSqlName(match[1]),
      table: normalizeSqlName(match[2]),
      functionName: normalizeSqlName(match[3]),
      filePath
    };
    graph.triggers.push(trigger);
  }

  for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+/gi)) {
    const view: SqlView = { name: normalizeSqlName(match[1]), filePath };
    graph.views.push(view);
  }

  return graph;
}

export function mergeSqlGraphs(graphs: SqlGraph[]): SqlGraph {
  const merged = emptyGraph();
  for (const graph of graphs) {
    merged.tables.push(...graph.tables);
    merged.relations.push(...graph.relations);
    merged.policies.push(...graph.policies);
    merged.indexes.push(...graph.indexes);
    merged.triggers.push(...graph.triggers);
    merged.functions.push(...graph.functions);
    merged.views.push(...graph.views);
  }
  return merged;
}

