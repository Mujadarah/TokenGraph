import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

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
});

describe("tokengraph release package command", () => {
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
      version: "0.10.0"
    });
    expect(report.packageDir).toBe(resolve(outRoot, "tokengraph-0.10.0"));
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
      source: { path: "./tokengraph-0.10.0" }
    });
  });

  it("fails clearly when the package output option is missing", async () => {
    await expect(
      execFileAsync(process.execPath, [resolve("scripts", "package-plugin.mjs"), "--out"], { cwd: process.cwd() })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--out requires a value")
    });
  });
});
