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
    expect(workflow).toContain("sha256sum");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--draft");
  });
});
