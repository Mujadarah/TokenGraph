import { compressOutput } from "./compressor.js";
import { buildContextPlan } from "./planner.js";
import { estimateTokens, tokenize } from "./token.js";
const PATH_PATTERN = /(?:[A-Za-z]:[\\/])?[\w@./\\[\]-]+\.(?:ts|tsx|js|jsx|sql)(?::\d+:\d+)?/g;
function compressionKind(kind) {
    if (kind === "runtime")
        return "log";
    return kind;
}
function normalizePath(path) {
    const normalized = path.replace(/\\/g, "/");
    const match = normalized.match(/^(.*\.(?:ts|tsx|js|jsx|sql))(?::(\d+):\d+)?$/);
    return {
        path: match?.[1] ?? normalized,
        line: match?.[2] ? Number(match[2]) : undefined
    };
}
function unique(items) {
    return Array.from(new Set(items));
}
function detectPathHints(text, project) {
    const hints = [...text.matchAll(PATH_PATTERN)].map((match) => normalizePath(match[0]));
    for (const file of project.files) {
        if (text.includes(file.path) && !hints.some((hint) => hint.path === file.path)) {
            hints.push({ path: file.path });
        }
    }
    return hints.filter((hint) => project.files.some((file) => file.path === hint.path));
}
function detectTests(text) {
    const tests = [];
    for (const line of text.split(/\r?\n/).map((candidate) => candidate.trim())) {
        const failMatch = line.match(/^(?:FAIL|FAILURE|failed)\s+(.+)$/i);
        if (failMatch?.[1]) {
            tests.push(failMatch[1].replace(/\s+\(\d+\s*ms\)$/i, "").trim());
        }
    }
    return unique(tests);
}
function detectSymbols(text, project) {
    const terms = new Set(tokenize(text));
    return unique(project.symbols
        .filter((symbol) => text.includes(symbol.name) || terms.has(symbol.name.toLowerCase()))
        .map((symbol) => symbol.name));
}
function relatedImportEdges(project, paths) {
    const selected = new Set(paths);
    return project.imports.filter((edge) => selected.has(edge.filePath) || (edge.resolvedPath !== undefined && selected.has(edge.resolvedPath)));
}
function rankedFileFromPath(project, path, reason, line) {
    const file = project.files.find((candidate) => candidate.path === path);
    if (!file)
        return undefined;
    return {
        path,
        reason,
        score: line ? 100 : 80,
        ...(line ? { startLine: line, endLine: line } : {})
    };
}
function relatedFiles(project, hints, imports, planFiles) {
    const rows = [];
    for (const hint of hints) {
        const row = rankedFileFromPath(project, hint.path, hint.line ? "Stack trace references this exact line." : "Failure output references this file.", hint.line);
        if (row)
            rows.push(row);
    }
    for (const edge of imports) {
        const outbound = rankedFileFromPath(project, edge.filePath, "Import graph connects this file to a detected failure path.");
        const inbound = edge.resolvedPath ? rankedFileFromPath(project, edge.resolvedPath, "Import graph connects this target to a detected failure path.") : undefined;
        if (outbound)
            rows.push(outbound);
        if (inbound)
            rows.push(inbound);
    }
    rows.push(...planFiles);
    const seen = new Set();
    return rows
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .filter((row) => {
        if (seen.has(row.path))
            return false;
        seen.add(row.path);
        return true;
    })
        .slice(0, 10);
}
function sqlMatches(project, termsText, plannedSql) {
    const terms = tokenize(termsText);
    const score = (text) => terms.reduce((total, term) => total + (text.toLowerCase().includes(term) ? 1 : 0), 0);
    const direct = [
        ...project.sql.tables.map((table) => ({
            kind: "table",
            name: table.name,
            filePath: table.filePath,
            reason: `Table columns: ${table.columns.join(", ")}`,
            score: score(`${table.name} ${table.columns.join(" ")}`)
        })),
        ...project.sql.policies.map((policy) => ({
            kind: "policy",
            name: policy.name,
            filePath: policy.filePath,
            reason: `Policy on ${policy.table}${policy.command ? ` for ${policy.command}` : ""}`,
            score: score(`${policy.name} ${policy.table} ${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`)
        }))
    ].filter((row) => row.score > 0);
    const byKey = new Map();
    for (const row of [...direct, ...plannedSql]) {
        byKey.set(`${row.kind}:${row.name}:${row.filePath}`, row);
    }
    return Array.from(byKey.values()).sort((a, b) => b.score - a.score).slice(0, 10);
}
function recommendedCommands(kind, detectedTests, detectedPaths) {
    if (kind === "test") {
        const testPath = detectedPaths.find((path) => /\.test\.[tj]sx?$/.test(path)) ?? detectedTests[0]?.split(/\s+>\s+/)[0];
        return testPath ? [`pnpm test -- ${testPath}`] : ["pnpm test"];
    }
    if (kind === "build")
        return ["pnpm build", "pnpm typecheck"];
    if (kind === "install")
        return ["pnpm install"];
    return ["rerun the failing command with the same inputs"];
}
function buildHypotheses(input) {
    const evidence = [
        ...input.detectedTests.slice(0, 2),
        ...input.detectedPaths.slice(0, 3),
        ...input.detectedSymbols.slice(0, 3),
        ...input.relatedSql.slice(0, 2).map((item) => `${item.kind}:${item.name}`),
        ...input.relatedMemories.slice(0, 2).map((memory) => `memory:${memory.title}`)
    ];
    const confidence = input.detectedPaths.length && input.detectedSymbols.length ? "high" : input.detectedPaths.length ? "medium" : "low";
    return [
        {
            label: "hypothesis",
            statement: input.detectedPaths.length
                ? `The failure is likely rooted near ${input.detectedPaths.slice(0, 3).join(", ")}.`
                : "The failure needs a targeted first read because no indexed path was detected.",
            confidence,
            evidence
        }
    ];
}
export async function traceFailure(input) {
    const compressedOutput = compressOutput({ kind: compressionKind(input.kind), text: input.text, maxLines: 20 });
    const task = input.task?.trim() || compressedOutput.summary;
    const pathHints = detectPathHints(input.text, input.project);
    const detectedPaths = unique(pathHints.map((hint) => hint.path));
    const detectedTests = detectTests(input.text);
    const detectedSymbols = detectSymbols(input.text, input.project);
    const imports = relatedImportEdges(input.project, detectedPaths);
    const plan = await buildContextPlan({
        root: input.root,
        task: `${task}\n${compressedOutput.keyLines.join("\n")}`,
        project: input.project,
        memories: input.memories,
        budget: {
            profile: input.profile ?? "balanced",
            maxFiles: 6,
            maxSqlObjects: 6,
            maxMemories: 4,
            allowRawReads: false
        }
    });
    const relatedSql = sqlMatches(input.project, `${task}\n${input.text}`, plan.relevantSql);
    const relatedMemories = plan.relevantMemories;
    const files = relatedFiles(input.project, pathHints, imports, plan.relevantFiles);
    const hypotheses = buildHypotheses({ detectedPaths, detectedTests, detectedSymbols, relatedSql, relatedMemories });
    const firstReads = relatedFiles(input.project, pathHints, imports, plan.recommendedFirstReads).slice(0, 6);
    const confidence = hypotheses[0]?.confidence ?? "low";
    return {
        compressedOutput,
        detectedPaths,
        detectedSymbols,
        detectedTests,
        relatedFiles: files,
        relatedImports: imports,
        relatedSql,
        relatedMemories,
        hypotheses,
        recommendedFirstReads: firstReads,
        recommendedCommands: recommendedCommands(input.kind, detectedTests, detectedPaths),
        confidence,
        tokenEstimate: {
            original: estimateTokens(input.text),
            compressed: compressedOutput.estimatedTokens.compressed,
            avoided: compressedOutput.estimatedTokens.avoided
        }
    };
}
