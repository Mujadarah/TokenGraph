import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { externalRuntimeEnvironment, externalRuntimeRoot, externalServerEntry } from "./support/externalRuntime.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const coreToolNames = [
  "tokengraph_analyze", "tokengraph_compress", "tokengraph_prepare_context", "tokengraph_propose_knowledge",
  "tokengraph_query_context", "tokengraph_recall", "tokengraph_setup", "tokengraph_task_report"
];
const legacyToolNames = [
  "tokengraph_add_rule", "tokengraph_assess_change_risk", "tokengraph_check_architecture", "tokengraph_compress_context",
  "tokengraph_compress_output", "tokengraph_confirm_memory", "tokengraph_delete_memory", "tokengraph_delete_rule",
  "tokengraph_deprecate_memory", "tokengraph_explain_symbol", "tokengraph_export_project_map", "tokengraph_find_memory_conflicts",
  "tokengraph_generate_wiki", "tokengraph_get_config", "tokengraph_index_project", "tokengraph_index_status",
  "tokengraph_link_memory", "tokengraph_list_rules", "tokengraph_plan_context", "tokengraph_project_map",
  "tokengraph_recall_memory", "tokengraph_remember_decision", "tokengraph_reset_project", "tokengraph_review_memories",
  "tokengraph_search_graph", "tokengraph_set_profile", "tokengraph_setup_status", "tokengraph_show_token_savings",
  "tokengraph_show_wiki_page", "tokengraph_summarize_sql", "tokengraph_trace_failure", "tokengraph_update_config",
  "tokengraph_update_memory", "tokengraph_update_rule"
];
const requiredFocusedSkillDirs = [
  "graph-context-retrieval",
  "root-cause-debugger",
  "architecture-consistency-checker",
  "context-compression",
  "regression-detector",
  "token-budget-optimizer",
  "memory-curator",
  "release-packaging-auditor"
];
const renamedNativeFixtures = [
  { format: "PE", source: ["native-lock", "win32-x64", "tokengraph-lock.win32-x64.node"] },
  { format: "ELF", source: ["native-lock", "linux-x64-gnu", "tokengraph-lock.linux-x64.node"] },
  { format: "Mach-O", source: ["native-lock", "darwin-x64", "tokengraph-lock.darwin-x64.node"] }
] as const;
const exactPackagedAssets = [
  "grammars/tree-sitter-go.wasm",
  "grammars/tree-sitter-java.wasm",
  "grammars/tree-sitter-python.wasm",
  "grammars/tree-sitter-rust.wasm",
  "grammars/web-tree-sitter.wasm",
  "native-lock/THIRD_PARTY_NOTICES.txt",
  ...renamedNativeFixtures.map(({ source }) => source.join("/")),
  "native-lock/darwin-arm64/tokengraph-lock.darwin-arm64.node",
  "native-lock/linux-arm64-gnu/tokengraph-lock.linux-arm64.node",
  "native-lock/manifest.json",
  "native-lock/win32-arm64/tokengraph-lock.win32-arm64.node"
].sort();
const exactPackagedPluginPaths = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".mcp.claude.json",
  ".mcp.json",
  ...exactPackagedAssets.map((path) => `assets/${path}`),
  "dist/cli.js",
  "dist/hooks.js",
  "dist/index.js",
  "dist/polyglot-worker.js",
  "dist/typescript-worker.cjs",
  "hooks/hooks.json",
  "LICENSE",
  "NOTICE",
  "package.json",
  "README.md",
  ...[...requiredFocusedSkillDirs, "tokengraph"].map((skill) => `skills/${skill}/SKILL.md`)
].sort();

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-"));
  tempRoots.push(root);
  return root;
}

async function makePackageRepositoryCopy(): Promise<{ copiedPlugin: string; repoCopy: string }> {
  const sandbox = await makeRoot();
  const repoCopy = join(sandbox, "repo");
  const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
  await mkdir(join(repoCopy, "plugins"), { recursive: true });
  await cp(process.cwd(), copiedPlugin, {
    recursive: true,
    filter: (source) => !["node_modules", ".superpowers", ".tokengraph", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
  });
  await cp(resolve("node_modules", "fflate"), join(copiedPlugin, "node_modules", "fflate"), { recursive: true });
  await cp(resolve("..", "..", "LICENSE"), join(repoCopy, "LICENSE"));
  await cp(resolve("..", "..", "NOTICE"), join(repoCopy, "NOTICE"));
  return { copiedPlugin, repoCopy };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tokengraph CLI smoke command", () => {
  it("validates the built stdio MCP server against a local project root", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--root", root, "--server", externalServerEntry, "--json"],
      { cwd: process.cwd(), env: externalRuntimeEnvironment() }
    );

    const report = JSON.parse(stdout) as {
      status: string;
      root: string;
      tools: string[];
      indexStateBeforeMap: string;
      filesIndexed: number;
      wikiPageSlugs: string[];
      wikiStatus: string;
    };

    expect(report).toMatchObject({
      status: "ok",
      root,
      indexStateBeforeMap: "missing",
      filesIndexed: 1,
      wikiStatus: "missing"
    });
    expect(report.wikiPageSlugs).toEqual([]);
    expect(report.tools).toEqual(coreToolNames);
    expect(report).toMatchObject({ toolSurface: "core", taskId: expect.any(String) });
  }, process.platform === "win32" ? 30_000 : 15_000);

  it("validates the opt-in full MCP surface", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--root", root, "--server", externalServerEntry, "--surface", "full", "--json"],
      { cwd: process.cwd(), env: externalRuntimeEnvironment() }
    );
    const report = JSON.parse(stdout) as { status: string; toolSurface: string; tools: string[] };
    expect(report).toMatchObject({ status: "ok", toolSurface: "full" });
    expect(report.tools).toEqual([...coreToolNames, ...legacyToolNames].sort());
  });

  it("rejects a full surface with one legacy name replaced despite retaining 42 unique tools", async () => {
    const root = await makeRoot();
    const serverRoot = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    const built = await readFile(resolve("dist", "index.js"), "utf8");
    expect(built).toContain("tokengraph_update_rule");
    const mutatedServer = join(serverRoot, "mutated-server.js");
    await writeFile(mutatedServer, built.replaceAll("tokengraph_update_rule", "tokengraph_fake_rule"));

    await expect(execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--root", root, "--server", mutatedServer, "--surface", "full", "--json"],
      { cwd: process.cwd() }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/tool surface|missing|unexpected/i) });
  });

  it("discloses smoke writes in help text", async () => {
    const { stdout } = await execFileAsync(process.execPath, [resolve("scripts", "smoke.mjs"), "--help"], { cwd: process.cwd() });
    expect(stdout).toMatch(/may write[\s\S]*\.tokengraph[\s\S]*(index|wiki)[\s\S]*task-ledger/i);
    expect(stdout).not.toMatch(/calling read-only project context tools/i);
  });

  it("checks README tool coverage for every previously omitted MCP tool", async () => {
    const readme = await readFile("README.md", "utf8");
    for (const toolName of [
      "tokengraph_compress_output",
      "tokengraph_explain_symbol",
      "tokengraph_plan_context",
      "tokengraph_project_map",
      "tokengraph_remember_decision",
      "tokengraph_search_graph",
      "tokengraph_show_token_savings",
      "tokengraph_summarize_sql"
    ]) {
      expect(readme).toContain(`\`${toolName}\``);
    }
  });

  it("accepts the literal pnpm argument separator before smoke options", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--", "--root", root, "--server", externalServerEntry, "--json"],
      { cwd: process.cwd(), env: externalRuntimeEnvironment() }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      status: "ok",
      root,
      filesIndexed: 1
    });
  });

  it("fails clearly when an option value is missing", async () => {
    await expect(
      execFileAsync(process.execPath, [resolve("scripts", "smoke.mjs"), "--root"], { cwd: process.cwd() })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--root requires a value")
    });
  });

  it("runs from a copied plugin cache without node_modules", async () => {
    const cacheParent = await makeRoot();
    const cacheRoot = join(cacheParent, "plugin");
    const projectRoot = await makeRoot();
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    await cp(externalRuntimeRoot, cacheRoot, { recursive: true });
    await cp(resolve(".codex-plugin"), join(cacheRoot, ".codex-plugin"), { recursive: true });
    await cp(resolve(".mcp.json"), join(cacheRoot, ".mcp.json"));

    await expect(access(join(cacheRoot, "node_modules"))).rejects.toThrow();
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--root", projectRoot, "--server", join(cacheRoot, "dist", "index.js"), "--json"],
      { cwd: process.cwd(), env: externalRuntimeEnvironment() }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      status: "ok",
      root: projectRoot,
      filesIndexed: 1
    });
  });
});

describe("tokengraph benchmark harness and trust docs", () => {
  it("reports all benchmark task categories with honest metric fields", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "benchmark.mjs"), "--json"],
      { cwd: process.cwd() }
    );
    const report = JSON.parse(stdout) as {
      schemaId: string;
      corpusVersion: string;
      tasks: Array<{
        category: string;
        metrics: Record<string, unknown>;
      }>;
      aggregate: { taskCount: number; categoryCounts: Record<string, number>; medianNetSavings: number; criticalConstraintPreservationRate: number; criticalFalseNegativeCount: number; requiredFileRecall: number; taskFailures: string[] };
      exactSliceAccounting: { taskCount: number; targetedReadCallCount: number; targetedReadTokens: number; taskIds: string[] };
      releaseGate: { passed: boolean; failureReasons: string[] };
      calibration: { categories: Record<string, { observations: number; confidence: string }> };
    };

    expect(report.schemaId).toBe("tokengraph-evidence-benchmark-report");
    expect(report.corpusVersion).toBe("evidence-v1");
    expect(report.aggregate.taskCount).toBe(30);
    expect(Object.keys(report.aggregate.categoryCounts).sort()).toEqual([
      "change-risk",
      "code-routing",
      "compression",
      "debugging",
      "memory-wiki",
      "release-packaging",
      "sql-security"
    ]);
    expect(report.aggregate).toMatchObject({
      criticalConstraintPreservationRate: 1,
      criticalFalseNegativeCount: 0,
      requiredFileRecall: 1,
      medianNetSavings: 180.53333333333333,
      executionInclusiveP25: 38.53333333333333,
      nonNegativeActivatedRate: expect.any(Number),
      taskFailures: []
    });
    expect(report.exactSliceAccounting).toEqual({
      taskCount: 4,
      targetedReadCallCount: 4,
      targetedReadTokens: 711,
      taskIds: ["code-routing-02", "debugging-01", "debugging-03", "debugging-04"]
    });
    expect(report.releaseGate).toMatchObject({ passed: true, failureReasons: [] });
    for (const task of report.tasks) {
      expect(task.metrics).toMatchObject({
        requiredFileRecall: expect.any(Number),
        falsePositives: expect.any(Array),
        falseNegatives: expect.any(Array),
        criticalConstraintPreservation: expect.any(Number),
        recommendedTests: expect.any(Array),
        rawTokens: expect.any(Number),
        compactTokens: expect.any(Number),
        toolOverheadTokens: expect.any(Number),
        netEstimatedSavings: expect.any(Number),
        failureReasons: expect.any(Array)
      });
    }
    expect(Object.values(report.calibration.categories).every((entry) => entry.observations < 10 && entry.confidence === "low")).toBe(true);
  });

  it("ships benchmark and trust documentation with required cautionary statements", async () => {
    const repoRoot = resolve("..", "..");
    const benchmarkFiles = ["methodology.md", "results-current.md", "fixtures.md"];
    for (const file of benchmarkFiles) {
      await expect(access(resolve(repoRoot, "docs", "benchmarks", file))).resolves.toBeUndefined();
    }
    const benchmarkResults = await readFile(resolve(repoRoot, "docs", "benchmarks", "results-current.md"), "utf8");
    expect(benchmarkResults).toMatch(/22 of 27 activated tasks are non-negative/i);
    expect(benchmarkResults).toMatch(/execution-inclusive median.*\+172\.3/i);
    expect(benchmarkResults).toMatch(/low-confidence/i);
    expect(benchmarkResults).not.toMatch(/third.*(?:remain|campaign).*incomplete|three-repository B6 target is not met/is);
    const benchmarkMethodology = await readFile(resolve(repoRoot, "docs", "benchmarks", "methodology.md"), "utf8");
    expect(benchmarkMethodology).toMatch(/\+172\.3-token activated-task median.*\+38\.3-token p25/i);

    const trustFiles = ["privacy.md", "security.md", "permissions.md", "local-storage.md", "limitations.md", "release-install.md"];
    const trustText = (
      await Promise.all(trustFiles.map((file) => readFile(resolve(repoRoot, "docs", "trust", file), "utf8")))
    ).join("\n");

    expect(trustText).toMatch(/local-first/i);
    expect(trustText).toMatch(/does not require an OpenAI API key/i);
    expect(trustText).toMatch(/does not require cloud sync/i);
    expect(trustText).toMatch(/does not require embeddings service/i);
    expect(trustText).toMatch(/respects \.gitignore/i);
    expect(trustText).toMatch(/excludes secrets by default/i);
    expect(trustText).toMatch(/Users can delete indexes and memories/i);
    expect(trustText).toMatch(/SQL indexing can be disabled/i);
    expect(trustText).toMatch(/Memory can be disabled/i);
    expect(trustText).toMatch(/Token savings are estimates/i);
    expect(trustText).toMatch(/does not replace code review/i);
    expect(trustText).toMatch(/does not guarantee correctness/i);
    expect(trustText).toMatch(/not a clinical, legal, or regulated-domain decision system/i);

    const securityText = await readFile(resolve(repoRoot, "docs", "trust", "security.md"), "utf8");
    const privacyText = await readFile(resolve(repoRoot, "docs", "trust", "privacy.md"), "utf8");
    for (const text of [securityText, privacyText]) {
      expect(text).toMatch(/best effort.*not a guarantee/is);
      expect(text).toMatch(/\.tokengraph\/runs\/.*plaintext/is);
      expect(text).toMatch(/do not invoke.*tokengraph run/is);
      expect(text).toMatch(/regulated|highly sensitive/is);
      expect(text).toMatch(/not encrypted today.*future.*local encryption/is);
    }
    const trustSources = ["CLAUDE_PROJECT_DIR", "TOKENGRAPH_WORKSPACE_ROOT", "MCP Roots", "process working directory"];
    const trustPositions = trustSources.map((source) => securityText.indexOf(source));
    expect(trustPositions.every((position) => position >= 0)).toBe(true);
    expect(trustPositions).toEqual([...trustPositions].sort((left, right) => left - right));
    expect(securityText).toMatch(/process working directory.*not running from an installed plugin directory/is);

    const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");
    const pluginReadme = await readFile(resolve("README.md"), "utf8");
    expect(readme).toMatch(/indexes TypeScript, JavaScript, SQL, Markdown, Python, Go, Rust, and Java by default/i);
    expect(readme).toMatch(/WASM.*promotion|promotion.*WASM/is);
    expect(readme).toMatch(/process working directory.*not running from an installed plugin directory/is);
    for (const text of [readme, pluginReadme]) {
      expect(text).toMatch(/none\s*\|\s*low\s*\|\s*medium\s*\|\s*high/i);
      expect(text).toMatch(/four.*exact.*slice.*711|711.*four.*exact.*slice/is);
      expect(text).toMatch(/fixture.*real-host|real-host.*fixture/is);
      expect(text).toMatch(/2026-07-22-tokengraph-codex-manifest\.json/);
      expect(text).toMatch(/2026-07-22-tokengraph-codex-report\.md/);
      expect(text).toMatch(/2026-07-22-ts-reset-codex-report\.md/);
      expect(text).toMatch(/2026-07-22-nextbase-codex-report\.md/);
      expect(text).toMatch(/three repositories/i);
      expect(text).toMatch(/promotion.*disabled|enforcement.*disabled/is);
      expect(text).toMatch(/multi-repository B6.*(?:target|coverage).*(?:met|complete)/is);
      expect(text).not.toMatch(/every frozen.*gate did not pass/is);
      expect(text).toMatch(/not all frozen.*gates passed/is);
    }

    const hooksSource = await readFile(resolve("src", "hooks.ts"), "utf8");
    expect(hooksSource).toMatch(/host plugin-data directory.*not.*workspace.*\.tokengraph/i);
    const buildSource = await readFile(resolve("scripts", "build.mjs"), "utf8");
    expect(buildSource).toMatch(/package-plugin\.mjs.*normalizes.*permissions/i);
  });
});

describe("tokengraph focused skills", () => {
  it("ships specialized skills with the core task lifecycle and fallback guidance", async () => {
    for (const skillDir of requiredFocusedSkillDirs) {
      const skill = await readFile(resolve("skills", skillDir, "SKILL.md"), "utf8");

      expect(skill).toMatch(/^---[\s\S]*\nname:\s*\S+[\s\S]*\ndescription:\s*Use when\b[^\n]+\n---/);
      expect(skill).toMatch(/When not to use/i);
      expect(skill).toMatch(/tokengraph_setup\(\{ confirmNoLegacyProcesses: true \}\)/);
      expect(skill).toMatch(/tokengraph_prepare_context/);
      expect(skill).toMatch(/tokengraph_task_report/);
      expect(skill).toMatch(/disposition: "pause"/);
      expect(skill).toMatch(/tokengraph_task_report\(\{ taskId \}\)/);
      expect(skill).toMatch(/compact reporting is the default/i);
      expect(skill).toMatch(/TokenGraph was not used/);
      expect(skill).toMatch(/unavailable/i);
    }
  });
});

describe("tokengraph release package command", () => {
  it("uses v0.23.1 and Apache-2.0 across every active source and marketplace contract", async () => {
    const repoRoot = resolve("..", "..");
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    const codexManifest = JSON.parse(await readFile(resolve(".codex-plugin", "plugin.json"), "utf8"));
    const claudeManifest = JSON.parse(await readFile(resolve(".claude-plugin", "plugin.json"), "utf8"));
    const claudeMarketplace = JSON.parse(await readFile(resolve(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    const serverSource = await readFile(resolve("src", "server.ts"), "utf8");
    const validatorSource = await readFile(resolve("scripts", "validate-plugin.mjs"), "utf8");
    const license = await readFile(resolve(repoRoot, "LICENSE"), "utf8");
    const notice = await readFile(resolve(repoRoot, "NOTICE"), "utf8");
    const lockfile = await readFile(resolve("pnpm-lock.yaml"), "utf8");
    const limitations = await readFile(resolve(repoRoot, "docs", "trust", "limitations.md"), "utf8");
    const rootReadme = await readFile(resolve(repoRoot, "README.md"), "utf8");
    const firstUse = rootReadme.split("## First use")[1]?.split("## What agents can use")[0] ?? "";
    const troubleshooting = rootReadme.split("## Troubleshooting")[1]?.split("## Maintainer workflow")[0] ?? "";

    expect(packageJson.version).toBe("0.23.1");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(codexManifest.version).toBe("0.23.1");
    expect(codexManifest.license).toBe("Apache-2.0");
    expect(claudeManifest.version).toBe("0.23.1");
    expect(claudeManifest.license).toBe("Apache-2.0");
    expect(claudeMarketplace.plugins[0].version).toBe("0.23.1");
    expect(serverSource).toContain('version: "0.23.1"');
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(notice).toContain("Copyright 2026 Mujadarah");
    expect(lockfile).toContain("postcss@8.5.18");
    expect(lockfile).not.toContain("postcss@8.5.16");
    expect(validatorSource).toContain('packageJson.license === "Apache-2.0"');
    expect(validatorSource).toContain("releaseLicense.equals(license)");
    expect(validatorSource).toContain("releaseNotice.equals(notice)");
    expect(validatorSource).not.toContain("STALE_RELEASE_HOOK_TRANSITION_SHA256");
    expect(limitations).not.toMatch(/Phase 5.*remove this transition allowance/i);
    expect(firstUse).toMatch(/tokengraph_setup[\s\S]*tokengraph_prepare_context[\s\S]*task id/i);
    expect(`${firstUse}\n${troubleshooting}`).not.toMatch(/tokengraph_(?:index_status|index_project|plan_context)/);
  });

  it("classifies transitional skill sets from content and rejects legacy names in a core set", async () => {
    const helperUrl = pathToFileURL(resolve("scripts", "skill-contract.mjs")).href;
    const helper = await import(helperUrl) as {
      classifySkillContract(skills: string[]): { contract: "core" | "legacy"; forbiddenCoreTools: string[] };
    };

    expect(helper.classifySkillContract(["Call `tokengraph_setup_status` then `tokengraph_plan_context`."])).toEqual({
      contract: "legacy",
      forbiddenCoreTools: []
    });
    expect(helper.classifySkillContract(["Call `tokengraph_setup({})` then `tokengraph_prepare_context`."])).toEqual({
      contract: "core",
      forbiddenCoreTools: []
    });
    expect(helper.classifySkillContract([
      "Call `tokengraph_setup({})`, `tokengraph_prepare_context`, and `tokengraph_plan_context`."
    ])).toEqual({ contract: "core", forbiddenCoreTools: ["tokengraph_plan_context"] });

    const helperSource = await readFile(resolve("scripts", "skill-contract.mjs"), "utf8");
    expect(helperSource).toMatch(/Phase 5[\s\S]*remove[\s\S]*legacy/i);
  });

  it("scans every packaged text file for personal paths", async () => {
    const validator = await readFile(resolve("scripts", "validate-plugin.mjs"), "utf8");
    expect(validator).toMatch(/releaseSkillsPath/);
    expect(validator).toMatch(/packaged.*files|packagedFiles/i);
    expect(validator).not.toMatch(/STALE_RELEASE_HOOK_TRANSITION_SHA256/);
    expect(validator).not.toMatch(/stale committed release snapshot/i);
  });

  it("keeps the root marketplace pointed at a committed installable release plugin", async () => {
    const repoRoot = resolve("..", "..");
    const marketplace = JSON.parse(await readFile(resolve(repoRoot, ".agents", "plugins", "marketplace.json"), "utf8")) as {
      name?: string;
      plugins?: Array<{
        name?: string;
        source?: { source?: string; path?: string };
        policy?: { installation?: string; authentication?: string };
      }>;
    };
    expect(marketplace.name).toBe("tokengraph");
    const plugin = marketplace.plugins?.find((entry) => entry.name === "tokengraph");

    expect(plugin).toMatchObject({
      name: "tokengraph",
      source: {
        source: "local",
        path: "./release/tokengraph"
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL"
      }
    });

    const releaseRoot = resolve(repoRoot, "release", "tokengraph");
    await expect(access(resolve(releaseRoot, ".codex-plugin", "plugin.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, ".claude-plugin", "plugin.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, ".mcp.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, ".mcp.claude.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "dist", "index.js"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "dist", "hooks.js"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "hooks", "hooks.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "dist", "server.js"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "dist", "core"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "skills", "tokengraph", "SKILL.md"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "README.md"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "package.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "LICENSE"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "src"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "tests"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "node_modules"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, ".tokengraph"))).rejects.toThrow();
  });

  it("creates a standalone Codex and Claude marketplace archive without source or test files", async () => {
    const outRoot = await makeRoot();

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "package-plugin.mjs"), "--out", outRoot, "--json"],
      { cwd: process.cwd() }
    );
    const report = JSON.parse(stdout) as {
      status: string;
      version: string;
      bundleDir: string;
      packageDir: string;
      archivePath: string;
      codexMarketplacePath: string;
      claudeMarketplacePath: string;
      files: string[];
    };

    expect(report).toMatchObject({
      status: "ok",
      version: "0.23.1"
    });
    expect(report.bundleDir).toBe(resolve(outRoot, "tokengraph-0.23.1"));
    expect(report.packageDir).toBe(resolve(report.bundleDir, "tokengraph"));
    expect(report.archivePath).toBe(resolve(outRoot, "tokengraph-0.23.1.zip"));
    expect(report.codexMarketplacePath).toBe(resolve(report.bundleDir, ".agents", "plugins", "marketplace.json"));
    expect(report.claudeMarketplacePath).toBe(resolve(report.bundleDir, ".claude-plugin", "marketplace.json"));
    expect(report.files).toEqual(
      expect.arrayContaining([
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".mcp.json",
        ".mcp.claude.json",
        "dist/hooks.js",
        "dist/index.js",
        "dist/polyglot-worker.js",
        "dist/typescript-worker.cjs",
        "hooks/hooks.json",
        "skills/tokengraph/SKILL.md",
        "README.md",
        "LICENSE",
        "NOTICE",
        "package.json"
      ])
    );
    expect(report.files).not.toContain("scripts/native-lock-probe.mjs");
    for (const file of report.files.filter((path: string) => /\.(?:c?js|json|md)$/i.test(path))) {
      expect(await readFile(resolve(report.packageDir, file), "utf8"), file).not.toMatch(/[^\x00-\x7F]/);
    }
    const generatedReadme = await readFile(resolve(report.packageDir, "README.md"), "utf8");
    expect(generatedReadme.match(/The default surface exposes eight compact tools/g)).toHaveLength(1);
    expect(generatedReadme.match(/\+174\.5-token execution-inclusive median/g)).toHaveLength(1);
    await expect(access(resolve(report.packageDir, "src"))).rejects.toThrow();
    await expect(access(resolve(report.packageDir, "tests"))).rejects.toThrow();
    await expect(access(resolve(report.packageDir, "node_modules"))).rejects.toThrow();

    const marketplace = JSON.parse(await readFile(report.codexMarketplacePath, "utf8")) as {
      name?: string;
      plugins?: Array<{ name?: string; source?: { path?: string } }>;
    };
    expect(marketplace.name).toBe("tokengraph");
    expect(marketplace.plugins?.[0]).toMatchObject({
      name: "tokengraph",
      source: { path: "./tokengraph" }
    });

    const claudeMarketplace = JSON.parse(await readFile(report.claudeMarketplacePath, "utf8")) as {
      name?: string;
      metadata?: { description?: string };
      plugins?: Array<{ name?: string; source?: string }>;
    };
    expect(claudeMarketplace).toMatchObject({
      name: "tokengraph",
      metadata: { description: expect.stringMatching(/local-first/i) },
      plugins: [{ name: "tokengraph", source: "./tokengraph" }]
    });

    const archive = unzipSync(await readFile(report.archivePath));
    const archiveListing = Object.keys(archive);
    expect(archiveListing
      .filter((path) => path.startsWith("tokengraph/") && !path.endsWith("/"))
      .map((path) => path.slice("tokengraph/".length))
      .sort()).toEqual(exactPackagedPluginPaths);
    expect(archiveListing).toEqual(expect.arrayContaining([
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      "tokengraph/dist/hooks.js",
      "tokengraph/hooks/hooks.json",
      "tokengraph/dist/index.js",
      "tokengraph/dist/polyglot-worker.js",
      "tokengraph/dist/typescript-worker.cjs"
    ]));
    expect(archiveListing.join("\n")).not.toMatch(/tokengraph\/(src|tests|node_modules)\//);
    expect(archiveListing).not.toContain("tokengraph/scripts/native-lock-probe.mjs");

    const nativeManifest = JSON.parse(await readFile(resolve("assets", "native-lock", "manifest.json"), "utf8")) as {
      artifacts: Array<{ path: string; sha256: string }>;
    };
    expect(archiveListing.filter((path) => path.endsWith(".node"))).toHaveLength(6);
    expect(archiveListing.filter((path) => /\.(?:exe|dll|so|dylib|node)$/iu.test(path))).toHaveLength(6);
    expect(archiveListing
      .filter((path) => path.startsWith("tokengraph/assets/") && !path.endsWith("/"))
      .map((path) => path.slice("tokengraph/assets/".length))
      .sort()).toEqual(exactPackagedAssets);
    expect(archiveListing.join("\n")).not.toMatch(/tokengraph\/(?:src|tests|native|scripts)\//);
    for (const artifact of nativeManifest.artifacts) {
      const releaseBytes = await readFile(resolve(report.packageDir, "assets", "native-lock", artifact.path));
      const archiveBytes = archive[`tokengraph/assets/native-lock/${artifact.path}`];
      expect(sha256(releaseBytes), artifact.path).toBe(artifact.sha256);
      expect(archiveBytes, artifact.path).toBeDefined();
      expect(sha256(archiveBytes!), artifact.path).toBe(artifact.sha256);
    }

    const extractedBundle = join(outRoot, "extracted");
    for (const [archivePath, bytes] of Object.entries(archive)) {
      const parts = archivePath.split("/");
      expect(archivePath, archivePath).not.toMatch(/^(?:[A-Za-z]:|[/\\])|\\/u);
      expect(parts, archivePath).not.toContain("..");
      const outputPath = join(extractedBundle, ...parts);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
    }
    await expect(execFileAsync(process.execPath, [
      resolve("scripts", "validate-native-lock-addon.mjs"),
      "--assets", join(extractedBundle, "tokengraph", "assets", "native-lock"),
      "--load-current"
    ], { cwd: process.cwd(), env: process.env })).resolves.toMatchObject({
      stdout: expect.stringMatching(/validated \(6 artifacts\)/i)
    });
  });

  it.each([
    ["a missing addon", async (assetsRoot: string) => {
      const manifest = JSON.parse(await readFile(join(assetsRoot, "manifest.json"), "utf8")) as {
        artifacts: Array<{ path: string }>;
      };
      await rm(join(assetsRoot, manifest.artifacts[0]!.path));
    }],
    ["an extra executable", async (assetsRoot: string) => {
      await writeFile(join(assetsRoot, "native-helper.exe"), "MZ");
    }],
    ["a mismatched manifest", async (assetsRoot: string) => {
      const manifestPath = join(assetsRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        artifacts: Array<{ sha256: string }>;
      };
      manifest.artifacts[0]!.sha256 = "0".repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }],
    ["an absolute manifest path", async (assetsRoot: string) => {
      const manifestPath = join(assetsRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        artifacts: Array<{ path: string }>;
      };
      manifest.artifacts[0]!.path = "C:\\Users\\example\\tokengraph-lock.node";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }]
  ])("refuses to package a native asset set with %s", async (_label, mutate) => {
    const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
    await mutate(join(copiedPlugin, "assets", "native-lock"));

    await expect(execFileAsync(
      process.execPath,
      [join(copiedPlugin, "scripts", "package-plugin.mjs"), "--release", "--out-release", join(repoCopy, "release", "tokengraph")],
      { cwd: copiedPlugin, env: process.env }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/native|manifest|target|artifact/i) });
  });

  it.each([".exe", ".dll", ".so", ".dylib", ".node"])(
    "refuses to package an unlisted %s executable outside the native asset root",
    async (extension) => {
      const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
      await writeFile(join(copiedPlugin, "assets", `unlisted-helper${extension}`), "unlisted executable");

      await expect(execFileAsync(
        process.execPath,
        [join(copiedPlugin, "scripts", "package-plugin.mjs"), "--release", "--out-release", join(repoCopy, "release", "tokengraph")],
        { cwd: copiedPlugin, env: process.env }
      )).rejects.toMatchObject({ stderr: expect.stringMatching(/executable|allowlist|unlisted/i) });
    }
  );

  it.each(renamedNativeFixtures)(
    "refuses to package renamed $format native bytes outside the exact asset allowlist",
    async ({ format, source }) => {
      const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
      await cp(join(copiedPlugin, "assets", ...source), join(copiedPlugin, "assets", `unlisted-${format}.bin`));

      await expect(execFileAsync(
        process.execPath,
        [join(copiedPlugin, "scripts", "package-plugin.mjs"), "--release", "--out-release", join(repoCopy, "release", "tokengraph")],
        { cwd: copiedPlugin, env: process.env }
      )).rejects.toMatchObject({ stderr: expect.stringMatching(/asset|allowlist|unlisted/i) });
    }
  );

  it("refuses to package an extensionless executable-like asset", async () => {
    const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
    await writeFile(join(copiedPlugin, "assets", "unlisted-helper"), "#!/bin/sh\nexit 0\n");

    await expect(execFileAsync(
      process.execPath,
      [join(copiedPlugin, "scripts", "package-plugin.mjs"), "--release", "--out-release", join(repoCopy, "release", "tokengraph")],
      { cwd: copiedPlugin, env: process.env }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/asset|allowlist|unlisted/i) });
  });

  it.each([
    { mode: "release", args: ["--release"] },
    { mode: "bundle", args: ["--json"] }
  ])("refuses a source asset symlink before $mode output is produced", async ({ args }) => {
    const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
    const source = join(copiedPlugin, "assets", "native-lock", "win32-x64", "tokengraph-lock.win32-x64.node");
    await symlink(source, join(copiedPlugin, "assets", "unlisted-helper"), "file");
    const commandArgs = [join(copiedPlugin, "scripts", "package-plugin.mjs"), ...args];
    if (args.includes("--release")) commandArgs.push("--out-release", join(repoCopy, "release", "tokengraph"));
    else commandArgs.push("--out", join(repoCopy, "artifacts"));

    await expect(execFileAsync(process.execPath, commandArgs, {
      cwd: copiedPlugin,
      env: process.env
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/asset|link|regular|allowlist/i) });
    await expect(access(args.includes("--release")
      ? join(repoCopy, "release", "tokengraph")
      : join(repoCopy, "artifacts", "tokengraph-0.23.1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a linked source asset directory", async () => {
    const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
    await symlink(
      join(copiedPlugin, "assets", "native-lock", "win32-x64"),
      join(copiedPlugin, "assets", "unlisted-directory"),
      "junction"
    );

    await expect(execFileAsync(process.execPath, [
      join(copiedPlugin, "scripts", "package-plugin.mjs"), "--out", join(repoCopy, "artifacts"), "--json"
    ], { cwd: copiedPlugin, env: process.env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/asset|directory|link|regular|allowlist/i)
    });
  });

  it("refuses an executable in a copied source skill directory", async () => {
    const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
    await cp(
      join(copiedPlugin, "assets", "native-lock", "win32-x64", "tokengraph-lock.win32-x64.node"),
      join(copiedPlugin, "skills", "tokengraph", "unlisted-helper.exe")
    );

    await expect(execFileAsync(process.execPath, [
      join(copiedPlugin, "scripts", "package-plugin.mjs"), "--out", join(repoCopy, "artifacts"), "--json"
    ], { cwd: copiedPlugin, env: process.env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/installable|skill|allowlist|unlisted/i)
    });
  });

  it("refuses a symlink in a copied source skill directory", async () => {
    const { copiedPlugin, repoCopy } = await makePackageRepositoryCopy();
    const source = join(copiedPlugin, "assets", "native-lock", "win32-x64", "tokengraph-lock.win32-x64.node");
    await symlink(source, join(copiedPlugin, "skills", "tokengraph", "unlisted-helper"), "file");

    await expect(execFileAsync(process.execPath, [
      join(copiedPlugin, "scripts", "package-plugin.mjs"), "--out", join(repoCopy, "artifacts"), "--json"
    ], { cwd: copiedPlugin, env: process.env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/installable|skill|link|regular|allowlist/i)
    });
  });

  it("validates a freshly generated release with core skill contracts", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
      cwd: process.cwd()
    });

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin
    })).resolves.toMatchObject({ stdout: expect.stringMatching(/validation passed/i) });
  });

  it("rejects a release whose skill content drifts from the source plugin", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", join(repoCopy, "release", "tokengraph"), "--json"], {
      cwd: process.cwd()
    });
    const driftedSkill = join(repoCopy, "release", "tokengraph", "skills", "tokengraph", "SKILL.md");
    await writeFile(driftedSkill, `${await readFile(driftedSkill, "utf8")}\nDrifted release copy.\n`);

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/release skill.*match source/i) });
  });

  it("rejects a release whose native addon bytes drift from the source plugin", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
      cwd: process.cwd(),
      env: process.env
    });
    const manifest = JSON.parse(await readFile(join(copiedPlugin, "assets", "native-lock", "manifest.json"), "utf8")) as {
      artifacts: Array<{ path: string }>;
    };
    const driftedAddon = join(generatedRelease, "assets", "native-lock", manifest.artifacts[0]!.path);
    await writeFile(driftedAddon, Buffer.concat([await readFile(driftedAddon), Buffer.from([0])]));

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin,
      env: process.env
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/native.*(?:match|byte|hash|integrity)/i) });
  });

  it("rejects a release whose packaged lifecycle hook differs from the built source hook", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
      cwd: process.cwd(),
      env: process.env
    });
    await cp(join(copiedPlugin, "dist", "index.js"), join(generatedRelease, "dist", "hooks.js"));

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin,
      env: process.env
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/lifecycle hook|hooks\.js|byte/i) });
  });

  it.each([".exe", ".dll", ".so", ".dylib", ".node"])(
    "rejects an unlisted release %s executable outside the native asset root",
    async (extension) => {
      const sandbox = await makeRoot();
      const repoRoot = resolve("..", "..");
      const repoCopy = join(sandbox, "repo");
      await cp(repoRoot, repoCopy, {
        recursive: true,
        filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
      });
      const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
      const generatedRelease = join(repoCopy, "release", "tokengraph");
      await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
        cwd: process.cwd(),
        env: process.env
      });
      await writeFile(join(generatedRelease, "assets", `unlisted-helper${extension}`), "unlisted executable");

      await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
        cwd: copiedPlugin,
        env: process.env
      })).rejects.toMatchObject({ stderr: expect.stringMatching(/executable|allowlist|unlisted/i) });
    }
  );

  it.each(renamedNativeFixtures)(
    "rejects renamed release $format native bytes outside the exact asset allowlist",
    async ({ format, source }) => {
      const sandbox = await makeRoot();
      const repoRoot = resolve("..", "..");
      const repoCopy = join(sandbox, "repo");
      await cp(repoRoot, repoCopy, {
        recursive: true,
        filter: (path) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(path.split(/[\\/]/).at(-1) ?? "")
      });
      const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
      const generatedRelease = join(repoCopy, "release", "tokengraph");
      await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
        cwd: process.cwd(),
        env: process.env
      });
      await cp(join(copiedPlugin, "assets", ...source), join(generatedRelease, "assets", `unlisted-${format}.bin`));

      await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
        cwd: copiedPlugin,
        env: process.env
      })).rejects.toMatchObject({ stderr: expect.stringMatching(/asset|allowlist|unlisted/i) });
    }
  );

  it("rejects an extensionless executable-like release asset", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (path) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(path.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
      cwd: process.cwd(),
      env: process.env
    });
    await writeFile(join(generatedRelease, "assets", "unlisted-helper"), "#!/bin/sh\nexit 0\n");

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin,
      env: process.env
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/asset|allowlist|unlisted/i) });
  });

  it("rejects a non-regular symlink entry in release assets", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (path) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(path.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
      cwd: process.cwd(),
      env: process.env
    });
    const source = join(generatedRelease, "assets", "native-lock", "win32-x64", "tokengraph-lock.win32-x64.node");
    await symlink(source, join(generatedRelease, "assets", "unlisted-helper"), "file");

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin,
      env: process.env
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/asset|link|regular|allowlist/i) });
  });

  it.each([
    { kind: "executable", linked: false },
    { kind: "symlink", linked: true }
  ])("rejects an unlisted $kind in a packaged release skill directory", async ({ linked }) => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (path) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(path.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease, "--json"], {
      cwd: process.cwd(),
      env: process.env
    });
    const source = join(generatedRelease, "assets", "native-lock", "win32-x64", "tokengraph-lock.win32-x64.node");
    const destination = join(generatedRelease, "skills", "tokengraph", linked ? "unlisted-helper" : "unlisted-helper.exe");
    if (linked) await symlink(source, destination, "file");
    else await cp(source, destination);

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin,
      env: process.env
    })).rejects.toMatchObject({ stderr: expect.stringMatching(/installable|skill|link|regular|allowlist|unlisted/i) });
  });

  it("ignores non-public Cargo target output during source text scanning", async () => {
    const sandbox = await makeRoot();
    const repositoryRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repositoryRoot, repoCopy, {
      recursive: true,
      filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph", "artifacts", ".superpowers", "target"].includes(source.split(/[\\/]/).at(-1) ?? "")
    });
    const copiedPlugin = join(repoCopy, "plugins", "tokengraph");
    await cp(resolve("node_modules", "fflate"), join(copiedPlugin, "node_modules", "fflate"), { recursive: true });
    const targetFixture = join(copiedPlugin, "native", "lock-addon", "target", "debug", ".fingerprint", "fixture");
    await mkdir(dirname(targetFixture), { recursive: true });
    await writeFile(targetFixture, "C:\\Users\\local-build-user\\source.rs");
    const generatedRelease = join(repoCopy, "release", "tokengraph");
    await execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "package-plugin.mjs"), "--release", "--out-release", generatedRelease], {
      cwd: copiedPlugin,
      env: process.env
    });

    await expect(execFileAsync(process.execPath, [join(copiedPlugin, "scripts", "validate-plugin.mjs")], {
      cwd: copiedPlugin,
      env: process.env
    })).resolves.toMatchObject({ stdout: expect.stringMatching(/validation passed/i) });
  });

  it("documents the native runtime and mixed-version rollout contract", async () => {
    const repoRoot = resolve("..", "..");
    const documents = await Promise.all([
      readFile(resolve("README.md"), "utf8"),
      readFile(join(repoRoot, "docs", "hosts", "codex.md"), "utf8"),
      readFile(join(repoRoot, "docs", "hosts", "claude-code.md"), "utf8"),
      readFile(join(repoRoot, "docs", "trust", "security.md"), "utf8"),
      readFile(join(repoRoot, "docs", "trust", "privacy.md"), "utf8"),
      readFile(join(repoRoot, "docs", "trust", "limitations.md"), "utf8"),
      readFile(join(repoRoot, "docs", "trust", "release-install.md"), "utf8")
    ]);
    const combined = documents.join("\n");

    expect(combined).toMatch(/six prebuilt|prebuilt.*six/i);
    expect(combined).toMatch(/no (?:runtime )?(?:download|compiler)|without.*(?:download|compiler)/i);
    expect(combined).toMatch(/glibc 2\.28/i);
    expect(combined).toMatch(/musl.*(?:unsupported|refus|fail)/i);
    expect(combined).toMatch(/v0\.23\.1[^\n]*(?:must be|is) stopped/i);
    expect(combined).toMatch(/v0\.23\.1[^\n]*stopped[^\n]*must not be restarted/i);
    expect(combined).toMatch(/confirmNoLegacyProcesses:\s*true/);
    expect(combined).toMatch(/--confirm-no-legacy-processes/);
    expect(combined).toMatch(/Doctor.*never grants|never grants.*Doctor/is);
    expect(combined).toMatch(/private.*(?:OS|operating-system).*temp/i);
    expect(combined).toMatch(/mixed[- ]runtime|mixed[- ]version/i);
  });

  it("writes a direct release plugin layout when requested", async () => {
    const releaseRoot = resolve(await makeRoot(), "release-plugin");

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "package-plugin.mjs"), "--release", "--out-release", releaseRoot, "--json"],
      { cwd: process.cwd() }
    );
    const report = JSON.parse(stdout) as {
      status: string;
      version: string;
      releaseDir: string;
      files: string[];
    };

    expect(report).toMatchObject({
      status: "ok",
      version: "0.23.1",
      releaseDir: releaseRoot
    });
    expect(report.files).toEqual(
      expect.arrayContaining([
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".mcp.json",
        ".mcp.claude.json",
        "dist/hooks.js",
        "dist/index.js",
        "dist/polyglot-worker.js",
        "dist/typescript-worker.cjs",
        "hooks/hooks.json",
        "skills/tokengraph/SKILL.md",
        "README.md",
        "LICENSE",
        "NOTICE",
        "package.json"
      ])
    );
    const releaseReadme = await readFile(resolve(releaseRoot, "README.md"), "utf8");
    expect(releaseReadme).toMatch(/none\s*\|\s*low\s*\|\s*medium\s*\|\s*high/i);
    expect(releaseReadme).toMatch(/four.*exact.*slice.*711|711.*four.*exact.*slice/is);
    expect(releaseReadme).toMatch(/fixture.*real-host|real-host.*fixture/is);
    expect(releaseReadme).toMatch(/promotion.*disabled|enforcement.*disabled/is);
    expect(releaseReadme).toMatch(/three repositories.*multi-repository B6.*(?:target|coverage).*(?:met|complete)/is);
    expect(releaseReadme).not.toMatch(/every frozen.*gate did not pass/is);
    expect(releaseReadme).toMatch(/not all frozen.*gates passed/is);
    await expect(access(resolve(releaseRoot, "src"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "tests"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "scripts"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "docs", "plans"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "node_modules"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, ".tokengraph"))).rejects.toThrow();
  });

  it("fails clearly when the package output option is missing", async () => {
    await expect(
      execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--out"], { cwd: process.cwd() })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--out requires a value")
    });
  });
});
