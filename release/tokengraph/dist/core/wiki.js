import { estimateTokens } from "./token.js";
export const CURRENT_WIKI_SCHEMA_VERSION = 1;
const LIST_LIMIT = 20;
function page(slug, title, lines) {
    const body = [`# ${title}`, "", ...lines].join("\n").trimEnd() + "\n";
    return {
        slug,
        title,
        body,
        estimatedTokens: estimateTokens(body)
    };
}
function topLevelDirectory(path) {
    const [first] = path.split("/");
    return first || ".";
}
function cappedLines(items, render, limit = LIST_LIMIT) {
    const visible = items.slice(0, limit).map(render);
    const remaining = items.length - visible.length;
    return remaining > 0 ? [...visible, `- and ${remaining} more`] : visible;
}
function byPath(a, b) {
    return (a.path ?? a.filePath ?? "").localeCompare(b.path ?? b.filePath ?? "");
}
function buildOverviewPage(index) {
    const kindCounts = new Map();
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
    return page("overview", "Project Overview", lines);
}
function exportedSymbolsForFile(index, filePath) {
    const names = index.symbols
        .filter((symbol) => symbol.filePath === filePath && symbol.exported)
        .map((symbol) => symbol.name)
        .sort();
    return names.length ? `exports ${names.join(", ")}` : "exports none";
}
function buildStructurePage(index) {
    const files = [...index.files].sort(byPath);
    const grouped = new Map();
    for (const file of files) {
        const directory = topLevelDirectory(file.path);
        grouped.set(directory, [...(grouped.get(directory) ?? []), file]);
    }
    const lines = [];
    for (const [directory, entries] of Array.from(grouped).sort(([a], [b]) => a.localeCompare(b))) {
        if (lines.length) {
            lines.push("");
        }
        lines.push(`## ${directory}`);
        lines.push(...cappedLines(entries, (file) => `- ${file.path} (${file.kind}) ${exportedSymbolsForFile(index, file.path)}`));
    }
    return page("structure", "Project Structure", lines);
}
function buildRoutesPage(index) {
    const routes = index.files
        .filter((file) => file.route)
        .sort((a, b) => (a.route ?? "").localeCompare(b.route ?? "") || a.path.localeCompare(b.path));
    if (!routes.length) {
        return undefined;
    }
    return page("routes", "Routes", cappedLines(routes, (file) => `- ${file.route} -> ${file.path}`));
}
function hasDatabaseContent(index) {
    return (index.sql.tables.length > 0 ||
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
        index.sql.history.length > 0);
}
function buildDatabasePage(index) {
    if (!hasDatabaseContent(index)) {
        return undefined;
    }
    const lines = [];
    if (index.sql.tables.length) {
        lines.push("## Tables");
        lines.push(...cappedLines([...index.sql.tables].sort((a, b) => a.name.localeCompare(b.name)), (table) => `- Table ${table.name}`));
    }
    if (index.sql.policies.length) {
        if (lines.length)
            lines.push("");
        lines.push("## Policies");
        lines.push(...cappedLines([...index.sql.policies].sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)), (policy) => `- Policy ${policy.name} on ${policy.table}${policy.command ? ` for ${policy.command}` : ""}`));
    }
    if (index.sql.materializedViews.length) {
        if (lines.length)
            lines.push("");
        lines.push("## Materialized Views");
        lines.push(...cappedLines([...index.sql.materializedViews].sort((a, b) => a.name.localeCompare(b.name)), (view) => `- Materialized view ${view.name}`));
    }
    if (index.sql.history.length) {
        if (lines.length)
            lines.push("");
        lines.push("## Migration History");
        const history = [...index.sql.history].sort((a, b) => a.order - b.order || a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
        const visible = history.slice(0, LIST_LIMIT).map((entry, index) => `${index + 1}. ${entry.kind} ${entry.name} (${entry.action}; ${entry.filePath})`);
        lines.push(...visible);
        if (history.length > visible.length) {
            lines.push(`- and ${history.length - visible.length} more`);
        }
    }
    return page("database", "Database", lines);
}
function buildDecisionsPage(memories) {
    if (!memories.length) {
        return undefined;
    }
    const sorted = [...memories].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return page("decisions", "Recorded Decisions", cappedLines(sorted, (memory) => `- ${memory.title} (${memory.type}; tags: ${memory.tags.slice().sort().join(", ") || "none"})`));
}
export function buildProjectWiki(index, memories) {
    const maybePages = [
        buildOverviewPage(index),
        buildStructurePage(index),
        buildRoutesPage(index),
        buildDatabasePage(index),
        buildDecisionsPage(memories)
    ];
    return {
        schemaVersion: CURRENT_WIKI_SCHEMA_VERSION,
        fingerprint: index.fingerprint,
        pages: maybePages.filter((candidate) => Boolean(candidate))
    };
}
