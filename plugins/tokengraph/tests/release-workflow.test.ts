import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tagged release workflow", () => {
  it("verifies the pinned toolchain, package gates, checksum, and draft upload", () => {
    const workflow = readFileSync(resolve(process.cwd(), "../..", ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain("pnpm/action-setup@v4");
    expect(workflow).toContain("version: 10.14.0");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("pnpm --silent package:plugin -- --release --json");
    expect(workflow).toContain("pnpm --silent package:plugin -- --json > bundle-package.json");
    expect(workflow).toContain('fs.readFileSync("bundle-package.json", "utf8")');
    expect(workflow).toContain("sha256sum");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("--notes-file release-notes.md");
    expect(workflow).toContain("node plugins/tokengraph/scripts/validate-release-notes.mjs --file release-notes.md");
    expect(workflow).toContain("--- TOKENGRAPH_CURRENT_STATE START ---");
    expect(workflow).toContain("B7_POLYGLOT_INDEXING=active-by-default");
    expect(workflow).toContain("B7_ROUTING_PROMOTION=independent");
    expect(workflow).toContain("ROUTING_MODE=shadow-only");
    expect(workflow).toContain("ENFORCEMENT=disabled");
    expect(workflow).toContain("--- TOKENGRAPH_CURRENT_STATE END ---");
    expect(workflow).toMatch(/reviewed schema-v3 campaigns now cover three repositories/i);
    expect(workflow).toMatch(/multi-repository coverage target is met/i);
    expect(workflow).toContain('"${{ steps.artifact.outputs.archive }}"');
    expect(workflow).not.toContain('"plugins/tokengraph/${{ steps.artifact.outputs.archive }}"');
  });
});

function validateReleaseNotes(fixture: string) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "validate-release-notes.mjs")], {
    encoding: "utf8",
    input: readFileSync(resolve(process.cwd(), "tests", "fixtures", "release-notes", fixture), "utf8")
  });
}

describe("release-note contract", () => {
  function expectContractFailure(fixture: string, message: string) {
    const result = validateReleaseNotes(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TokenGraph release-note validation failed:");
    expect(result.stderr).toContain(message);
  }

  it.each([
    ["history-plus-current-disabled.md", "outside a delimited state block"],
    ["b7-dependent-outside.md", "outside a delimited state block"],
    ["routing-does-not-remain-shadow.md", "outside a delimited state block"],
    ["routing-not-in-shadow-mode.md", "outside a delimited state block"],
    ["routing-shadow-but-enforced.md", "outside a delimited state block"],
    ["missing-enforcement-disabled.md", "canonical fields"],
    ["malformed-current-block.md", "canonical fields"],
    ["duplicate-current-block.md", "exactly one current-state block"],
    ["missing-current-block.md", "exactly one current-state block"]
  ])("rejects %s with a meaningful contract error", (fixture, message) => {
    expectContractFailure(fixture, message);
  });

  it("accepts historical B7 inactivity until the current version", () => {
    const result = validateReleaseNotes("history-until-v023.md");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
