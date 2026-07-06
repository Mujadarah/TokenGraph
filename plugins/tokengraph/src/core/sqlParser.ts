import type {
  SqlConstraint,
  SqlEnum,
  SqlExtension,
  SqlFunction,
  SqlGrant,
  SqlGraph,
  SqlHistoryEntry,
  SqlIndex,
  SqlMaterializedView,
  SqlPolicy,
  SqlRelation,
  SqlTable,
  SqlTrigger,
  SqlView
} from "./types.js";

function normalizeSqlName(name: string): string {
  return name.replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function stripOuterParens(value: string): string {
  let text = value.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (depth === 0 && index < text.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map(normalizeSqlName)
    .filter(Boolean);
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
    constraints: [],
    policies: [],
    indexes: [],
    triggers: [],
    functions: [],
    views: [],
    enums: [],
    extensions: [],
    grants: [],
    materializedViews: [],
    history: []
  };
}

export function parsePostgresMigration(filePath: string, sql: string): SqlGraph {
  const graph = emptyGraph();
  let order = 0;
  const remember = (entry: Omit<SqlHistoryEntry, "filePath" | "order">) => {
    graph.history.push({ ...entry, filePath, order: order++ });
  };

  const addConstraint = (constraint: SqlConstraint) => {
    graph.constraints.push(constraint);
    remember({ kind: "constraint", name: constraint.name, action: constraint.name.startsWith("alter ") ? "alter" : "create" });
  };

  for (const match of sql.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+")|[\w-]+)/gi)) {
    const extension: SqlExtension = { name: normalizeSqlName(match[1]), filePath };
    graph.extensions.push(extension);
    remember({ kind: "extension", name: extension.name, action: "create" });
  }

  for (const match of sql.matchAll(/create\s+type\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+enum\s*\(([^)]*)\)/gi)) {
    const enumObject: SqlEnum = {
      name: normalizeSqlName(match[1]),
      values: match[2]
        .split(",")
        .map((value) => normalizeSqlName(value.trim().replace(/^'/, "").replace(/'$/, "")))
        .filter(Boolean),
      filePath
    };
    graph.enums.push(enumObject);
    remember({ kind: "enum", name: enumObject.name, action: "create" });
  }

  for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(([\s\S]*?)\)\s*;/gi)) {
    const tableName = normalizeSqlName(match[1]);
    const columnDefs = splitColumns(match[2]);
    const table: SqlTable = { name: tableName, columns: [], filePath };
    for (const columnDef of columnDefs) {
      const columnName = normalizeSqlName(columnDef.split(/\s+/)[0] ?? "");
      const namedConstraint = columnDef.match(/\bconstraint\s+("?[\w]+"?)\s+(primary\s+key|foreign\s+key|unique|check|exclude)\b([\s\S]*)/i);
      if (namedConstraint && /^\s*constraint\b/i.test(columnDef)) {
        const kind = normalizeSqlName(namedConstraint[2]).toLowerCase() as SqlConstraint["kind"];
        const columnMatch = columnDef.match(/\(([^()]*)\)/);
        const constraint: SqlConstraint = {
          name: normalizeSqlName(namedConstraint[1]),
          table: tableName,
          kind,
          columns: columnMatch && kind !== "check" ? splitCommaList(columnMatch[1]) : undefined,
          expression: kind === "check" ? stripOuterParens(columnDef.slice(columnDef.toLowerCase().indexOf("check") + "check".length)) : undefined,
          filePath
        };
        addConstraint(constraint);
        const tableForeignKey = columnDef.match(/foreign\s+key\s*\(([^)]*)\)\s+references\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*(?:\(\s*("?[\w]+"?)\s*\))?/i);
        if (tableForeignKey) {
          const fromColumns = splitCommaList(tableForeignKey[1]);
          graph.relations.push({
            fromTable: tableName,
            fromColumn: fromColumns[0] ?? "",
            toTable: normalizeSqlName(tableForeignKey[2]),
            toColumn: tableForeignKey[3] ? normalizeSqlName(tableForeignKey[3]) : undefined,
            filePath
          });
        }
        continue;
      }
      if (!columnName || /^(constraint|primary|foreign|unique|check)$/i.test(columnName)) {
        continue;
      }
      table.columns.push(columnName);
      const inlineNamedConstraint = columnDef.match(/\bconstraint\s+("?[\w]+"?)\s+(primary\s+key|foreign\s+key|unique|check|exclude)\b/i);
      if (inlineNamedConstraint) {
        addConstraint({
          name: normalizeSqlName(inlineNamedConstraint[1]),
          table: tableName,
          kind: normalizeSqlName(inlineNamedConstraint[2]).toLowerCase() as SqlConstraint["kind"],
          columns: [columnName],
          filePath
        });
      }
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
    remember({ kind: "table", name: table.name, action: "create" });
  }

  for (const match of sql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s+add\s+constraint\s+("?[\w]+"?)\s+(primary\s+key|foreign\s+key|unique|check|exclude)\b([\s\S]*?);/gi
  )) {
    const kind = normalizeSqlName(match[3]).toLowerCase() as SqlConstraint["kind"];
    const columnMatch = match[4].match(/\(([^()]*)\)/);
    const constraint: SqlConstraint = {
      name: normalizeSqlName(match[2]),
      table: normalizeSqlName(match[1]),
      kind,
      columns: columnMatch && kind !== "check" ? splitCommaList(columnMatch[1]) : undefined,
      expression: kind === "check" ? stripOuterParens(match[4]) : undefined,
      filePath
    };
    graph.constraints.push(constraint);
    remember({ kind: "constraint", name: constraint.name, action: "alter" });
  }

  for (const match of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|([\w_]+))\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)([\s\S]*?);/gi)) {
    const body = match[4] ?? "";
    const command = body.match(/\bfor\s+(\w+)/i)?.[1]?.toLowerCase();
    const roles = body
      .match(/\bto\s+([\s\S]*?)(?:\s+using\s*\(|\s+with\s+check\s*\(|$)/i)?.[1]
      ?.split(",")
      .map(normalizeSqlName)
      .filter(Boolean);
    const policy: SqlPolicy = {
      name: normalizeSqlName(match[1] ?? match[2]),
      table: normalizeSqlName(match[3]),
      command,
      roles,
      usingExpression: extractClauseExpression(body, "using"),
      checkExpression: extractClauseExpression(body, "with check"),
      filePath
    };
    graph.policies.push(policy);
    remember({ kind: "policy", name: policy.name, action: "create" });
  }

  for (const match of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?("?[\w]+"?)\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(([^)]+)\)/gi)) {
    graph.indexes.push({
      name: normalizeSqlName(match[1]),
      table: normalizeSqlName(match[2]),
      columns: match[3].split(",").map(normalizeSqlName),
      filePath
    });
    remember({ kind: "index", name: normalizeSqlName(match[1]), action: "create" });
  }

  for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi)) {
    const fn: SqlFunction = { name: normalizeSqlName(match[1]), filePath };
    graph.functions.push(fn);
    remember({ kind: "function", name: fn.name, action: "create" });
  }

  for (const match of sql.matchAll(/create\s+trigger\s+("?[\w]+"?)[\s\S]*?\son\s+((?:"?[\w]+"?\.)?"?[\w]+"?)[\s\S]*?execute\s+function\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi)) {
    const trigger: SqlTrigger = {
      name: normalizeSqlName(match[1]),
      table: normalizeSqlName(match[2]),
      functionName: normalizeSqlName(match[3]),
      filePath
    };
    graph.triggers.push(trigger);
    remember({ kind: "trigger", name: trigger.name, action: "create" });
  }

  for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+/gi)) {
    const view: SqlView = { name: normalizeSqlName(match[1]), filePath };
    graph.views.push(view);
    remember({ kind: "view", name: view.name, action: "create" });
  }

  for (const match of sql.matchAll(/create\s+materialized\s+view\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+/gi)) {
    const materializedView: SqlMaterializedView = { name: normalizeSqlName(match[1]), filePath };
    graph.materializedViews.push(materializedView);
    remember({ kind: "materializedView", name: materializedView.name, action: "create" });
  }

  for (const match of sql.matchAll(/grant\s+([\w\s,]+?)\s+on\s+(?:(table|schema|sequence|function)\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s+to\s+("?[\w]+"?)/gi)) {
    const grant: SqlGrant = {
      privileges: splitCommaList(match[1]).map((privilege) => privilege.toLowerCase()),
      objectType: match[2]?.toLowerCase(),
      objectName: normalizeSqlName(match[3]),
      grantee: normalizeSqlName(match[4]),
      filePath
    };
    graph.grants.push(grant);
    remember({ kind: "grant", name: `${grant.objectName} to ${grant.grantee}`, action: "grant" });
  }

  return graph;
}

function extractClauseExpression(body: string, clause: "using" | "with check"): string | undefined {
  const clauseRegex = clause === "using" ? /\busing\s*\(/i : /\bwith\s+check\s*\(/i;
  const match = clauseRegex.exec(body);
  if (!match) return undefined;
  const openIndex = match.index + match[0].lastIndexOf("(");
  let depth = 0;
  for (let index = openIndex; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return stripOuterParens(body.slice(openIndex, index + 1));
      }
    }
  }
  return undefined;
}

export function mergeSqlGraphs(graphs: SqlGraph[]): SqlGraph {
  const merged = emptyGraph();
  for (const graph of graphs) {
    merged.tables.push(...graph.tables);
    merged.relations.push(...graph.relations);
    merged.constraints.push(...graph.constraints);
    merged.policies.push(...graph.policies);
    merged.indexes.push(...graph.indexes);
    merged.triggers.push(...graph.triggers);
    merged.functions.push(...graph.functions);
    merged.views.push(...graph.views);
    merged.enums.push(...graph.enums);
    merged.extensions.push(...graph.extensions);
    merged.grants.push(...graph.grants);
    merged.materializedViews.push(...graph.materializedViews);
    merged.history.push(...graph.history);
  }
  merged.history.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.order - b.order || a.name.localeCompare(b.name));
  return merged;
}
