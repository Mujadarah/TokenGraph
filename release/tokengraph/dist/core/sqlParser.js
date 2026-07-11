function normalizeSqlName(name) {
    const segments = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < name.length; index += 1) {
        const char = name[index];
        const next = name[index + 1];
        if (char === '"') {
            current += char;
            if (quoted && next === '"') {
                current += next;
                index += 1;
            }
            else {
                quoted = !quoted;
            }
            continue;
        }
        if (char === "." && !quoted) {
            segments.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    segments.push(current);
    return segments
        .map((segment) => {
        const trimmed = segment.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed.slice(1, -1).replace(/""/g, '"');
        }
        return trimmed.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    })
        .join(".");
}
function stripOuterParens(value) {
    let text = value.trim();
    while (text.startsWith("(") && text.endsWith(")")) {
        let depth = 0;
        let wraps = true;
        for (let index = 0; index < text.length; index += 1) {
            const char = text[index];
            if (char === "(")
                depth += 1;
            if (char === ")")
                depth -= 1;
            if (depth === 0 && index < text.length - 1) {
                wraps = false;
                break;
            }
        }
        if (!wraps)
            break;
        text = text.slice(1, -1).trim();
    }
    return text;
}
function splitCommaList(value) {
    return value
        .split(",")
        .map(normalizeSqlName)
        .filter(Boolean);
}
function firstSqlToken(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('"')) {
        return trimmed.split(/\s+/)[0] ?? "";
    }
    for (let index = 1; index < trimmed.length; index += 1) {
        if (trimmed[index] !== '"')
            continue;
        if (trimmed[index + 1] === '"') {
            index += 1;
            continue;
        }
        return trimmed.slice(0, index + 1);
    }
    return trimmed;
}
function splitColumns(body) {
    const columns = [];
    let current = "";
    let depth = 0;
    for (const char of body) {
        if (char === "(")
            depth += 1;
        if (char === ")")
            depth = Math.max(0, depth - 1);
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
function sqlStatements(sql) {
    const statements = [];
    let current = "";
    let statementStart = 0;
    let state = "code";
    let dollarTag = "";
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        const next = sql[index + 1];
        if (state === "line-comment") {
            if (char === "\n") {
                state = "code";
                current += char;
            }
            continue;
        }
        if (state === "block-comment") {
            if (char === "*" && next === "/") {
                index += 1;
                state = "code";
            }
            else if (char === "\n") {
                current += char;
            }
            continue;
        }
        if (state === "single" || state === "double") {
            current += char;
            if (char === "\\") {
                if (next) {
                    current += next;
                    index += 1;
                }
                continue;
            }
            if ((state === "single" && char === "'") || (state === "double" && char === '"')) {
                state = "code";
            }
            continue;
        }
        if (state === "dollar") {
            current += char;
            if (dollarTag && sql.startsWith(dollarTag, index)) {
                current += dollarTag.slice(1);
                index += dollarTag.length - 1;
                dollarTag = "";
                state = "code";
            }
            continue;
        }
        if (char === "-" && next === "-") {
            index += 1;
            state = "line-comment";
            continue;
        }
        if (char === "/" && next === "*") {
            index += 1;
            state = "block-comment";
            continue;
        }
        if (char === "'") {
            state = "single";
            current += char;
            continue;
        }
        if (char === '"') {
            state = "double";
            current += char;
            continue;
        }
        if (char === "$") {
            const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
            if (match) {
                dollarTag = match[0];
                state = "dollar";
                current += dollarTag;
                index += dollarTag.length - 1;
                continue;
            }
        }
        current += char;
        if (char === ";") {
            if (current.trim()) {
                statements.push({ text: current, index: statementStart });
            }
            current = "";
            statementStart = index + 1;
        }
    }
    if (current.trim()) {
        statements.push({ text: current, index: statementStart });
    }
    const warningMessage = state === "dollar"
        ? "SQL parser reached end of file inside a dollar-quoted block; later statements may be unindexed."
        : state === "single"
            ? "SQL parser reached end of file inside a single-quoted string; later statements may be unindexed."
            : state === "double"
                ? "SQL parser reached end of file inside a double-quoted identifier; later statements may be unindexed."
                : undefined;
    return { statements, warningMessage };
}
function emptyGraph() {
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
        history: [],
        warnings: []
    };
}
export function parsePostgresMigration(filePath, sql) {
    const graph = emptyGraph();
    const scan = sqlStatements(sql);
    const statements = scan.statements;
    if (scan.warningMessage) {
        graph.warnings.push({ filePath, message: scan.warningMessage });
    }
    const history = [];
    const remember = (entry, position) => {
        history.push({ ...entry, filePath, order: 0, position });
    };
    const addConstraint = (constraint, position) => {
        graph.constraints.push(constraint);
        remember({ kind: "constraint", name: constraint.name, action: "create" }, position);
    };
    for (const statement of statements.filter((entry) => /^\s*create\s+extension\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+")|[\w-]+)/gi)) {
            const extension = { name: normalizeSqlName(match[1]), filePath };
            graph.extensions.push(extension);
            remember({ kind: "extension", name: extension.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+type\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+type\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+enum\s*\(([^)]*)\)/gi)) {
            const enumObject = {
                name: normalizeSqlName(match[1]),
                values: match[2]
                    .split(",")
                    .map((value) => normalizeSqlName(value.trim().replace(/^'/, "").replace(/'$/, "")))
                    .filter(Boolean),
                filePath
            };
            graph.enums.push(enumObject);
            remember({ kind: "enum", name: enumObject.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+table\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(([\s\S]*?)\)\s*;/gi)) {
            const tableName = normalizeSqlName(match[1]);
            const columnDefs = splitColumns(match[2]);
            const table = { name: tableName, columns: [], filePath };
            for (const columnDef of columnDefs) {
                const columnName = normalizeSqlName(firstSqlToken(columnDef));
                const namedConstraint = columnDef.match(/\bconstraint\s+("?[\w]+"?)\s+(primary\s+key|foreign\s+key|unique|check|exclude)\b([\s\S]*)/i);
                if (namedConstraint && /^\s*constraint\b/i.test(columnDef)) {
                    const kind = normalizeSqlName(namedConstraint[2]).toLowerCase();
                    const columnMatch = columnDef.match(/\(([^()]*)\)/);
                    const constraint = {
                        name: normalizeSqlName(namedConstraint[1]),
                        table: tableName,
                        kind,
                        columns: columnMatch && kind !== "check" ? splitCommaList(columnMatch[1]) : undefined,
                        expression: kind === "check" ? stripOuterParens(columnDef.slice(columnDef.toLowerCase().indexOf("check") + "check".length)) : undefined,
                        filePath
                    };
                    addConstraint(constraint, statement.index + (match.index ?? 0));
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
                table.columns.push(columnName);
                const inlineNamedConstraint = columnDef.match(/\bconstraint\s+("?[\w]+"?)\s+(primary\s+key|foreign\s+key|unique|check|exclude)\b/i);
                if (inlineNamedConstraint) {
                    addConstraint({
                        name: normalizeSqlName(inlineNamedConstraint[1]),
                        table: tableName,
                        kind: normalizeSqlName(inlineNamedConstraint[2]).toLowerCase(),
                        columns: [columnName],
                        filePath
                    }, statement.index + (match.index ?? 0));
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
            remember({ kind: "table", name: table.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*alter\s+table\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)\s+add\s+constraint\s+("?[\w]+"?)\s+(primary\s+key|foreign\s+key|unique|check|exclude)\b([\s\S]*?);/gi)) {
            const kind = normalizeSqlName(match[3]).toLowerCase();
            const columnMatch = match[4].match(/\(([^()]*)\)/);
            const constraint = {
                name: normalizeSqlName(match[2]),
                table: normalizeSqlName(match[1]),
                kind,
                columns: columnMatch && kind !== "check" ? splitCommaList(columnMatch[1]) : undefined,
                expression: kind === "check" ? stripOuterParens(match[4]) : undefined,
                filePath
            };
            graph.constraints.push(constraint);
            remember({ kind: "constraint", name: constraint.name, action: "alter" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+policy\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+policy\s+(?:"([^"]+)"|([\w_]+))\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)([\s\S]*?);/gi)) {
            const body = match[4] ?? "";
            const command = body.match(/\bfor\s+(\w+)/i)?.[1]?.toLowerCase();
            const roles = body
                .match(/\bto\s+([\s\S]*?)(?:\s+using\s*\(|\s+with\s+check\s*\(|$)/i)?.[1]
                ?.split(",")
                .map(normalizeSqlName)
                .filter(Boolean);
            const policy = {
                name: normalizeSqlName(match[1] ?? match[2]),
                table: normalizeSqlName(match[3]),
                command,
                roles,
                usingExpression: extractClauseExpression(body, "using"),
                checkExpression: extractClauseExpression(body, "with check"),
                filePath
            };
            graph.policies.push(policy);
            remember({ kind: "policy", name: policy.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+(?:unique\s+)?index\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?("?[\w]+"?)\s+on\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(([^)]+)\)/gi)) {
            graph.indexes.push({
                name: normalizeSqlName(match[1]),
                table: normalizeSqlName(match[2]),
                columns: match[3].split(",").map(normalizeSqlName),
                filePath
            });
            remember({ kind: "index", name: normalizeSqlName(match[1]), action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+(?:or\s+replace\s+)?function\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi)) {
            const fn = { name: normalizeSqlName(match[1]), filePath };
            graph.functions.push(fn);
            remember({ kind: "function", name: fn.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+trigger\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+trigger\s+("?[\w]+"?)[\s\S]*?\son\s+((?:"?[\w]+"?\.)?"?[\w]+"?)[\s\S]*?execute\s+(?:function|procedure)\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s*\(/gi)) {
            const trigger = {
                name: normalizeSqlName(match[1]),
                table: normalizeSqlName(match[2]),
                functionName: normalizeSqlName(match[3]),
                filePath
            };
            graph.triggers.push(trigger);
            remember({ kind: "trigger", name: trigger.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+(?:or\s+replace\s+)?view\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+(?:or\s+replace\s+)?view\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+/gi)) {
            const view = { name: normalizeSqlName(match[1]), filePath };
            graph.views.push(view);
            remember({ kind: "view", name: view.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*create\s+materialized\s+view\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/create\s+materialized\s+view\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+as\s+/gi)) {
            const materializedView = { name: normalizeSqlName(match[1]), filePath };
            graph.materializedViews.push(materializedView);
            remember({ kind: "materializedView", name: materializedView.name, action: "create" }, statement.index + (match.index ?? 0));
        }
    }
    for (const statement of statements.filter((entry) => /^\s*grant\b/i.test(entry.text))) {
        for (const match of statement.text.matchAll(/grant\s+([\w\s,]+?)\s+on\s+(?:(all\s+(tables|sequences|functions)\s+in\s+schema\s+("?[\w]+"?))|(?:(table|schema|sequence|function)\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?))\s+to\s+([^;]+)/gi)) {
            const privileges = splitCommaList(match[1]).map((privilege) => privilege.toLowerCase());
            const objectType = match[2] ? `all ${match[3].toLowerCase()} in schema` : match[5]?.toLowerCase();
            const objectName = normalizeSqlName(match[4] ?? match[6]);
            for (const grantee of splitCommaList(match[7])) {
                const grant = {
                    privileges,
                    objectType,
                    objectName,
                    grantee,
                    filePath
                };
                graph.grants.push(grant);
                remember({ kind: "grant", name: `${grant.objectName} to ${grant.grantee}`, action: "grant" }, statement.index + (match.index ?? 0));
            }
        }
    }
    graph.history = history
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map(({ position: _position, ...entry }, order) => ({ ...entry, order }));
    return graph;
}
function extractClauseExpression(body, clause) {
    const clauseRegex = clause === "using" ? /\busing\s*\(/i : /\bwith\s+check\s*\(/i;
    const match = clauseRegex.exec(body);
    if (!match)
        return undefined;
    const openIndex = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    for (let index = openIndex; index < body.length; index += 1) {
        const char = body[index];
        if (char === "(")
            depth += 1;
        if (char === ")") {
            depth -= 1;
            if (depth === 0) {
                return stripOuterParens(body.slice(openIndex, index + 1));
            }
        }
    }
    return undefined;
}
export function mergeSqlGraphs(graphs) {
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
        merged.warnings.push(...graph.warnings);
    }
    merged.history.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.order - b.order || a.name.localeCompare(b.name));
    return merged;
}
