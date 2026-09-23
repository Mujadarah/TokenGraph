import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const configPath = resolve(process.cwd(), "../..", ".gitlab-ci.yml");
function config() {
  expect(existsSync(configPath)).toBe(true);
  return readFileSync(configPath, "utf8");
}

describe("GitLab complementary CI", () => {
  it("creates branch pipelines without a dependency-scanning MR duplicate", () => {
    const ci = config();
    expect(ci).toContain("if: '$CI_COMMIT_BRANCH'");
    expect(ci).toContain('AST_ENABLE_MR_PIPELINES: "false"');
    expect(ci).toContain("when: never");
  });

  it("uses stable security templates and scans nested lockfiles", () => {
    const ci = config();
    expect(ci).toContain("template: Jobs/SAST.gitlab-ci.yml");
    expect(ci).toContain("template: Jobs/Dependency-Scanning.v2.gitlab-ci.yml");
    expect(ci).toContain("template: Jobs/Secret-Detection.gitlab-ci.yml");
    expect(ci).toContain('GITLAB_ADVANCED_SAST_ENABLED: "true"');
    expect(ci).toContain('DS_MAX_DEPTH: "5"');
    expect(ci).not.toContain("Jobs/Dependency-Scanning.latest.gitlab-ci.yml");
  });

  it("runs one bounded Linux source smoke without release or full-suite work", () => {
    const ci = config();
    expect(ci).toContain("tokengraph-linux:");
    expect(ci).toContain("image: node:22-bookworm");
    expect(ci).toContain("corepack prepare pnpm@10.14.0 --activate");
    expect(ci).toContain("pnpm install --frozen-lockfile");
    expect(ci).toContain("pnpm typecheck");
    expect(ci).toContain("pnpm build");
    expect(ci).toContain("pnpm smoke -- --root . --json");
    expect(ci).not.toMatch(/^\s*-\s*pnpm (?:test|native:build|package:plugin)\b/mu);
    expect(ci).not.toMatch(/^\s*(?:deploy|release):/mu);
  });
});
