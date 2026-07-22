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
    expect(workflow).toMatch(/enforcement remains disabled/i);
    expect(workflow).toMatch(/schema-v3 real-host evidence/i);
    expect(workflow).toContain('"${{ steps.artifact.outputs.archive }}"');
    expect(workflow).not.toContain('"plugins/tokengraph/${{ steps.artifact.outputs.archive }}"');
  });
});
