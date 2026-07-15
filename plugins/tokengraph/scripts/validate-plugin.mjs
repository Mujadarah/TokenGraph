#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySkillContract } from "./skill-contract.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..", "..");
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

async function assertFile(path, label) {
  try {
    await access(path);
  } catch {
    fail(`${label} is missing at ${path}`);
  }
}

async function assertDirectory(path, label) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries;
  } catch {
    fail(`${label} is missing at ${path}`);
  }
}

async function assertMissing(path, label) {
  try {
    await access(path);
    fail(`${label} must not be included at ${path}`);
  } catch {
    return;
  }
}

async function collectSkillFiles(skillsRoot) {
  const skillFiles = [];
  const entries = await assertDirectory(skillsRoot, "skills directory");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = resolve(skillsRoot, entry.name, "SKILL.md");
    try {
      await access(skillPath);
      skillFiles.push(skillPath);
    } catch {
      fail(`skill folder ${entry.name} must contain SKILL.md`);
    }
  }
  return skillFiles;
}

async function assertSkillFrontmatter(skillsRoot, label, coreLifecycle = false) {
  const skillFiles = await collectSkillFiles(skillsRoot);
  assert(skillFiles.length > 0, `${label} must include at least one skill`);
  for (const skillFile of skillFiles) {
    const skill = await readFile(skillFile, "utf8").catch((error) => fail(`cannot read skill ${skillFile}: ${error.message}`));
    assert(/^---\s*\n[\s\S]*\n---\s*\n/.test(skill), `${label} skill ${skillFile} must include frontmatter`);
    assert(/^---[\s\S]*\nname:\s*\S+[\s\S]*\n---\s*\n/.test(skill), `${label} skill ${skillFile} frontmatter must include name`);
    assert(/^---[\s\S]*\ndescription:\s*\S+[\s\S]*\n---\s*\n/.test(skill), `${label} skill ${skillFile} frontmatter must include description`);
    if (coreLifecycle) {
      assert(/^---[\s\S]*\ndescription:\s*Use when\b[^\n]+\n---\s*\n/.test(skill), `${label} skill ${skillFile} description must begin Use when`);
      assert(!/^---[\s\S]*\nwhen_to_use:/m.test(skill), `${label} skill ${skillFile} must keep its trigger only in description`);
    } else {
      assert(/^---[\s\S]*\nwhen_to_use:\s*\S+[\s\S]*\n---\s*\n/.test(skill), `${label} skill ${skillFile} frontmatter must include when_to_use`);
    }
  }
  return skillFiles;
}

async function inspectSkillContract(skillsRoot, label) {
  const skillFiles = await collectSkillFiles(skillsRoot);
  const skills = await Promise.all(skillFiles.map((skillFile) => readFile(skillFile, "utf8")));
  try {
    return classifySkillContract(skills);
  } catch (error) {
    fail(`${label} ${error.message}`);
  }
}

async function assertRequiredFocusedSkills(skillsRoot, label, coreLifecycle = false) {
  for (const skillDir of requiredFocusedSkillDirs) {
    const skillFile = resolve(skillsRoot, skillDir, "SKILL.md");
    const skill = await readFile(skillFile, "utf8").catch((error) =>
      fail(`${label} required skill ${skillDir} is missing or unreadable: ${error.message}`)
    );
    assert(/^---[\s\S]*\nname:\s*\S+[\s\S]*\ndescription:\s*\S+[\s\S]*\n---/.test(skill), `${label} skill ${skillDir} must include name and description frontmatter`);
    if (coreLifecycle) {
      assert(/When not to use/i.test(skill), `${label} skill ${skillDir} must define a negative trigger boundary`);
      assert(/tokengraph_setup\(\{\}\)/.test(skill), `${label} skill ${skillDir} must begin with core setup`);
      assert(/tokengraph_prepare_context/.test(skill), `${label} skill ${skillDir} must create a task`);
      assert(/tokengraph_task_report/.test(skill), `${label} skill ${skillDir} must report its disposition`);
      assert(/disposition: "pause"/.test(skill) && /tokengraph_task_report\(\{ taskId \}\)/.test(skill) && /compact reporting is the default/i.test(skill), `${label} skill ${skillDir} must define pause and default compact completion behavior`);
      assert(/TokenGraph was not used/.test(skill) && /unavailable/i.test(skill), `${label} skill ${skillDir} must define honest unavailable fallback`);
    } else {
      assert(/Use this skill when/i.test(skill), `${label} skill ${skillDir} must tell Codex when to use it`);
      assert(/MCP tools to call/i.test(skill), `${label} skill ${skillDir} must list TokenGraph MCP tools to call`);
      assert(/avoid raw/i.test(skill), `${label} skill ${skillDir} must explain when to avoid raw reads`);
      assert(/hypoth/i.test(skill), `${label} skill ${skillDir} must require hypotheses to be marked clearly`);
      assert(/Do not pretend/i.test(skill), `${label} skill ${skillDir} must forbid pretending unavailable MCP tools were used`);
      assert(/unavailable/i.test(skill), `${label} skill ${skillDir} must state how to handle unavailable MCP tools`);
    }
  }
}

const packageJsonPath = resolve(pluginRoot, "package.json");
const manifestPath = resolve(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = resolve(repoRoot, ".agents", "plugins", "marketplace.json");
const claudeMarketplacePath = resolve(repoRoot, ".claude-plugin", "marketplace.json");
const mcpPath = resolve(pluginRoot, ".mcp.json");
const claudeManifestPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
const claudeMcpPath = resolve(pluginRoot, ".mcp.claude.json");
const skillsPath = resolve(pluginRoot, "skills");
const distEntryPath = resolve(pluginRoot, "dist", "index.js");
const distHooksPath = resolve(pluginRoot, "dist", "hooks.js");
const distPolyglotWorkerPath = resolve(pluginRoot, "dist", "polyglot-worker.js");
const distTypeScriptWorkerPath = resolve(pluginRoot, "dist", "typescript-worker.cjs");
const hooksManifestPath = resolve(pluginRoot, "hooks", "hooks.json");
const distServerPath = resolve(pluginRoot, "dist", "index.js");
const distReviewPath = resolve(pluginRoot, "dist", "core", "review.js");
const releaseRoot = resolve(repoRoot, "release", "tokengraph");
const releaseManifestPath = resolve(releaseRoot, ".codex-plugin", "plugin.json");
const releaseMcpPath = resolve(releaseRoot, ".mcp.json");
const releaseDistEntryPath = resolve(releaseRoot, "dist", "index.js");
const releaseDistHooksPath = resolve(releaseRoot, "dist", "hooks.js");
const releaseDistPolyglotWorkerPath = resolve(releaseRoot, "dist", "polyglot-worker.js");
const releaseDistTypeScriptWorkerPath = resolve(releaseRoot, "dist", "typescript-worker.cjs");
const releaseHooksManifestPath = resolve(releaseRoot, "hooks", "hooks.json");
const releaseDistCorePath = resolve(releaseRoot, "dist", "core");
const releaseSkillsPath = resolve(releaseRoot, "skills");
const releasePackageJsonPath = resolve(releaseRoot, "package.json");
const releaseReadmePath = resolve(releaseRoot, "README.md");
const grammarAssets = ["web-tree-sitter.wasm", "tree-sitter-python.wasm", "tree-sitter-go.wasm", "tree-sitter-rust.wasm", "tree-sitter-java.wasm"];
const rootReadmePath = resolve(repoRoot, "README.md");
const sourceReadmePath = resolve(pluginRoot, "README.md");
const smokeScriptPath = resolve(pluginRoot, "scripts", "smoke.mjs");
const buildScriptPath = resolve(pluginRoot, "scripts", "build.mjs");
const packageScriptPath = resolve(pluginRoot, "scripts", "package-plugin.mjs");
const benchmarkScriptPath = resolve(pluginRoot, "scripts", "benchmark.mjs");
const nextSupabaseFixturePath = resolve(pluginRoot, "tests", "fixtures", "next-supabase");
const ignoredOutputFixturePath = resolve(pluginRoot, "tests", "fixtures", "ignored-output");
const benchmarkDocsPath = resolve(repoRoot, "docs", "benchmarks");
const trustDocsPath = resolve(repoRoot, "docs", "trust");
const hostDocsPath = resolve(repoRoot, "docs", "hosts");

const packageJson = await readJson(packageJsonPath);
const manifest = await readJson(manifestPath);
const marketplace = await readJson(marketplacePath);
const claudeMarketplace = await readJson(claudeMarketplacePath);
const mcp = await readJson(mcpPath);
const claudeManifest = await readJson(claudeManifestPath);
const claudeMcp = await readJson(claudeMcpPath);
const distServer = await readFile(distServerPath, "utf8").catch((error) => fail(`cannot read bundled MCP entry: ${error.message}`));
const distHooks = await readFile(distHooksPath, "utf8").catch((error) => fail(`cannot read bundled lifecycle hook entry: ${error.message}`));
const hooksManifest = await readJson(hooksManifestPath);
const distReview = await readFile(distReviewPath, "utf8").catch((error) => fail(`cannot read built review helpers: ${error.message}`));

assert(packageJson.name === "tokengraph", "package name must be tokengraph");
assert(/LICENSE/i.test(packageJson.license ?? ""), "package metadata must point at the repository license");
assert(/^\d+\.\d+\.\d+$/.test(packageJson.version), "package version must be semver");
assert(packageJson.scripts?.build === "node scripts/build.mjs", "package scripts must use the bundled MCP build command");
assert(packageJson.devDependencies?.esbuild, "package devDependencies must include esbuild for self-contained MCP bundles");
assert(packageJson.devDependencies?.fflate === "0.8.3", "package devDependencies must pin fflate 0.8.3 for deterministic ZIP archives");
assert(packageJson.scripts?.smoke === "node scripts/smoke.mjs", "package scripts must include smoke command");
assert(packageJson.scripts?.benchmark === "node scripts/benchmark.mjs", "package scripts must include benchmark command");
assert(packageJson.scripts?.["package:plugin"] === "node scripts/package-plugin.mjs", "package scripts must include package:plugin command");
assert(manifest.name === "tokengraph", "plugin manifest name must be tokengraph");
assert(manifest.version?.split("+", 1)[0] === packageJson.version, "plugin manifest base version must match package version");
assert(manifest.skills === "./skills/", "plugin manifest must point skills to ./skills/");
assert(manifest.mcpServers === "./.mcp.json", "plugin manifest must point mcpServers to ./.mcp.json");
assert(manifest.hooks === undefined, "plugin manifest must use default hooks/hooks.json auto-discovery");
assert(claudeManifest.name === "tokengraph", "Claude plugin manifest name must be tokengraph");
assert(claudeManifest.version === packageJson.version, "Claude plugin manifest version must match package version");
assert(claudeManifest.mcpServers === "./.mcp.claude.json", "Claude plugin manifest must point at ./.mcp.claude.json");
assert(claudeManifest.hooks === undefined, "Claude plugin manifest must use default hooks/hooks.json auto-discovery");
assert(Object.keys(hooksManifest.hooks ?? {}).sort().join(",") === "PostToolUse,Stop", "hook manifest must define only PostToolUse and Stop");
const postToolHook = hooksManifest.hooks?.PostToolUse?.[0];
const stopHook = hooksManifest.hooks?.Stop?.[0];
const postMatcher = new RegExp(postToolHook?.matcher ?? "a^");
for (const toolName of ["tokengraph_prepare_context", "tokengraph_query_context", "tokengraph_compress", "tokengraph_recall", "tokengraph_analyze", "tokengraph_propose_knowledge", "tokengraph_task_report"]) {
  assert(postMatcher.test(`mcp__tokengraph__${toolName}`), `PostToolUse matcher must include ${toolName}`);
}
assert(postToolHook?.hooks?.length === 1 && postToolHook.hooks[0]?.type === "command", "PostToolUse must use one command hook");
assert(postToolHook?.hooks?.[0]?.command === 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks.js" post-tool-use', "PostToolUse command must use the cross-host Node adapter");
assert(stopHook?.hooks?.length === 1 && stopHook.hooks[0]?.type === "command", "Stop must use one command hook");
assert(stopHook?.hooks?.[0]?.command === 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks.js" stop', "Stop command must use the cross-host Node adapter");
assert(distHooks.includes("tokengraph-hook-session"), "built lifecycle hook must include the private session pointer schema");
assert(!distHooks.includes("createTokenGraphServer"), "built lifecycle hook must not bundle or start the MCP server entry");
const claudeMarketplacePlugin = claudeMarketplace.plugins?.find((plugin) => plugin.name === "tokengraph");
assert(claudeMarketplace.name === "tokengraph", "Claude marketplace must be named tokengraph");
assert(claudeMarketplace.owner?.name === "Mujadarah", "Claude marketplace must identify its owner");
assert(/local-first/i.test(claudeMarketplace.metadata?.description ?? ""), "Claude marketplace must include a useful metadata description");
assert(claudeMarketplacePlugin?.version === packageJson.version, "Claude marketplace plugin version must match package version");
assert(/context/i.test(claudeMarketplacePlugin?.description ?? ""), "Claude marketplace plugin must include discovery copy");
assert(claudeMarketplacePlugin?.source === "./release/tokengraph", "Claude marketplace source must point at ./release/tokengraph");
const marketplacePlugin = marketplace.plugins?.find((plugin) => plugin.name === "tokengraph");
assert(marketplace.name === "tokengraph", "Codex marketplace must be named tokengraph");
assert(marketplace.interface?.displayName === "TokenGraph", "Codex marketplace must display as TokenGraph");
assert(marketplacePlugin, "root marketplace must include tokengraph");
assert(marketplacePlugin.source?.source === "local", "marketplace tokengraph source must be local");
assert(
  marketplacePlugin.source?.path === "./release/tokengraph",
  "marketplace tokengraph source path must point to ./release/tokengraph"
);
assert(resolve(repoRoot, marketplacePlugin.source.path) === releaseRoot, "marketplace tokengraph source path must resolve to release/tokengraph");
assert(marketplacePlugin.policy?.installation === "AVAILABLE", "marketplace tokengraph installation policy must be AVAILABLE");
assert(marketplacePlugin.policy?.authentication === "ON_INSTALL", "marketplace tokengraph authentication policy must be ON_INSTALL");
assert(mcp.mcpServers?.tokengraph?.command === "node", "tokengraph MCP command must be node");
assert(
  Array.isArray(mcp.mcpServers.tokengraph.args) && mcp.mcpServers.tokengraph.args.includes("./dist/index.js"),
  "tokengraph MCP args must include ./dist/index.js"
);
assert(mcp.mcpServers.tokengraph.cwd === ".", "tokengraph MCP cwd must be plugin root");
assert(claudeMcp.mcpServers?.tokengraph?.command === "node", "Claude tokengraph MCP command must be node");
assert(claudeMcp.mcpServers.tokengraph.args?.includes("${CLAUDE_PLUGIN_ROOT}/dist/index.js"), "Claude MCP args must use CLAUDE_PLUGIN_ROOT");
assert(claudeMcp.mcpServers.tokengraph.env?.TOKENGRAPH_WORKSPACE_ROOT === "${CLAUDE_PROJECT_DIR}", "Claude MCP config must forward CLAUDE_PROJECT_DIR");
const sourceSkillContract = await inspectSkillContract(skillsPath, "source plugin skills");
assert(sourceSkillContract.contract === "core", "source plugin skills must use the core contract");
assert(sourceSkillContract.forbiddenCoreTools.length === 0, `source plugin core skills reference non-core tools: ${sourceSkillContract.forbiddenCoreTools.join(", ")}`);
await assertSkillFrontmatter(skillsPath, "source plugin", true);
await assertRequiredFocusedSkills(skillsPath, "source plugin", true);
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
assert(distServer.includes("tokengraph_get_config"), "built MCP server must register v0.8 config getter");
assert(distServer.includes("tokengraph_set_profile"), "built MCP server must register v0.8 profile setter");
assert(distServer.includes("tokengraph_update_config"), "built MCP server must register v0.8 config updater");
assert(distServer.includes("fullReindex"), "built MCP server must expose v0.8 full reindex option");
assert(distServer.includes("indexingMode"), "built MCP server must report v0.8 indexing mode");
assert(distServer.includes("maxEstimatedTokens"), "built MCP server must expose v0.8 planner token budget input");
assert(packageJson.version === "0.21.1", "package version must be 0.21.1 for this release");
assert(distServer.includes("tokengraph_setup_status"), "built MCP server must register setup diagnostics");
assert(distServer.includes("tokengraph_generate_wiki"), "built MCP server must register v0.9 wiki generator");
assert(distServer.includes("tokengraph_show_wiki_page"), "built MCP server must register v0.9 wiki page reader");
assert(distServer.includes("wikiRefreshed"), "built MCP server must report v0.9 wiki auto-refresh state");
assert(distServer.includes("tokengraph_list_rules"), "built MCP server must register architecture rule listing");
assert(distServer.includes("tokengraph_add_rule"), "built MCP server must register architecture rule creation");
assert(distServer.includes("tokengraph_update_rule"), "built MCP server must register architecture rule updates");
assert(distServer.includes("tokengraph_delete_rule"), "built MCP server must register architecture rule deletion");
assert(distServer.includes("tokengraph_check_architecture"), "built MCP server must register architecture checks");
assert(distServer.includes("tokengraph_trace_failure"), "built MCP server must register failure tracing");
assert(distServer.includes("tokengraph_assess_change_risk"), "built MCP server must register change risk assessment");
assert(distServer.includes("tokengraph_compress_context"), "built MCP server must register context compression");
assert(distServer.includes("resource_link"), "built MCP server must emit resource link content for map exports");
assert(distServer.includes("tokengraph_update_memory"), "built MCP server must register memory updates");
assert(distServer.includes("tokengraph_delete_memory"), "built MCP server must register memory deletion");
assert(distServer.includes("tokengraph_deprecate_memory"), "built MCP server must register memory deprecation");
assert(distServer.includes("tokengraph_confirm_memory"), "built MCP server must register memory confirmation");
assert(distServer.includes("tokengraph_find_memory_conflicts"), "built MCP server must register memory conflict checks");
assert(distServer.includes("tokengraph_link_memory"), "built MCP server must register memory linking");
assert(distServer.includes("tokengraph_recall_memory"), "built MCP server must register memory recall");
assert(packageJson.scripts?.["package:plugin"]?.includes("package-plugin.mjs"), "package metadata must expose v0.10 release packaging");
assert(packageJson.scripts?.build === "node scripts/build.mjs", "package build must create a self-contained MCP entry bundle");
assert(packageJson.devDependencies?.esbuild, "package devDependencies must include esbuild for the self-contained MCP bundle");
assert(distReview.includes("flowchart LR"), "built review helpers must include Mermaid project map export");
assert(distReview.includes("resourceLinks"), "built review helpers must include MCP resource link metadata");
assert(distReview.includes("markdownFallback"), "built review helpers must include Markdown diagram fallbacks");

await assertFile(distEntryPath, "built MCP entry");
await assertFile(distHooksPath, "built lifecycle hook entry");
await assertFile(distPolyglotWorkerPath, "built standalone polyglot parser worker");
await assertFile(distTypeScriptWorkerPath, "built standalone TypeScript parser worker");
await assertFile(hooksManifestPath, "lifecycle hook manifest");
await assertFile(distServerPath, "built MCP server");
await assertFile(distReviewPath, "built review helpers");
await assertFile(buildScriptPath, "bundled build script");
await assertFile(smokeScriptPath, "CLI smoke script");
await assertFile(benchmarkScriptPath, "benchmark harness script");
await assertFile(packageScriptPath, "release package script");
await assertFile(nextSupabaseFixturePath, "Next.js Supabase regression fixture");
await assertFile(ignoredOutputFixturePath, "ignored-output regression fixture");
for (const file of ["methodology.md", "results-current.md", "fixtures.md"]) {
  await assertFile(resolve(benchmarkDocsPath, file), `benchmark doc ${file}`);
}
for (const file of ["privacy.md", "security.md", "permissions.md", "local-storage.md", "limitations.md", "release-install.md"]) {
  await assertFile(resolve(trustDocsPath, file), `trust doc ${file}`);
}
for (const file of ["codex.md", "claude-code.md", "generic-mcp.md", "cursor-windsurf.md"]) {
  await assertFile(resolve(hostDocsPath, file), `host doc ${file}`);
}

await assertFile(releaseManifestPath, "release plugin manifest");
await assertFile(releaseMcpPath, "release MCP config");
await assertFile(releaseDistEntryPath, "release built MCP entry");
await assertFile(releaseDistHooksPath, "release built lifecycle hook entry");
await assertFile(releaseDistPolyglotWorkerPath, "release standalone polyglot parser worker");
await assertFile(releaseDistTypeScriptWorkerPath, "release standalone TypeScript parser worker");
await assertFile(releaseHooksManifestPath, "release lifecycle hook manifest");
await assertMissing(releaseDistCorePath, "release dist/core directory");
await assertMissing(resolve(releaseRoot, "dist", "server.js"), "release built MCP server");
await assertFile(releaseReadmePath, "release README");
await assertFile(releasePackageJsonPath, "release package metadata");
for (const asset of grammarAssets) {
  await assertFile(resolve(pluginRoot, "assets", "grammars", asset), `source grammar asset ${asset}`);
  await assertFile(resolve(releaseRoot, "assets", "grammars", asset), `release grammar asset ${asset}`);
}
await assertFile(resolve(releaseRoot, "LICENSE"), "release license");
const releaseSkillContract = await inspectSkillContract(releaseSkillsPath, "release plugin skills");
assert(releaseSkillContract.forbiddenCoreTools.length === 0, `release plugin core skills reference non-core tools: ${releaseSkillContract.forbiddenCoreTools.join(", ")}`);
const releaseUsesCoreLifecycle = releaseSkillContract.contract === "core";
await assertSkillFrontmatter(releaseSkillsPath, "release plugin", releaseUsesCoreLifecycle);
await assertRequiredFocusedSkills(releaseSkillsPath, "release plugin", releaseUsesCoreLifecycle);
const sourceSkillFiles = await collectSkillFiles(skillsPath);
const releaseSkillFiles = await collectSkillFiles(releaseSkillsPath);
assert(sourceSkillFiles.length === 9, `source plugin must contain exactly 9 skills, found ${sourceSkillFiles.length}`);
assert(releaseSkillFiles.length === sourceSkillFiles.length, `release plugin must contain exactly ${sourceSkillFiles.length} source-equivalent skills`);
for (const sourceSkillFile of sourceSkillFiles) {
  const skillRelativePath = relative(skillsPath, sourceSkillFile);
  const releaseSkillFile = resolve(releaseSkillsPath, skillRelativePath);
  const sourceSkill = await readFile(sourceSkillFile);
  const releaseSkill = await readFile(releaseSkillFile).catch(() => undefined);
  assert(releaseSkill !== undefined && sourceSkill.equals(releaseSkill), `release skill ${skillRelativePath} must match source byte-for-byte`);
}
await assertMissing(resolve(releaseRoot, "src"), "release source directory");
await assertMissing(resolve(releaseRoot, "tests"), "release tests directory");
await assertMissing(resolve(releaseRoot, "scripts"), "release scripts directory");
await assertMissing(resolve(releaseRoot, "node_modules"), "release dependency directory");
await assertMissing(resolve(releaseRoot, ".tokengraph"), "release local state directory");

const releaseManifest = await readJson(releaseManifestPath);
const releaseMcp = await readJson(releaseMcpPath);
const releaseClaudeManifest = await readJson(resolve(releaseRoot, ".claude-plugin", "plugin.json"));
const releaseClaudeMcp = await readJson(resolve(releaseRoot, ".mcp.claude.json"));
const releasePackageJson = await readJson(releasePackageJsonPath);
const releaseReadme = await readFile(releaseReadmePath, "utf8").catch((error) => fail(`cannot read release README: ${error.message}`));
const rootReadme = await readFile(rootReadmePath, "utf8").catch((error) => fail(`cannot read root README: ${error.message}`));
const sourceReadme = await readFile(sourceReadmePath, "utf8").catch((error) => fail(`cannot read source plugin README: ${error.message}`));
const codexHostGuide = await readFile(resolve(hostDocsPath, "codex.md"), "utf8").catch((error) => fail(`cannot read Codex host guide: ${error.message}`));
const claudeHostGuide = await readFile(resolve(hostDocsPath, "claude-code.md"), "utf8").catch((error) => fail(`cannot read Claude Code host guide: ${error.message}`));
const securityGuide = await readFile(resolve(trustDocsPath, "security.md"), "utf8").catch((error) => fail(`cannot read security guide: ${error.message}`));
const limitationsGuide = await readFile(resolve(trustDocsPath, "limitations.md"), "utf8").catch((error) => fail(`cannot read limitations guide: ${error.message}`));
const releaseDeclaresHooks = releaseReadme.includes("dist/hooks.js");
assert(releaseDeclaresHooks, "release with lifecycle hooks must document dist/hooks.js");
const releaseHooksManifest = await readJson(releaseHooksManifestPath);
assert(JSON.stringify(releaseHooksManifest) === JSON.stringify(hooksManifest), "release lifecycle hook manifest must match source");
assert(Array.isArray(mcp.mcpServers.tokengraph.env_vars) && mcp.mcpServers.tokengraph.env_vars.includes("TOKENGRAPH_WORKSPACE_ROOT"), "tokengraph MCP config must forward TOKENGRAPH_WORKSPACE_ROOT");
assert(sourceReadme.includes("TOKENGRAPH_WORKSPACE_ROOT"), "plugin README must document trusted workspace configuration");
assert(codexHostGuide.includes("TOKENGRAPH_WORKSPACE_ROOT"), "Codex host guide must document trusted workspace configuration");
assert(claudeHostGuide.includes("CLAUDE_PROJECT_DIR"), "Claude Code host guide must document its trusted project root");
assert(/review and trust/i.test(codexHostGuide) && /hooks\s*=\s*false/.test(codexHostGuide), "Codex host guide must document hook trust and disablement");
assert(claudeHostGuide.includes("disableAllHooks") && /interrupt|API failure/i.test(claudeHostGuide), "Claude host guide must document hook disablement and abnormal-stop limits");
assert(/disabled|untrusted/i.test(limitationsGuide) && /interrupt|API failure/i.test(limitationsGuide), "limitations must document hook trust and abnormal-stop limits");
assert(sourceReadme.includes("dist/hooks.js") && /session hash/i.test(sourceReadme), "plugin README must document hook packaging and pointer privacy");
assert(/trusted workspace|workspace trust boundary/i.test(securityGuide), "security guide must document the trusted workspace boundary");
const registeredToolNames = Array.from(distServer.matchAll(/registerTool\(\s*["'](tokengraph_[a-z0-9_]+)["']/g), (match) => match[1]);
const documentedToolNames = new Set(Array.from(sourceReadme.matchAll(/`(tokengraph_[a-z0-9_]+)`/g), (match) => match[1]));
for (const toolName of registeredToolNames) {
  assert(documentedToolNames.has(toolName), `plugin README must document registered tool ${toolName}`);
}

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}
const personalWindowsProfilePathPattern = /C:\\Users\\(?!example(?:\\|$))[^\\\s]+/i;
const packagedFiles = [
  ...await collectFiles(pluginRoot),
  ...await collectFiles(releaseRoot)
].filter((path) => !path.includes(`${sep}node_modules${sep}`));
for (const filePath of packagedFiles) {
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (content !== undefined) {
    assert(!personalWindowsProfilePathPattern.test(content), `packaged file ${filePath} must not contain personal Windows profile paths`);
  }
}
assert(releaseManifest.name === manifest.name, "release plugin manifest name must match source manifest");
assert(releaseManifest.version?.split("+", 1)[0] === packageJson.version, "release plugin manifest base version must match package version");
assert(releasePackageJson.version === packageJson.version, "release package version must match source package version");
assert(releaseMcp.mcpServers?.tokengraph?.command === "node", "release tokengraph MCP command must be node");
assert(
  Array.isArray(releaseMcp.mcpServers.tokengraph.args) && releaseMcp.mcpServers.tokengraph.args.includes("./dist/index.js"),
  "release tokengraph MCP args must include ./dist/index.js"
);
assert(releaseMcp.mcpServers.tokengraph.cwd === ".", "release tokengraph MCP cwd must be plugin root");
assert(releaseClaudeManifest.mcpServers === "./.mcp.claude.json", "release Claude manifest must point at ./.mcp.claude.json");
assert(releaseClaudeMcp.mcpServers?.tokengraph?.args?.includes("${CLAUDE_PLUGIN_ROOT}/dist/index.js"), "release Claude MCP args must use CLAUDE_PLUGIN_ROOT");
assert(releaseClaudeMcp.mcpServers?.tokengraph?.env?.TOKENGRAPH_WORKSPACE_ROOT === "${CLAUDE_PROJECT_DIR}", "release Claude MCP config must forward CLAUDE_PROJECT_DIR");

console.log(`TokenGraph plugin validation passed (${packageJson.version}).`);
