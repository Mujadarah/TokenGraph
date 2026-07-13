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

function expectCommonContract(name: string): void {
  const { frontmatter, body, text } = loadSkill(name);
  expect(frontmatter.name).toBe(name);
  expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
  expect(frontmatter.description).toMatch(/^Use when\b/);
  expect(frontmatter.description).not.toMatch(/\b(call|workflow|tool|TokenGraph)\b/i);
  expect((frontmatter.description.match(/\bUse when\b/g) ?? [])).toHaveLength(1);

  const references = [...text.matchAll(/\btokengraph_[a-z0-9_]+\b/g)].map((match) => match[0]);
  expect([...new Set(references)].filter((tool) => !coreTools.has(tool)), `${name} references non-core tools`).toEqual([]);
  expect(body).toContain("tokengraph_setup({})");
  expect(body).toContain("tokengraph_prepare_context");
  expect(body.match(/tokengraph_prepare_context/g) ?? [], `${name} must prepare exactly once`).toHaveLength(1);
  expect(body, `${name} must not make the trusted root optional`).not.toMatch(/\broot\s*\?/);
  const taskAwareExamples = [...body.matchAll(/\btokengraph_(?:query_context|compress|recall|analyze|propose_knowledge|task_report)\(\{([^}]*)\}\)/g)];
  for (const example of taskAwareExamples) {
    expect(example[1], `${name} task-aware example must pass the captured root: ${example[0]}`).toMatch(/\broot:\s*trusted root\b/);
  }
  expect(body).toMatch(/tokengraph_setup\(\{\}\)[^\n]*capture[^\n]*trustedWorkspace\.root[^\n]*trusted root/i);
  expect(body).toMatch(/tokengraph_prepare_context[^.]*capture[^.]*taskId/i);
  expect(body).toContain("taskId");
  expect(body).toContain("trusted root");
  expect(body).toContain("tokengraph_task_report");
  expect(body).toContain('disposition: "pause"');
  expect(body).toContain('disposition: "complete"');
  expect(body).toMatch(/do not invent|never invent/i);
  expect(body).toMatch(/unavailable/i);
  expect(body).toMatch(/TokenGraph was not used/);
  expect(body).toMatch(/fresh task|\/reload-plugins/);
  expect(body).toMatch(/report.*status|status.*report/i);
  expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(500);
}

describe("bundled skill contracts", () => {
  test("skill directory names remain invocation-compatible", () => {
    const actual = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(actual).toEqual(expectedNames);
  });

  test("normalized trigger descriptions are unique across all nine skills", () => {
    const descriptions = expectedNames.map((name) => loadSkill(name).frontmatter.description.toLowerCase().replace(/\s+/g, " ").trim());
    expect(new Set(descriptions).size).toBe(9);
  });

  test("tokengraph", () => {
    expectCommonContract("tokengraph");
    const { body } = loadSkill("tokengraph");
    expect(body).toMatch(/router/i);
    expect(body).toMatch(/blocked setup.*recovery/is);
    expect(body).toMatch(/exact taskId/i);
    expect(body).toMatch(/never.*completed.*taskId/is);
    expect(body).toMatch(/lifecycle hook.*normal Stop/i);
  });

  const specialized: Record<string, RegExp[]> = {
    "graph-context-retrieval": [/When not to use/i, /mode: "overview"/, /mode: "search"/, /mode: "symbol"/, /mode: "sql"/, /mode: "wiki"/, /targeted raw reads/i, /confidence/i],
    "context-compression": [/When not to use/i, /mode: "output"/, /mode: "context"/, /omissions/i, /constraints/i, /targeted raw reads/i, /omittedLineCount/i, /token estimate/i, /context mode.*confidence/is],
    "token-budget-optimizer": [/When not to use/i, /profile/i, /budgets/i, /task policy/i, /no fixed.*defaults/i, /tokengraph_query_context/, /tokengraph_compress/, /overhead/i, /estimated savings/i, /exact claims/i],
    "root-cause-debugger": [/When not to use/i, /mode: "output"/, /mode: "failure"/, /original failure text/i, /exactly once/i, /returned compressed evidence/i, /not the consumer/i, /tokengraph_query_context/, /facts/i, /hypotheses/i, /regression evidence/i],
    "regression-detector": [/When not to use/i, /mode: "risk"/, /mode: "symbol"/, /mode: "sql"/, /recommend/i, /verif(?:y|ied).*tests/i],
    "architecture-consistency-checker": [/When not to use/i, /mode: "architecture"/, /mode: "risk"/, /import/i, /SQL/i, /security/i, /release/i, /proposals/i, /enforced facts/i],
    "memory-curator": [/When not to use/i, /mode: "review"/, /audit: true/, /tokengraph_query_context/, /action: "propose"/, /applicationStatus.*applied/i, /stale or expired.*cannot|cannot.*stale or expired/i, /approval/i, /application/i],
    "release-packaging-auditor": [/When not to use/i, /tokengraph_prepare_context/, /tokengraph_query_context/, /mode: "risk"/, /tokengraph_compress/, /typecheck/i, /full tests/i, /build/i, /core smoke/i, /full smoke/i, /validation/i, /generated release/i, /direct release/i, /extracted ZIP/i, /host/i]
  };

  for (const [name, markers] of Object.entries(specialized)) {
    test(name, () => {
      expectCommonContract(name);
      const { body } = loadSkill(name);
      expect(body).toMatch(/lifecycle.*tokengraph.*skill/i);
      for (const marker of markers) expect(body, `${name} is missing ${marker}`).toMatch(marker);
    });
  }
});
