import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

describe("tagged release workflow", () => {
  it("verifies the pinned toolchain, package gates, checksum, and draft upload", () => {
    const workflow = readFileSync(resolve(process.cwd(), "../..", ".github/workflows/release.yml"), "utf8");
    const ciWorkflow = readFileSync(resolve(process.cwd(), "../..", ".github/workflows/ci.yml"), "utf8");
    const approvedActions = new Map([
      ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
      ["pnpm/action-setup", "b906affcce14559ad1aafd4ab0e942779e9f58b1"],
      ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
      ["actions/attest", "508db95dd578ae2727ebd6217d5ba78e4fbda05d"],
      ["anchore/sbom-action", "e22c389904149dbc22b58101806040fa8d37a610"],
      ["sigstore/cosign-installer", "6f9f17788090df1f26f669e9d70d6ae9567deba6"]
    ]);
    expect(workflow).toContain("tags: ['v*']");
    expect(ciWorkflow).toMatch(/^permissions:\r?\n  contents: read$/m);
    expect(workflow).toMatch(/^permissions:\r?\n  contents: write$/m);
    for (const configuredWorkflow of [workflow, ciWorkflow]) {
      expect(configuredWorkflow).not.toMatch(/uses:\s+\S+@v\d+/);
      const references = Array.from(configuredWorkflow.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/g));
      expect(references).toHaveLength(configuredWorkflow === workflow ? 7 : 3);
      for (const [, action, revision] of references) {
        expect(revision).toBe(approvedActions.get(action));
      }
    }
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow).not.toContain("cache-dependency-path:");
    expect(workflow).toContain("version: 10.14.0");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("pnpm --silent package:plugin -- --release --json");
    expect(workflow).toContain("git diff --exit-code -- release/tokengraph");
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
  it("requires pinned SBOM, Sigstore, attestation, checksum, and upload contracts", () => {
    const workflow = readFileSync(resolve(process.cwd(), "../..", ".github/workflows/release.yml"), "utf8");
    const output = (value: string) => "$" + "{{ " + value + " }}";
    const archive = output("steps.artifact.outputs.archive");
    const checksum = output("steps.artifact.outputs.checksum");
    const checksums = output("steps.artifact.outputs.checksums");
    const sbom = output("steps.artifact.outputs.sbom");
    const archiveBundle = output("steps.artifact.outputs.archive_bundle");
    const sbomBundle = output("steps.artifact.outputs.sbom_bundle");

    expect(workflow).toMatch(/^permissions:\r?\n  contents: write\r?\n  id-token: write\r?\n  attestations: write\r?\n  artifact-metadata: write$/m);
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).not.toMatch(/^\s*branches:/m);
    for (const [action, revision] of [
      ["actions/attest", "508db95dd578ae2727ebd6217d5ba78e4fbda05d"],
      ["anchore/sbom-action", "e22c389904149dbc22b58101806040fa8d37a610"],
      ["sigstore/cosign-installer", "6f9f17788090df1f26f669e9d70d6ae9567deba6"]
    ]) {
      expect(workflow).toContain("uses: " + action + "@" + revision);
    }
    expect(workflow).not.toMatch(/uses:\s+\S+@v\d+/);
    expect(workflow).toContain("cosign-release: v3.0.6");
    expect(workflow).toContain(String.raw`unzip -q "$archive" -d "$extract_dir"`);
    expect(workflow).toContain(String.raw`plugin_dir="$extract_dir/tokengraph"`);
    expect(workflow).toContain(String.raw`node scripts/verify-package-parity.mjs --release ../../release/tokengraph --archive "$archive"`);
    expect(workflow).toContain(String.raw`pnpm smoke -- --root "$smoke_root" --server "$plugin_dir/dist/index.js" --json`);
    expect(workflow).toContain(String.raw`pnpm smoke -- --root "$smoke_root" --server "$plugin_dir/dist/index.js" --surface full --json`);
    expect(workflow).toContain("path: " + output("steps.extract.outputs.plugin_dir"));
    expect(workflow).toContain("format: spdx-json");
    expect(workflow).toContain("output-file: " + sbom);
    expect(workflow).toContain("dependency-snapshot: false");
    expect(workflow).toContain("upload-artifact: false");
    expect(workflow).toContain("upload-release-assets: false");
    expect(workflow).toContain(String.raw`checksum="$archive.sha256"`);
    expect(workflow).toContain(String.raw`sbom="$archive_base.spdx.json"`);
    expect(workflow).toContain(String.raw`archive_bundle="$archive.sigstore.json"`);
    expect(workflow).toContain(String.raw`sbom_bundle="$sbom.sigstore.json"`);
    expect(workflow).toContain(String.raw`checksums="$archive_base.checksums.txt"`);
    expect(workflow).toContain(String.raw`sha256sum "$(basename "$archive")" > "$(basename "$checksum")"`);
    expect(workflow).toContain(String.raw`sha256sum "$(basename "$archive")" "$(basename "$sbom")" "$(basename "$archive_bundle")" "$(basename "$sbom_bundle")" > "$(basename "$checksums")"`);
    expect(workflow.match(/cosign sign-blob --yes --bundle/g)).toHaveLength(2);
    expect(workflow.match(/cosign verify-blob/g)).toHaveLength(2);
    expect(workflow.split(String.raw`--certificate-identity "$workflow_identity"`)).toHaveLength(3);
    expect(workflow.split(String.raw`--certificate-oidc-issuer "https://token.actions.githubusercontent.com"`)).toHaveLength(3);
    expect(workflow).toContain(String.raw`workflow_identity="https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF"`);
    for (const forbiddenKeyInput of ["--key", "COSIGN_KEY", "COSIGN_PASSWORD", "secrets.COSIGN", "secrets.SIGSTORE"]) {
      expect(workflow).not.toContain(forbiddenKeyInput);
    }
    expect(workflow.match(/uses:\s+actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d/g)).toHaveLength(2);
    expect(workflow).toContain("subject-path: " + archive);
    expect(workflow).toContain("sbom-path: " + sbom);
    for (const asset of [archive, checksum, checksums, sbom, archiveBundle, sbomBundle]) {
      expect(workflow).toContain("\"" + asset + "\"");
    }

    const orderedSteps = [
      "Build release package",
      "Confirm committed release is reproducible",
      "Build standalone release archive",
      "Prepare release assets",
      "Verify packaged release parity",
      "Extract installable plugin for SBOM",
      "Smoke extracted release runtime",
      "Generate SPDX SBOM",
      "Install Cosign",
      "Sign release assets",
      "Verify release signatures",
      "Create GitHub build provenance attestation",
      "Create GitHub SBOM attestation",
      "Create draft GitHub release"
    ];
    const positions = orderedSteps.map((step) => workflow.indexOf("- name: " + step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.slice().sort((left, right) => left - right));
  });
});

function runPackageParity(options: {
  releaseFiles?: Record<string, string>;
  archiveFiles?: Record<string, string>;
  wrapperFiles?: Record<string, string>;
  archiveExtras?: Record<string, string>;
}) {
  const root = mkdtempSync(join(tmpdir(), "tokengraph-parity-"));
  try {
    const releaseRoot = join(root, "release");
    const releaseFiles = options.releaseFiles ?? { "README.md": "same\n", "dist/index.js": "index\n", "package.json": "{\"version\":\"0.25.0\"}\n" };
    const archiveFiles = options.archiveFiles ?? releaseFiles;
    for (const [path, text] of Object.entries(releaseFiles)) {
      const output = join(releaseRoot, ...path.split("/"));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, text);
    }
    const archivePath = join(root, "bundle.zip");
    const wrappers = options.wrapperFiles ?? {
      ".agents/plugins/marketplace.json": `${JSON.stringify({
        name: "tokengraph",
        interface: { displayName: "TokenGraph" },
        plugins: [{ name: "tokengraph", source: { source: "local", path: "./tokengraph" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }]
      }, null, 2)}\n`,
      ".claude-plugin/marketplace.json": `${JSON.stringify({
        name: "tokengraph", owner: { name: "Mujadarah" },
        metadata: { description: "Local-first project context routing for Codex and Claude Code." },
        plugins: [{ name: "tokengraph", source: "./tokengraph", version: "0.25.0", description: "Route coding agents through compact local code, SQL, memory, wiki, and log context.", category: "Developer Tools", tags: ["mcp", "code-intelligence", "local-first", "context"] }]
      }, null, 2)}\n`
    };
    const entries: Record<string, Uint8Array> = Object.fromEntries(
      Object.entries({ ...wrappers, ...options.archiveExtras }).map(([path, text]) => [path, Buffer.from(text)])
    );
    for (const [path, text] of Object.entries(archiveFiles)) {
      entries[`tokengraph/${path}`] = Buffer.from(text);
    }
    writeFileSync(archivePath, zipSync(entries));
    return spawnSync(process.execPath, [
      resolve(process.cwd(), "scripts", "verify-package-parity.mjs"),
      "--release", releaseRoot,
      "--archive", archivePath
    ], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("standalone package parity", () => {
  it("accepts an exact installable payload and marketplace wrappers", () => {
    const result = runPackageParity({});

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/matches the committed release byte-for-byte/i);
  });

  it.each([
    ["mutated bytes", { archiveFiles: { "README.md": "changed\n", "dist/index.js": "index\n" } }],
    ["an extra payload file", { archiveFiles: { "README.md": "same\n", "dist/index.js": "index\n", "extra.txt": "extra\n" } }],
    ["a missing payload file", { archiveFiles: { "README.md": "same\n" } }],
    ["a traversal path", { archiveFiles: { "README.md": "same\n", "dist/index.js": "index\n", "../escape.txt": "escape\n" } }],
    ["a mutated marketplace source", { wrapperFiles: {
      ".agents/plugins/marketplace.json": "{\"plugins\":[{\"source\":{\"source\":\"local\",\"path\":\"../other\"}}]}\n",
      ".claude-plugin/marketplace.json": "{}\n"
    } }],
    ["a missing marketplace wrapper", { wrapperFiles: {
      ".agents/plugins/marketplace.json": "{}\n"
    } }],
    ["an extra safe archive entry", { archiveExtras: { "other/readme.txt": "unverified\n" } }]
  ])("rejects %s", (_label, options) => {
    const result = runPackageParity(options);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package parity verification failed/i);
  });
});

function fixturePath(fixture: string) {
  return resolve(process.cwd(), "tests", "fixtures", "release-notes", fixture);
}

function validateReleaseNotes(fixture: string, args: string[] = ["--version", "0.25.0"]) {
  return runReleaseNoteValidator(["--file", fixturePath(fixture), ...args]);
}

function runReleaseNoteValidator(args: string[]) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "validate-release-notes.mjs"), ...args], {
    encoding: "utf8"
  });
}

function renderReleaseNotes(args: string[] = ["--version", "0.25.0"]) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "render-release-notes.mjs"), ...args], {
    encoding: "utf8"
  });
}

function packagePath() {
  return resolve(process.cwd(), "package.json");
}

function validateReleaseVersion(args: string[] = ["--package", packagePath(), "--version", "0.25.0"]) {
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
    expect(result.stdout).toBe(readFileSync(fixturePath("canonical-v025.md"), "utf8"));
    expect(result.stdout).toMatch(/SPDX JSON.*Sigstore bundles/i);
    expect(result.stdout).toMatch(/change capsules derive only from local Git state/i);
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
    const result = validateReleaseNotes("canonical-v025.md");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["renderer", () => renderReleaseNotes([])],
    ["validator", () => validateReleaseNotes("canonical-v025.md", [])]
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
    const result = validateReleaseVersion(["--package", packagePath(), "--version", "0.24.0"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match release tag version 0.24.0");
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
