#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..", "..");

function fail(message) {
  console.error(`TokenGraph plugin validation failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read valid JSON at ${path}: ${error.message}`);
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function assertFile(path, label) {
  try {
    await access(path);
  } catch {
    fail(`${label} is missing at ${path}`);
  }
}

const packageJsonPath = resolve(pluginRoot, "package.json");
const manifestPath = resolve(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = resolve(repoRoot, ".agents", "plugins", "marketplace.json");
const mcpPath = resolve(pluginRoot, ".mcp.json");
const skillPath = resolve(pluginRoot, "skills", "tokengraph", "SKILL.md");
const distEntryPath = resolve(pluginRoot, "dist", "index.js");
const distServerPath = resolve(pluginRoot, "dist", "server.js");
const distReviewPath = resolve(pluginRoot, "dist", "core", "review.js");
const smokeScriptPath = resolve(pluginRoot, "scripts", "smoke.mjs");
const nextSupabaseFixturePath = resolve(pluginRoot, "tests", "fixtures", "next-supabase");
const ignoredOutputFixturePath = resolve(pluginRoot, "tests", "fixtures", "ignored-output");

const packageJson = await readJson(packageJsonPath);
const manifest = await readJson(manifestPath);
const marketplace = await readOptionalJson(marketplacePath);
const mcp = await readJson(mcpPath);
const skill = await readFile(skillPath, "utf8").catch((error) => fail(`cannot read TokenGraph skill: ${error.message}`));
const distServer = await readFile(distServerPath, "utf8").catch((error) => fail(`cannot read built MCP server: ${error.message}`));
const distReview = await readFile(distReviewPath, "utf8").catch((error) => fail(`cannot read built review helpers: ${error.message}`));

assert(packageJson.name === "tokengraph", "package name must be tokengraph");
assert(/^\d+\.\d+\.\d+$/.test(packageJson.version), "package version must be semver");
assert(packageJson.scripts?.smoke === "node scripts/smoke.mjs", "package scripts must include smoke command");
assert(manifest.name === "tokengraph", "plugin manifest name must be tokengraph");
assert(manifest.version?.split("+", 1)[0] === packageJson.version, "plugin manifest base version must match package version");
assert(manifest.skills === "./skills/", "plugin manifest must point skills to ./skills/");
assert(manifest.mcpServers === "./.mcp.json", "plugin manifest must point mcpServers to ./.mcp.json");
if (marketplace) {
  const marketplacePlugin = marketplace.plugins?.find((plugin) => plugin.name === "tokengraph");
  assert(marketplacePlugin?.source?.path === "./plugins/tokengraph", "marketplace tokengraph source path must point to ./plugins/tokengraph");
}
assert(mcp.mcpServers?.tokengraph?.command === "node", "tokengraph MCP command must be node");
assert(
  Array.isArray(mcp.mcpServers.tokengraph.args) && mcp.mcpServers.tokengraph.args.includes("./dist/index.js"),
  "tokengraph MCP args must include ./dist/index.js"
);
assert(mcp.mcpServers.tokengraph.cwd === ".", "tokengraph MCP cwd must be plugin root");
assert(/^---\s*\nname:\s*tokengraph\s*\n/m.test(skill), "TokenGraph skill frontmatter must name tokengraph");
assert(/description:\s*\S+/m.test(skill), "TokenGraph skill frontmatter must include a description");
assert(distServer.includes("tokengraph_index_status"), "built MCP server must register tokengraph_index_status");
assert(distServer.includes("tokengraph_reset_project"), "built MCP server must register tokengraph_reset_project");
assert(distServer.includes(`version: "${packageJson.version}"`), `built MCP server must advertise version ${packageJson.version}`);
assert(distServer.includes("inboundReferences"), "built MCP server must expose inbound explain references");
assert(distServer.includes("outboundReferences"), "built MCP server must expose outbound explain references");
assert(distServer.includes("materializedViews"), "built MCP server must expose v0.5 materialized view SQL summaries");
assert(distServer.includes("usingExpression"), "built MCP server must expose v0.5 RLS policy using expressions");
assert(distServer.includes("constraints"), "built MCP server must expose v0.5 SQL constraints");
assert(distServer.includes("tokengraph_review_memories"), "built MCP server must register v0.7 memory review");
assert(distServer.includes("tokengraph_export_project_map"), "built MCP server must register v0.7 project map export");
assert(distReview.includes("flowchart LR"), "built review helpers must include Mermaid project map export");

await assertFile(distEntryPath, "built MCP entry");
await assertFile(distServerPath, "built MCP server");
await assertFile(distReviewPath, "built review helpers");
await assertFile(smokeScriptPath, "CLI smoke script");
await assertFile(nextSupabaseFixturePath, "Next.js Supabase regression fixture");
await assertFile(ignoredOutputFixturePath, "ignored-output regression fixture");

console.log(`TokenGraph plugin validation passed (${packageJson.version}).`);
