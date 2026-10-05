import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const skillsRoot = join(process.cwd(), "skills");
const expectedNames = [
  "architecture-consistency-checker",
  "context-compression",
  "graph-context-retrieval",
  "memory-curator",
  "regression-detector",
  "release-packaging-auditor",
  "root-cause-debugger",
  "token-budget-optimizer",
  "tokengraph"
].sort();
const coreTools = new Set([
  "tokengraph_setup",
  "tokengraph_prepare_context",
  "tokengraph_query_context",
  "tokengraph_compress",
  "tokengraph_recall",
  "tokengraph_analyze",
  "tokengraph_propose_knowledge",
  "tokengraph_task_report"
]);

function loadSkill(name: string): { frontmatter: Record<string, string>; body: string; text: string } {
  const text = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  expect(match, `${name} must have YAML frontmatter`).not.toBeNull();
  const frontmatter = Object.fromEntries(
    match![1].split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
  );
  return { frontmatter, body: match![2], text };
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function expectFrontmatterContract(name: string): void {
  const { frontmatter, text } = loadSkill(name);
  expect(frontmatter.name).toBe(name);
  expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
  expect(frontmatter.description).toMatch(/^Use when\b/);
  expect(frontmatter.description).not.toMatch(/\b(call|workflow|tool|TokenGraph)\b/i);
  expect((frontmatter.description.match(/\bUse when\b/g) ?? [])).toHaveLength(1);
  const references = [...text.matchAll(/\btokengraph_[a-z0-9_]+\b/g)].map((match) => match[0]);
  expect([...new Set(references)].filter((tool) => !coreTools.has(tool)), `${name} references non-core tools`).toEqual([]);
  expect(wordCount(text)).toBeLessThanOrEqual(500);
}

const routerLifecycleMarkers = [
  /tokengraph_setup\(\{ confirmNoLegacyProcesses: true \}\).*trustedWorkspace\.root.*trusted root/is,
  /tokengraph_prepare_context.*only when.*plan/is,
  /omit.*taskId.*auto-start.*return.*taskId/is,
  /capture.*returned taskId/is,
  /never merge tasks.*invent an id.*reuse.*completed taskId/is,
  /compact.*default.*responseMode: "verbose".*diagnostic/is,
  /disposition: "pause"/,
  /TokenGraph was not used/,
  /fresh task.*\/reload-plugins/is,
  /paused task id.*terminal.*new task.*prepare_context.*omit.*taskId/is,
  /lifecycle hook.*normal Stop/is,
  /knownArtifacts[\s\S]*id@hash[\s\S]*prior response/is,
  /omit.*knownArtifacts[\s\S]*resend/is
];

const sharedRouterReference = /shared `tokengraph` router contract/i;

const specializedMarkers: Record<string, RegExp[]> = {
  "graph-context-retrieval": [/mode: "overview"/, /mode: "search"/, /mode: "symbol"/, /mode: "sql"/, /mode: "wiki"/, /targeted raw reads/i, /confidence/i, /knownArtifacts[\s\S]*id@hash[\s\S]*prior response/i, /omit.*knownArtifacts[\s\S]*resend/i],
  "context-compression": [/mode: "output"/, /mode: "context"/, /omissions/i, /constraints/i, /targeted raw reads/i, /omittedLineCount/i, /token estimate/i, /context mode.*confidence/is],
  "token-budget-optimizer": [/profile/i, /budgets/i, /task policy/i, /no fixed.*defaults/i, /tokengraph_query_context/, /tokengraph_compress/, /overhead/i, /estimated savings/i, /exact claims/i],
  "root-cause-debugger": [/mode: "output"/, /mode: "failure"/, /original failure text.*exactly once/is, /returned compressed evidence/i, /not the consumer/i, /tokengraph_query_context/, /facts/i, /hypotheses/i, /regression evidence/i],
  "regression-detector": [/mode: "risk"/, /mode: "symbol"/, /mode: "sql"/, /recommend/i, /verif(?:y|ied).*tests/i],
  "architecture-consistency-checker": [/mode: "architecture"/, /mode: "risk"/, /import/i, /SQL/i, /security/i, /release/i, /proposals/i, /enforced facts/i],
  "memory-curator": [/mode: "review"/, /audit: true/, /tokengraph_query_context/, /action: "propose"/, /applicationStatus.*applied/i, /stale or expired.*cannot|cannot.*stale or expired/i, /approval/i, /application/i],
  "release-packaging-auditor": [/tokengraph_prepare_context/, /tokengraph_query_context/, /mode: "risk"/, /tokengraph_compress/, /typecheck/i, /full tests/i, /build/i, /core smoke/i, /full smoke/i, /validation/i, /generated release/i, /direct release/i, /extracted ZIP/i, /host/i]
};

function expectSpecializedContract(name: string): void {
  const { body } = loadSkill(name);
  expectFrontmatterContract(name);
  expect(body).toMatch(sharedRouterReference);
  expect(body).toMatch(/^## When not to use/m);
  expect(body).toMatch(/^## Unique tool sequence/m);
  expect(body).toMatch(/^## Evidence required/m);
  expect(body).toMatch(/^## Failure boundaries/m);
  expect(body).toMatch(/^## Completion criteria/m);
  expect(body).not.toMatch(/tokengraph_setup\(/);
  expect(body).not.toContain("tokengraph_task_report");
  expect(body).not.toMatch(/lifecycle hook.*normal Stop|TokenGraph was not used|paused task id.*terminal/is);
  for (const marker of specializedMarkers[name] ?? []) expect(body, `${name} is missing ${marker}`).toMatch(marker);
}

describe("bundled skill contracts", () => {
  test("skill directory names remain invocation-compatible", () => {
    const actual = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(actual).toEqual(expectedNames);
  });

  test("normalized trigger descriptions are unique across all nine skills", () => {
    const descriptions = expectedNames.map((name) => loadSkill(name).frontmatter.description.toLowerCase().replace(/\s+/g, " ").trim());
    expect(new Set(descriptions).size).toBe(9);
  });

  test("tokengraph is the canonical lifecycle router", () => {
    expectFrontmatterContract("tokengraph");
    const { body } = loadSkill("tokengraph");
    expect(body).toMatch(/router/i);
    for (const marker of routerLifecycleMarkers) expect(body, `router is missing ${marker}`).toMatch(marker);
  });

  for (const name of Object.keys(specializedMarkers)) test(name, () => expectSpecializedContract(name));

  test("router is the only skill that carries lifecycle instructions", () => {
    const router = loadSkill("tokengraph").body;
    expect(routerLifecycleMarkers.every((marker) => marker.test(router))).toBe(true);
    for (const name of Object.keys(specializedMarkers)) {
      const body = loadSkill(name).body;
      expect(body).not.toMatch(/tokengraph_setup\(/);
      expect(body).not.toContain("tokengraph_task_report");
    }
  });

  test("specialized skills stay compact without deleting safety sections", () => {
    const specializedNames = Object.keys(specializedMarkers);
    const specializedWords = specializedNames.reduce((total, name) => total + wordCount(loadSkill(name).text), 0);
    expect(specializedWords).toBeLessThanOrEqual(1_300);
    for (const name of specializedNames) expect(wordCount(loadSkill(name).text), name).toBeLessThanOrEqual(170);
  });

  test("specialized skills do not duplicate the router body", () => {
    const routerSentences = loadSkill("tokengraph").body
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 48)
      .filter((sentence) => /trustedWorkspace\.root|tokengraph_task_report|TokenGraph was not used|paused task id|lifecycle hook/i.test(sentence));
    for (const name of Object.keys(specializedMarkers)) {
      const body = loadSkill(name).body;
      const duplicated = routerSentences.filter((sentence) => body.includes(sentence));
      expect(duplicated, `${name} duplicates router lifecycle prose`).toEqual([]);
    }
  });
});
