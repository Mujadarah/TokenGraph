import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
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
      wikiStatus: "fresh"
    });
    expect(report.wikiPageSlugs).toContain("overview");
    expect(report.tools).toEqual(
      expect.arrayContaining(["tokengraph_index_status", "tokengraph_project_map", "tokengraph_plan_context", "tokengraph_generate_wiki"])
    );
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
      status: string;
      claimsPolicy: string[];
      tasks: Array<{
        taskType: string;
        metrics: Record<string, unknown>;
      }>;
    };

    expect(report.status).toBe("ok");
    expect(report.claimsPolicy.join("\n")).toMatch(/Do not claim universal 95 percent token reduction/i);
    expect(report.tasks.map((task) => task.taskType).sort()).toEqual([
      "architecture-check",
      "code-graph-routing",
      "log-compression",
      "memory-recall",
      "regression-risk",
      "release-packaging-validation",
      "root-cause-debugging",
      "sql-graph-routing",
      "wiki-orientation"
    ]);
    for (const task of report.tasks) {
      expect(task.metrics).toMatchObject({
        filesRead: expect.any(Number),
        rawLinesRead: expect.any(Number),
        estimatedInputTokens: expect.any(Number),
        estimatedOutputTokens: expect.any(Number),
        mcpToolCalls: expect.any(Number),
        timeToUsefulPatchScopeMs: expect.any(Number),
        falsePositiveFiles: expect.any(Number),
        falseNegativeFiles: expect.any(Number),
        testsRecommended: expect.any(Number),
        testsPassed: expect.any(Number),
        estimatedTokensAvoided: expect.any(Number)
      });
    }
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
  it("ships specialized skills with required TokenGraph operating guidance", async () => {
    for (const skillDir of requiredFocusedSkillDirs) {
      const skill = await readFile(resolve("skills", skillDir, "SKILL.md"), "utf8");

      expect(skill).toMatch(/^---[\s\S]*\nname:\s*\S+[\s\S]*\ndescription:\s*\S+[\s\S]*\n---/);
      expect(skill).toMatch(/Use this skill when/i);
      expect(skill).toMatch(/MCP tools to call/i);
      expect(skill).toMatch(/avoid raw/i);
      expect(skill).toMatch(/hypoth/i);
      expect(skill).toMatch(/Do not pretend/i);
      expect(skill).toMatch(/unavailable/i);
    }
  });
});

describe("tokengraph release package command", () => {
  it("keeps the root marketplace pointed at a committed installable release plugin", async () => {
    const repoRoot = resolve("..", "..");
    const marketplace = JSON.parse(await readFile(resolve(repoRoot, ".agents", "plugins", "marketplace.json"), "utf8")) as {
      plugins?: Array<{
        name?: string;
        source?: { source?: string; path?: string };
        policy?: { installation?: string; authentication?: string };
      }>;
    };
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
    await expect(access(resolve(releaseRoot, ".mcp.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "dist", "index.js"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "dist", "server.js"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "skills", "tokengraph", "SKILL.md"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "README.md"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "package.json"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "LICENSE"))).resolves.toBeUndefined();
    await expect(access(resolve(releaseRoot, "src"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "tests"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, "node_modules"))).rejects.toThrow();
    await expect(access(resolve(releaseRoot, ".tokengraph"))).rejects.toThrow();
  });

  it("creates a distributable plugin folder without source or test files", async () => {
    const outRoot = await makeRoot();

    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve("scripts", "package-plugin.mjs"), "--out", outRoot, "--json"],
      { cwd: process.cwd() }
    );
    const report = JSON.parse(stdout) as {
      status: string;
      version: string;
      packageDir: string;
      marketplacePath: string;
      files: string[];
    };

    expect(report).toMatchObject({
      status: "ok",
      version: "0.17.0"
    });
    expect(report.packageDir).toBe(resolve(outRoot, "tokengraph-0.17.0"));
    expect(report.marketplacePath).toBe(resolve(outRoot, ".agents", "plugins", "marketplace.json"));
    expect(report.files).toEqual(
      expect.arrayContaining([
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "dist/index.js",
        "dist/server.js",
        "skills/tokengraph/SKILL.md",
        "README.md",
        "LICENSE",
        "package.json"
      ])
    );
    await expect(access(resolve(report.packageDir, "src"))).rejects.toThrow();
    await expect(access(resolve(report.packageDir, "tests"))).rejects.toThrow();
    await expect(access(resolve(report.packageDir, "node_modules"))).rejects.toThrow();

    const marketplace = JSON.parse(await readFile(report.marketplacePath, "utf8")) as {
      plugins?: Array<{ name?: string; source?: { path?: string } }>;
    };
    expect(marketplace.plugins?.[0]).toMatchObject({
      name: "tokengraph",
      source: { path: "./tokengraph-0.17.0" }
    });
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
      version: "0.17.0",
      releaseDir: releaseRoot
    });
    expect(report.files).toEqual(
      expect.arrayContaining([
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "dist/index.js",
        "dist/server.js",
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
