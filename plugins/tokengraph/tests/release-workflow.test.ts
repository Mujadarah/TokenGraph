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
    expect(workflow).toContain('VERSION="${GITHUB_REF_NAME#v}"');
    const packageVersionCheck = 'node plugins/tokengraph/scripts/validate-release-version.mjs --package plugins/tokengraph/package.json --version "$VERSION"';
    expect(workflow).toContain(packageVersionCheck);
    expect(workflow.indexOf(packageVersionCheck)).toBeLessThan(workflow.indexOf("pnpm --silent package:plugin -- --release --json"));
    expect(workflow).toContain('node plugins/tokengraph/scripts/render-release-notes.mjs --version "$VERSION" > release-notes.md');
    expect(workflow).toContain('node plugins/tokengraph/scripts/validate-release-notes.mjs --file release-notes.md --version "$VERSION"');
    expect(workflow).toContain('"${{ steps.artifact.outputs.archive }}"');
    expect(workflow).not.toContain('"plugins/tokengraph/${{ steps.artifact.outputs.archive }}"');
  });
});

function fixturePath(fixture: string) {
  return resolve(process.cwd(), "tests", "fixtures", "release-notes", fixture);
}

function validateReleaseNotes(fixture: string, args: string[] = ["--version", "0.23.0"]) {
  return runReleaseNoteValidator(["--file", fixturePath(fixture), ...args]);
}

function runReleaseNoteValidator(args: string[]) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "validate-release-notes.mjs"), ...args], {
    encoding: "utf8"
  });
}

function renderReleaseNotes(args: string[] = ["--version", "0.23.0"]) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "render-release-notes.mjs"), ...args], {
    encoding: "utf8"
  });
}

function packagePath() {
  return resolve(process.cwd(), "package.json");
}

function validateReleaseVersion(args: string[] = ["--package", packagePath(), "--version", "0.23.0"]) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "validate-release-version.mjs"), ...args], {
    encoding: "utf8"
  });
}

describe("release-note contract", () => {
  function expectContractFailure(fixture: string) {
    const result = validateReleaseNotes(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TokenGraph release-note validation failed:");
    expect(result.stderr).toContain("canonical release notes");
  }

  it("renders the independently asserted canonical B7 and routing semantics", () => {
    const result = renderReleaseNotes();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(readFileSync(fixturePath("canonical-v023.md"), "utf8"));
    expect(result.stdout).toContain("B7 polyglot indexing is active by default and independent of routing promotion.\nRouting remains shadow-only.\nEnforcement remains disabled.");
  });

  it.each([
    "historical-present-day-contradiction.md",
    "html-comment-hidden-canonical.md",
    "fenced-canonical.md",
    "escaped-marker.md",
    "prefixed-marker.md",
    "suffixed-marker.md",
    "html-entity-b7.md",
    "inserted-line.md",
    "removed-line.md",
    "modified-line.md"
  ])("rejects the exact-artifact bypass %s", (fixture) => {
    expectContractFailure(fixture);
  });

  it("accepts only the full canonical artifact for its explicit version", () => {
    const result = validateReleaseNotes("canonical-v023.md");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["renderer", () => renderReleaseNotes([])],
    ["validator", () => validateReleaseNotes("canonical-v023.md", [])]
  ])("requires an explicit version for the %s CLI", (_label, invoke) => {
    const result = invoke();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release version is required");
  });

  it.each(["0.0.0", "1.23.456"])("accepts the strict numeric semantic version %s", (version) => {
    const result = renderReleaseNotes(["--version", version]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.each(["00.23.0", "0.023.0", "0.23.00", "v0.23.0", "0.23", "0.23.0-beta"])("rejects the non-canonical semantic version %s", (version) => {
    const result = renderReleaseNotes(["--version", version]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("semantic version");
  });

  it.each([
    ["duplicate file", () => runReleaseNoteValidator(["--file", fixturePath("canonical-v023.md"), "--file", fixturePath("canonical-v023.md"), "--version", "0.23.0"]), "release notes file may only be provided once"],
    ["duplicate version", () => runReleaseNoteValidator(["--file", fixturePath("canonical-v023.md"), "--version", "0.23.0", "--version", "0.23.0"]), "release version may only be provided once"],
    ["missing file value", () => runReleaseNoteValidator(["--file", "--version", "0.23.0"]), "release notes file requires a value"],
    ["missing version value", () => runReleaseNoteValidator(["--file", fixturePath("canonical-v023.md"), "--version"]), "release version requires a value"]
  ])("rejects validator arguments with %s", (_label, invoke, message) => {
    const result = invoke();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

describe("release tag and package parity", () => {
  it("accepts a package version matching the tag version", () => {
    const result = validateReleaseVersion();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TokenGraph release tag and package version match.");
  });

  it("rejects a package version that differs from the tag version", () => {
    const result = validateReleaseVersion(["--package", packagePath(), "--version", "0.23.1"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match release tag version 0.23.1");
  });

  it.each([
    ["duplicate package", ["--package", packagePath(), "--package", packagePath(), "--version", "0.23.0"], "package path may only be provided once"],
    ["duplicate version", ["--package", packagePath(), "--version", "0.23.0", "--version", "0.23.0"], "release version may only be provided once"],
    ["missing package value", ["--package", "--version", "0.23.0"], "package path requires a value"],
    ["missing version value", ["--package", packagePath(), "--version"], "release version requires a value"]
  ])("rejects release-version validator arguments with %s", (_label, args, message) => {
    const result = validateReleaseVersion(args);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
