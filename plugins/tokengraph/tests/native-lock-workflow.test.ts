import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(process.cwd(), "../..", ".github/workflows/native-lock.yml");
const runnerPath = resolve(process.cwd(), "scripts/run-tests.mjs");
const cargoManifestPath = resolve(process.cwd(), "native/lock-addon/Cargo.toml");

function workflowText() {
  return readFileSync(workflowPath, "utf8");
}

function matrixEntries(workflow: string) {
  return Array.from(workflow.matchAll(
    /^\s+- runner: ([^\s]+)\r?\n\s+target: ([^\s]+)\r?\n\s+id: ([^\s]+)\r?\n\s+file: ([^\s]+)$/gmu
  ), ([, runner, target, id, file]) => ({ runner, target, id, file }));
}

describe("native lock six-target workflow", () => {
  it("pins the exact native matrix and trusted bootstrap boundary", () => {
    const workflow = workflowText();

    expect(workflow).toMatch(/^permissions:\r?\n  contents: read$/mu);
    expect(workflow).toContain("push:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("assemble:");
    expect(workflow).toContain("github.repository == 'Mujadarah/TokenGraph'");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("inputs.assemble == true");
    expect(workflow.match(/startsWith\(github\.ref, 'refs\/heads\/'\)/gu)).toHaveLength(2);
    expect(workflow.match(/github\.run_attempt == 1/gu)).toHaveLength(2);

    expect(matrixEntries(workflow)).toEqual([
      { runner: "windows-2025", target: "x86_64-pc-windows-msvc", id: "win32-x64", file: "tokengraph-lock.win32-x64.node" },
      { runner: "windows-11-arm", target: "aarch64-pc-windows-msvc", id: "win32-arm64", file: "tokengraph-lock.win32-arm64.node" },
      { runner: "ubuntu-24.04", target: "x86_64-unknown-linux-gnu", id: "linux-x64-gnu", file: "tokengraph-lock.linux-x64.node" },
      { runner: "ubuntu-24.04-arm", target: "aarch64-unknown-linux-gnu", id: "linux-arm64-gnu", file: "tokengraph-lock.linux-arm64.node" },
      { runner: "macos-15-intel", target: "x86_64-apple-darwin", id: "darwin-x64", file: "tokengraph-lock.darwin-x64.node" },
      { runner: "macos-15", target: "aarch64-apple-darwin", id: "darwin-arm64", file: "tokengraph-lock.darwin-arm64.node" }
    ]);
  });

  it("uses immutable tools and the pinned Linux ABI-floor image", () => {
    const workflow = workflowText();
    const approvedActions = new Map([
      ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
      ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
      ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
      ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"]
    ]);

    expect(workflow).not.toMatch(/uses:\s+\S+@v\d+/u);
    const references = Array.from(workflow.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/gu));
    expect(new Set(references.map(([, action]) => action))).toEqual(new Set(approvedActions.keys()));
    for (const [, action, revision] of references) expect(revision).toBe(approvedActions.get(action));
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("1.97.1");
    expect(workflow).toContain("pnpm@10.14.0");
    expect(workflow).toMatch(/registry\.access\.redhat\.com\/ubi8\/ubi@sha256:[0-9a-f]{64}/u);
    expect(workflow).not.toMatch(/registry\.access\.redhat\.com\/ubi8\/ubi:[^\s]+/u);
    expect(workflow).toContain("--env CARGO_HOME=/tmp/tokengraph-cargo");
    expect(workflow).toContain('--volume "$HOME/.cargo/bin:/opt/cargo:ro"');
    expect(workflow).not.toContain('--volume "$HOME/.cargo:/root/.cargo"');
  });

  it("tests each built target before uploading an exact confined artifact", () => {
    const workflow = workflowText();
    const cargoManifest = readFileSync(cargoManifestPath, "utf8");
    const build = workflow.indexOf("pnpm native:build -- --target");
    const cargoTest = workflow.indexOf("cargo test --locked --features test-host --manifest-path native/lock-addon/Cargo.toml");
    const load = workflow.indexOf("pnpm vitest run tests/native-lock-addon.test.ts tests/native-lock-packaging.test.ts");
    const recovery = workflow.indexOf("tests/storage-lock-process.test.ts");
    const receipt = workflow.indexOf("build-receipt.json");
    const upload = workflow.indexOf("actions/upload-artifact@");

    expect(build).toBeGreaterThan(-1);
    expect(cargoTest).toBeGreaterThan(build);
    expect(load).toBeGreaterThan(cargoTest);
    expect(recovery).toBeGreaterThan(load);
    expect(receipt).toBeGreaterThan(recovery);
    expect(upload).toBeGreaterThan(receipt);
    expect(workflow).toContain("tests/native-lock-packaging.test.ts");
    expect(workflow).toContain("tests/native-lock-addon.test.ts");
    expect(workflow).toContain("cargo test --locked --features test-host --manifest-path native/lock-addon/Cargo.toml");
    expect(cargoManifest).toMatch(/^test-host = \["napi\/dyn-symbols"\]$/mu);
    expect(cargoManifest).not.toMatch(/^default\s*=/mu);
    expect(workflow).toContain("--reporter=verbose");
    expect(workflow).toContain("TOKENGRAPH_NATIVE_EXHAUSTIVE_RECOVERY: \"1\"");
    expect(workflow).toContain("retention-days: 1");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("include-hidden-files: false");
    expect(workflow).toContain("path: |");
    expect(workflow).toContain("native-output/${{ matrix.id }}/${{ matrix.file }}");
    expect(workflow).toContain("native-output/${{ matrix.id }}/build-receipt.json");
    expect(workflow).not.toMatch(/path:\s+(?:\.\.\/|\/|[A-Za-z]:\\)/u);
  });

  it("binds the process suite to the exact built asset without a production loader seam", () => {
    const runner = readFileSync(runnerPath, "utf8");
    const override = runner.slice(
      runner.indexOf("async function readCurrentAssetOverride"),
      runner.indexOf("async function assembleHarness")
    );

    expect(override).toContain("TOKENGRAPH_NATIVE_CURRENT_ASSET");
    expect(override).toContain("native-output");
    expect(override).toContain("assets/native-lock");
    expect(override).toMatch(/isSymbolicLink\(\)|nlink !== 1n/u);
    expect(override).toContain("identityOf(await handle.stat");
    expect(override).toContain("identityOf(await lstat");
    expect(override).toContain("realpath");
    expect(override).toContain("O_NOFOLLOW");
    expect(runner).not.toMatch(/src[\\/]core[\\/]nativeLockProvider[\s\S]*TOKENGRAPH_NATIVE_CURRENT_ASSET/u);
  });

  it("assembles only six verified receipts from the same immutable commit", () => {
    const workflow = workflowText();
    const assembleJob = workflow.indexOf("assemble-native-assets:");

    expect(assembleJob).toBeGreaterThan(-1);
    expect(workflow.slice(assembleJob)).toContain("actions/download-artifact@");
    expect(workflow.slice(assembleJob)).toContain("github.sha");
    expect(workflow.slice(assembleJob)).toContain("receipt.commit");
    expect(workflow.slice(assembleJob)).toContain("receipt.workflowRunId");
    expect(workflow.slice(assembleJob)).toContain("receipt.workflowRunAttempt");
    expect(workflow.slice(assembleJob)).toContain("receipt.runnerArch");
    expect(workflow.slice(assembleJob)).toContain("receipt.target");
    expect(workflow.slice(assembleJob)).toContain("receipt.sha256");
    expect(workflow.slice(assembleJob)).toContain("receipt.bytes");
    expect(workflow.slice(assembleJob)).toContain("expectedTargets");
    expect(workflow.slice(assembleJob)).toContain("expectedTargets.size !== 6");
    expect(workflow.slice(assembleJob)).toContain("EXPECTED_RUN_ID");
    expect(workflow.slice(assembleJob)).toContain("EXPECTED_RUN_ATTEMPT");
    expect(workflow).toContain('"RUNNER_ARCH"');
    expect(workflow.slice(assembleJob)).toContain("assembled-native-lock");
  });
});
