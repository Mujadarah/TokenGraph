import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

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

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-cli-"));
  tempRoots.push(root);
  return root;
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
      [resolve("scripts", "smoke.mjs"), "--root", root, "--json"],
      { cwd: process.cwd() }
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
  });

  it("validates the opt-in full MCP surface", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--root", root, "--surface", "full", "--json"],
      { cwd: process.cwd() }
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
      [resolve("scripts", "smoke.mjs"), "--", "--root", root, "--json"],
      { cwd: process.cwd() }
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
    const cacheRoot = await makeRoot();
    const projectRoot = await makeRoot();
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");
    await cp(resolve("dist"), join(cacheRoot, "dist"), { recursive: true });
    await cp(resolve(".codex-plugin"), join(cacheRoot, ".codex-plugin"), { recursive: true });
    await cp(resolve(".mcp.json"), join(cacheRoot, ".mcp.json"));
    await cp(resolve("package.json"), join(cacheRoot, "package.json"));

    await expect(access(join(cacheRoot, "node_modules"))).rejects.toThrow();
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "smoke.mjs"), "--root", projectRoot, "--server", join(cacheRoot, "dist", "index.js"), "--json"],
      { cwd: process.cwd() }
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
      aggregate: { taskCount: number; categoryCounts: Record<string, number>; medianNetSavings: number };
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
    expect(report.aggregate.medianNetSavings).toBeLessThan(0);
    expect(report.releaseGate).toEqual({
      passed: false,
      failureReasons: expect.arrayContaining([
        expect.stringMatching(/constraint preservation/i),
        expect.stringMatching(/false negatives/i),
        expect.stringMatching(/median net savings/i)
      ])
    });
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
  });
});

describe("tokengraph focused skills", () => {
  it("ships specialized skills with the core task lifecycle and fallback guidance", async () => {
    for (const skillDir of requiredFocusedSkillDirs) {
      const skill = await readFile(resolve("skills", skillDir, "SKILL.md"), "utf8");

      expect(skill).toMatch(/^---[\s\S]*\nname:\s*\S+[\s\S]*\ndescription:\s*Use when\b[^\n]+\n---/);
      expect(skill).toMatch(/When not to use/i);
      expect(skill).toMatch(/tokengraph_setup\(\{\}\)/);
      expect(skill).toMatch(/tokengraph_prepare_context/);
      expect(skill).toMatch(/tokengraph_task_report/);
      expect(skill).toMatch(/disposition: "pause"/);
      expect(skill).toMatch(/disposition: "complete"/);
      expect(skill).toMatch(/TokenGraph was not used/);
      expect(skill).toMatch(/unavailable/i);
    }
  });
});

describe("tokengraph release package command", () => {
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
      version: "0.19.0"
    });
    expect(report.bundleDir).toBe(resolve(outRoot, "tokengraph-0.19.0"));
    expect(report.packageDir).toBe(resolve(report.bundleDir, "tokengraph"));
    expect(report.archivePath).toBe(resolve(outRoot, "tokengraph-0.19.0.zip"));
    expect(report.codexMarketplacePath).toBe(resolve(report.bundleDir, ".agents", "plugins", "marketplace.json"));
    expect(report.claudeMarketplacePath).toBe(resolve(report.bundleDir, ".claude-plugin", "marketplace.json"));
    expect(report.files).toEqual(
      expect.arrayContaining([
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".mcp.json",
        ".mcp.claude.json",
        "dist/index.js",
        "skills/tokengraph/SKILL.md",
        "README.md",
        "LICENSE",
        "package.json"
      ])
    );
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

    const archiveListing = Object.keys(unzipSync(await readFile(report.archivePath)));
    expect(archiveListing).toEqual(expect.arrayContaining([
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      "tokengraph/dist/index.js"
    ]));
    expect(archiveListing.join("\n")).not.toMatch(/tokengraph\/(src|tests|node_modules)\//);
  });

  it("validates a freshly generated release with core skill contracts", async () => {
    const sandbox = await makeRoot();
    const repoRoot = resolve("..", "..");
    const repoCopy = join(sandbox, "repo");
    await cp(repoRoot, repoCopy, {
      recursive: true,
      filter: (source) => ![".git", ".worktrees", "node_modules", ".tokengraph"].includes(source.split(/[\\/]/).at(-1) ?? "")
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
      version: "0.19.0",
      releaseDir: releaseRoot
    });
    expect(report.files).toEqual(
      expect.arrayContaining([
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".mcp.json",
        ".mcp.claude.json",
        "dist/index.js",
        "skills/tokengraph/SKILL.md",
        "README.md",
        "LICENSE",
        "package.json"
      ])
    );
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
