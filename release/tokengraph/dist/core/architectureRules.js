import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const DEFAULT_SEVERITY = "warning";
const CURRENT_RULES_SCHEMA_VERSION = 1;
function nowIso() {
    return new Date().toISOString();
}
function normalizeRule(input) {
    const timestamp = nowIso();
    return {
        ...input,
        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        enabled: input.enabled ?? true,
        severity: input.severity ?? DEFAULT_SEVERITY,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}
function matchesPattern(pattern, value) {
    if (!pattern)
        return true;
    if (!value)
        return false;
    try {
        return new RegExp(pattern).test(value);
    }
    catch {
        return value.includes(pattern);
    }
}
function pushFinding(report, finding) {
    if (finding.severity === "error") {
        report.violations.push(finding);
    }
    else {
        report.warnings.push(finding);
    }
}
function importTarget(edge) {
    return edge.resolvedPath ?? edge.source;
}
export class ArchitectureRuleStore {
    filePath;
    static writeChains = new Map();
    constructor(filePath) {
        this.filePath = filePath;
    }
    async list() {
        try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
            const records = Array.isArray(parsed)
                ? parsed
                : parsed && typeof parsed === "object" && Array.isArray(parsed.rules)
                    ? parsed.rules
                    : [];
            return records.filter(isArchitectureRule);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            if (error instanceof SyntaxError) {
                await this.quarantineCorruptFile();
                return [];
            }
            throw error;
        }
    }
    async add(input) {
        return this.enqueueWrite(async () => {
            const rules = await this.list();
            const rule = normalizeRule(input);
            rules.push(rule);
            await this.writeAtomic(rules);
            return rule;
        });
    }
    async update(id, update) {
        return this.enqueueWrite(async () => {
            const rules = await this.list();
            const index = rules.findIndex((rule) => rule.id === id);
            if (index === -1)
                return undefined;
            const current = rules[index];
            const next = {
                ...current,
                ...update,
                id: current.id,
                createdAt: current.createdAt,
                enabled: update.enabled ?? current.enabled,
                severity: update.severity ?? current.severity,
                updatedAt: nowIso()
            };
            rules[index] = next;
            await this.writeAtomic(rules);
            return next;
        });
    }
    async delete(id) {
        return this.enqueueWrite(async () => {
            const rules = await this.list();
            const next = rules.filter((rule) => rule.id !== id);
            await this.writeAtomic(next);
            return next.length !== rules.length;
        });
    }
    async enqueueWrite(operation) {
        const key = resolve(this.filePath);
        const previous = ArchitectureRuleStore.writeChains.get(key) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        ArchitectureRuleStore.writeChains.set(key, current.then(() => undefined, () => undefined));
        return current;
    }
    async writeAtomic(rules) {
        const directory = dirname(this.filePath);
        await mkdir(directory, { recursive: true });
        const tempPath = join(directory, `.rules-${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
        try {
            await writeFile(tempPath, `${JSON.stringify({
                schemaVersion: CURRENT_RULES_SCHEMA_VERSION,
                rules
            }, null, 2)}\n`);
            await rename(tempPath, this.filePath);
        }
        finally {
            await rm(tempPath, { force: true });
        }
    }
    async quarantineCorruptFile() {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
        try {
            await rename(this.filePath, corruptPath);
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }
}
function isArchitectureRule(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (typeof candidate.id === "string" &&
        typeof candidate.name === "string" &&
        typeof candidate.type === "string" &&
        typeof candidate.enabled === "boolean" &&
        typeof candidate.severity === "string" &&
        typeof candidate.createdAt === "string" &&
        typeof candidate.updatedAt === "string");
}
export async function checkArchitecture(input) {
    const activeRules = input.rules.filter((rule) => rule.enabled);
    const checkedFiles = input.files?.length ? input.files : input.project.files.filter((file) => !file.isTest).map((file) => file.path);
    const report = {
        status: "checked",
        root: input.root,
        ruleCount: activeRules.length,
        checkedFiles,
        violations: [],
        warnings: []
    };
    applyRuleChecks(input.project, activeRules, checkedFiles, report);
    applySqlWarnings(input.project, report);
    await applyMarketplaceWarnings(input.root, report);
    return report;
}
function applyRuleChecks(project, rules, checkedFiles, report) {
    for (const rule of rules) {
        if (rule.type === "forbidden-import") {
            for (const edge of project.imports) {
                const target = importTarget(edge);
                if (matchesPattern(rule.fromPattern, edge.filePath) && matchesPattern(rule.targetPattern, target)) {
                    pushFinding(report, {
                        type: rule.type,
                        severity: rule.severity,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        filePath: edge.filePath,
                        targetPath: edge.resolvedPath,
                        importSource: edge.source,
                        message: rule.message ?? `${edge.filePath} imports forbidden target ${target}.`
                    });
                }
            }
        }
        if (rule.type === "required-import") {
            for (const file of project.files.filter((candidate) => matchesPattern(rule.fromPattern ?? rule.modulePattern, candidate.path))) {
                const hasRequiredImport = project.imports.some((edge) => edge.filePath === file.path && matchesPattern(rule.targetPattern, importTarget(edge)));
                if (!hasRequiredImport) {
                    pushFinding(report, {
                        type: rule.type,
                        severity: rule.severity,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        filePath: file.path,
                        message: rule.message ?? `${file.path} is missing required import matching ${rule.targetPattern ?? "<unspecified>"}.`
                    });
                }
            }
        }
        if (rule.type === "dependency-direction") {
            for (const edge of project.imports) {
                const target = importTarget(edge);
                const fromMatches = matchesPattern(rule.fromPattern, edge.filePath);
                const violatesAllowedTarget = rule.allowedTargetPattern ? !matchesPattern(rule.allowedTargetPattern, target) : matchesPattern(rule.targetPattern, target);
                if (fromMatches && violatesAllowedTarget) {
                    pushFinding(report, {
                        type: rule.type,
                        severity: rule.severity,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        filePath: edge.filePath,
                        targetPath: edge.resolvedPath,
                        importSource: edge.source,
                        message: rule.message ?? `${edge.filePath} imports ${target}, which violates dependency direction rule ${rule.name}.`
                    });
                }
            }
        }
        if (rule.type === "required-test") {
            const testPattern = rule.testPattern;
            for (const filePath of checkedFiles.filter((filePath) => matchesPattern(rule.modulePattern, filePath))) {
                const hasTest = project.files.some((file) => file.isTest && (matchesPattern(testPattern, file.path) || file.path.includes(filePath.replace(/\.[^.]+$/, ""))));
                if (!hasTest) {
                    pushFinding(report, {
                        type: rule.type,
                        severity: rule.severity,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        filePath,
                        message: rule.message ?? `${filePath} is missing a required test matching ${testPattern ?? "the module name"}.`
                    });
                }
            }
        }
        if (rule.type === "naming-convention" && rule.namePattern) {
            for (const symbol of project.symbols.filter((candidate) => matchesPattern(rule.modulePattern, candidate.filePath))) {
                if (!matchesPattern(rule.namePattern, symbol.name)) {
                    pushFinding(report, {
                        type: rule.type,
                        severity: rule.severity,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        filePath: symbol.filePath,
                        message: rule.message ?? `${symbol.name} does not match naming pattern ${rule.namePattern}.`
                    });
                }
            }
        }
    }
}
function applySqlWarnings(project, report) {
    const policiesByTable = new Map(project.sql.policies.map((policy) => [policy.table, policy]));
    for (const table of project.sql.tables) {
        const hasTenantColumn = table.columns.some((column) => column.toLowerCase() === "tenant_id");
        if (hasTenantColumn && !policiesByTable.has(table.name)) {
            report.warnings.push({
                type: "tenant-isolation",
                severity: "warning",
                sqlObject: table.name,
                filePath: table.filePath,
                message: `${table.name} has tenant_id but no indexed RLS policy.`
            });
        }
    }
    for (const policy of project.sql.policies) {
        if (!policy.usingExpression && !policy.checkExpression) {
            report.warnings.push({
                type: "rls",
                severity: "warning",
                sqlObject: policy.table,
                filePath: policy.filePath,
                message: `Policy ${policy.name} has no indexed USING or WITH CHECK expression.`
            });
        }
    }
    for (const grant of project.sql.grants) {
        report.warnings.push({
            type: "grant",
            severity: "warning",
            sqlObject: grant.objectName,
            filePath: grant.filePath,
            message: `Grant ${grant.privileges.join(", ")} on ${grant.objectName} to ${grant.grantee} should be reviewed.`
        });
    }
    const sqlNames = [
        ...project.sql.tables.map((item) => ({ name: item.name, filePath: item.filePath })),
        ...project.sql.functions.map((item) => ({ name: item.name, filePath: item.filePath })),
        ...project.sql.triggers.map((item) => ({ name: item.name, filePath: item.filePath })),
        ...project.sql.views.map((item) => ({ name: item.name, filePath: item.filePath }))
    ];
    for (const item of sqlNames) {
        if (/auth/i.test(item.name)) {
            report.warnings.push({ type: "auth", severity: "warning", sqlObject: item.name, filePath: item.filePath, message: `${item.name} appears auth-sensitive.` });
        }
        if (/audit/i.test(item.name)) {
            report.warnings.push({
                type: "audit-logging",
                severity: "warning",
                sqlObject: item.name,
                filePath: item.filePath,
                message: `${item.name} appears audit-log-sensitive.`
            });
        }
    }
}
async function applyMarketplaceWarnings(root, report) {
    try {
        const marketplace = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
        const plugin = marketplace.plugins?.find((candidate) => candidate.name === "tokengraph");
        const sourcePath = plugin?.source?.path;
        const markedDevelopmentOnly = plugin?.developmentOnly === true || plugin?.policy?.developmentOnly === true;
        if (sourcePath === "./plugins/tokengraph" && !markedDevelopmentOnly) {
            report.warnings.push({
                type: "marketplace-target",
                severity: "warning",
                sourcePath,
                message: "Normal marketplace points to the maintainer source plugin. Use ./release/tokengraph or mark the entry developmentOnly."
            });
        }
    }
    catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
            throw error;
        }
    }
}
