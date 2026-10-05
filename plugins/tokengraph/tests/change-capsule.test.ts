import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { indexProject } from "../src/core/projectIndexer.js";
import { assessChangeRisk } from "../src/core/regressionRisk.js";
import { analyzeInputSchema } from "../src/core/toolContracts.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

async function makeGitRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-change-capsule-"));
  temporaryRoots.push(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "TokenGraph test"]);
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("risk change-source contract", () => {
  it("accepts a local change source and rejects mixing it with caller-supplied paths", () => {
    for (const changeSource of [
      { kind: "working-tree" },
      { kind: "staged" },
      { kind: "commit", ref: "HEAD" },
      { kind: "range", base: "main", head: "feature" },
      { kind: "pull-request", baseRef: "main", headRef: "feature" }
    ]) {
      expect(analyzeInputSchema.safeParse({ mode: "risk", changeSource }).success).toBe(true);
    }

    expect(analyzeInputSchema.safeParse({
      mode: "risk",
      changedFiles: ["src/patient.ts"],
      changeSource: { kind: "working-tree" }
    }).success).toBe(false);
    expect(analyzeInputSchema.safeParse({ mode: "risk" }).success).toBe(false);
    expect(analyzeInputSchema.safeParse({ mode: "risk", changeSource: { kind: "commit", ref: "HEAD\0invalid" } }).success).toBe(false);
    for (const changeSource of [
      { kind: "working-tree", ref: "HEAD" },
      { kind: "commit" },
      { kind: "commit", ref: "HEAD", base: "main" },
      { kind: "range", base: "main" },
      { kind: "pull-request", base: "main", head: "feature" }
    ]) {
      expect(analyzeInputSchema.safeParse({ mode: "risk", changeSource }).success).toBe(false);
    }
  });
});

describe("local change capsule", () => {
  it("derives a commit capsule from local target blobs", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patient.ts"), [
      "export function patientName() {",
      "  return 'before';",
      "}",
      ""
    ].join("\n"));
    await writeFile(join(root, "src", "consumer.ts"), [
      "import { patientName } from './patient';",
      "export function renderPatient() {",
      "  return patientName();",
      "}",
      ""
    ].join("\n"));
    await commitAll(root, "base");

    await writeFile(join(root, "src", "patient.ts"), [
      "export function patientName() {",
      "  return 'after';",
      "}",
      "export const patientState = 'ready';",
      ""
    ].join("\n"));
    const targetCommit = await commitAll(root, "change patient");
    await writeFile(join(root, "src", "patient.ts"), "export function workingTreeOnly() { return 'working'; }\n");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: targetCommit },
      project,
      rules: [],
      memories: []
    });

    expect((report as typeof report & { changeCapsule?: unknown }).changeCapsule).toMatchObject({
      id: "capsule/change",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      content: {
        source: expect.objectContaining({ kind: "commit", targetCommit }),
        entries: [expect.objectContaining({ path: "src/patient.ts", status: "modified", provenance: "commit" })],
        symbols: expect.arrayContaining([expect.objectContaining({ filePath: "src/patient.ts", name: "patientName" })]),
        dependents: expect.arrayContaining([expect.objectContaining({ path: "src/consumer.ts" })]),
        slices: expect.arrayContaining([expect.objectContaining({ path: "src/patient.ts", text: expect.stringContaining("return 'after';"), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]),
        risks: expect.objectContaining({ riskScore: expect.any(Number), riskLevel: expect.any(String) }),
        recommendedTests: []
      }
    });
    expect((report.changeCapsule?.content.symbols ?? []).some((symbol) => symbol.name === "workingTreeOnly")).toBe(false);
  });

  it("keeps staged, unstaged, and untracked target content distinct in working-tree mode", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patient.ts"), "export function basePatient() { return 'base'; }\n");
    await commitAll(root, "base");

    await writeFile(join(root, "src", "patient.ts"), "export function stagedPatient() { return 'staged'; }\n");
    await git(root, ["add", "src/patient.ts"]);
    await writeFile(join(root, "src", "patient.ts"), "export function workingPatient() { return 'working'; }\n");
    await writeFile(join(root, "src", "new file.ts"), "export function untrackedPatient() { return 'new'; }\n");
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "src", "ignored.ts"), "export function ignoredPatient() { return 'ignored'; }\n");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "working-tree" },
      project,
      rules: [],
      memories: []
    });
    const capsule = report.changeCapsule!;

    expect(capsule.content.source).toMatchObject({ kind: "working-tree" });
    expect(capsule.content.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/patient.ts", provenance: "staged", status: "modified" }),
      expect.objectContaining({ path: "src/patient.ts", provenance: "unstaged", status: "modified" }),
      expect.objectContaining({ path: "src/new file.ts", provenance: "untracked", status: "added" })
    ]));
    expect(capsule.content.entries.some((entry) => entry.path === "src/ignored.ts")).toBe(false);
    expect(capsule.content.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "stagedPatient", changeProvenance: "staged" }),
      expect.objectContaining({ name: "workingPatient", changeProvenance: "unstaged" }),
      expect.objectContaining({ name: "untrackedPatient", changeProvenance: "untracked" })
    ]));
    expect(capsule.content.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/patient.ts", provenance: "staged", text: expect.stringContaining("stagedPatient") }),
      expect.objectContaining({ path: "src/patient.ts", provenance: "unstaged", text: expect.stringContaining("workingPatient") }),
      expect.objectContaining({ path: "src/new file.ts", provenance: "untracked", text: expect.stringContaining("untrackedPatient") })
    ]));
  });

  it("includes validated-index dependents, SQL objects, rules, risks, and recommended tests", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await mkdir(join(root, "src", "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "app", "patients", "page.tsx"), "import { patientSummary } from '../../src/services/patientService'; export default function Page() { return patientSummary(); }\n");
    await writeFile(join(root, "src", "services", "patientService.ts"), "export function patientSummary() { return []; }\n");
    await writeFile(join(root, "src", "services", "patientService.test.ts"), "import { patientSummary } from './patientService'; it('keeps patients scoped', () => patientSummary());\n");
    await writeFile(join(root, "supabase", "migrations", "001_patients.sql"), "create table public.patients (id uuid primary key);\n");
    await commitAll(root, "base");

    await writeFile(join(root, "src", "services", "patientService.ts"), "export function patientSummary() { return ['tenant']; }\n");
    await writeFile(join(root, "supabase", "migrations", "001_patients.sql"), [
      "create table public.patients (id uuid primary key, tenant_id uuid);",
      "create policy \"tenant patients\" on public.patients for select using (tenant_id = auth.uid());"
    ].join("\n"));
    const targetCommit = await commitAll(root, "risk target");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: targetCommit },
      project,
      rules: [{
        id: "rule_routes_services",
        type: "forbidden-import",
        name: "Routes cannot import services directly",
        fromPattern: "^app/",
        targetPattern: "^src/services/",
        enabled: true,
        severity: "warning",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z"
      }],
      memories: []
    });
    const capsule = report.changeCapsule!;

    expect(capsule.content.dependents).toEqual(expect.arrayContaining([expect.objectContaining({ path: "app/patients/page.tsx" })]));
    expect(capsule.content.sqlObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "table", name: "public.patients" }),
      expect.objectContaining({ kind: "policy", name: "tenant patients" })
    ]));
    expect(capsule.content.rules).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "rule_routes_services" })]));
    expect(capsule.content.risks).toMatchObject({ riskScore: expect.any(Number), riskLevel: expect.any(String), manualReviewWarnings: expect.any(Array) });
    expect(capsule.content.recommendedTests).toEqual(expect.arrayContaining(["pnpm test -- src/services/patientService.test.ts"]));
  });

  it("reads the staged index instead of a divergent working tree", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patient.ts"), "export function basePatient() { return 'base'; }\n");
    await commitAll(root, "base");

    await writeFile(join(root, "src", "patient.ts"), "export function stagedPatient() { return 'staged'; }\n");
    await git(root, ["add", "src/patient.ts"]);
    await writeFile(join(root, "src", "patient.ts"), "export function workingPatient() { return 'working'; }\n");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "staged" },
      project,
      rules: [],
      memories: []
    });
    const capsule = report.changeCapsule!;

    expect(capsule.content.entries).toEqual([expect.objectContaining({ path: "src/patient.ts", provenance: "staged", status: "modified" })]);
    expect(capsule.content.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "stagedPatient", changeProvenance: "staged" })]));
    expect(capsule.content.symbols.some((symbol) => symbol.name === "workingPatient")).toBe(false);
    expect(capsule.content.slices).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("stagedPatient"), provenance: "staged" })]));
  });

  it("derives an added root commit with normalized CRLF paths and slices", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "windows.ts"), "export function windowsPatient() {\r\n  return 'ready';\r\n}\r\n");
    const rootCommit = await commitAll(root, "root");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: rootCommit },
      project,
      rules: [],
      memories: []
    });
    const capsule = report.changeCapsule!;

    expect(capsule.content.entries).toEqual([expect.objectContaining({ path: "src/windows.ts", status: "added", provenance: "commit" })]);
    expect(capsule.content.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "windowsPatient", filePath: "src/windows.ts" })]));
    const slice = capsule.content.slices.find((candidate) => candidate.path === "src/windows.ts");
    expect(slice?.text).toContain("\n");
    expect(slice?.text).not.toContain("\r");
  });

  it("uses a unique local merge base for three-dot ranges and pull-request sources", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patient.ts"), "export function basePatient() { return 'base'; }\n");
    const mergeBase = await commitAll(root, "base");
    await git(root, ["branch", "feature"]);

    await writeFile(join(root, "src", "main-only.ts"), "export function mainOnly() { return 'main'; }\n");
    await commitAll(root, "main only");
    await git(root, ["switch", "feature"]);
    await writeFile(join(root, "src", "patient.ts"), "export function featurePatient() { return 'feature'; }\n");
    const featureCommit = await commitAll(root, "feature only");
    await writeFile(join(root, "src", "patient.ts"), "export function workingRangePatient() { return 'working'; }\n");
    const project = await indexProject(root);

    const range = await assessChangeRisk({
      root,
      changeSource: { kind: "range", base: "main", head: "feature" },
      project,
      rules: [],
      memories: []
    });
    const pullRequest = await assessChangeRisk({
      root,
      changeSource: { kind: "pull-request", baseRef: "main", headRef: "feature" },
      project,
      rules: [],
      memories: []
    });

    expect(range.changeCapsule!.content.source).toMatchObject({ kind: "range", mergeBase, targetCommit: featureCommit });
    expect(range.changeCapsule!.content.entries).toEqual([expect.objectContaining({ path: "src/patient.ts", status: "modified", provenance: "range" })]);
    expect(range.changeCapsule!.content.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "featurePatient", changeProvenance: "range" })]));
    expect(range.changeCapsule!.content.symbols.some((symbol) => symbol.name === "workingRangePatient")).toBe(false);
    expect(pullRequest.changeCapsule!.content.source).toMatchObject({ kind: "pull-request", mergeBase, targetCommit: featureCommit });
    expect(pullRequest.changeCapsule!.content.entries).toEqual([expect.objectContaining({ path: "src/patient.ts", status: "modified", provenance: "pull-request" })]);
    await expect(assessChangeRisk({
      root,
      changeSource: { kind: "range", base: "missing-local-ref", head: "feature" },
      project,
      rules: [],
      memories: []
    })).rejects.toThrow(/base ref is unavailable/i);
  });

  it("records rename, deletion, binary, and space-containing paths without reading binary target text", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "src", "rename me.ts"), "export function renamedPatient() { return 'before'; }\n");
    await writeFile(join(root, "src", "remove.ts"), "export function removePatient() { return 'remove'; }\n");
    await writeFile(join(root, "assets", "blob.bin"), Buffer.from([0x01, 0x02, 0x00, 0x03]));
    await commitAll(root, "base");

    await git(root, ["mv", "src/rename me.ts", "src/renamed file.ts"]);
    await rm(join(root, "src", "remove.ts"));
    await writeFile(join(root, "assets", "blob.bin"), Buffer.from([0x01, 0x04, 0x00, 0x05]));
    const targetCommit = await commitAll(root, "mixed changes");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: targetCommit },
      project,
      rules: [],
      memories: []
    });
    const capsule = report.changeCapsule!;

    expect(capsule.content.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/renamed file.ts", previousPath: "src/rename me.ts", status: "renamed" }),
      expect.objectContaining({ path: "src/remove.ts", status: "deleted", target: { status: "missing" } }),
      expect.objectContaining({ path: "assets/blob.bin", status: "modified", target: expect.objectContaining({ status: "binary" }) })
    ]));
    expect(capsule.content.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ filePath: "src/renamed file.ts", name: "renamedPatient" })]));
    expect(capsule.content.slices.some((slice) => slice.path === "assets/blob.bin")).toBe(false);
    expect(capsule.content.slices.some((slice) => slice.path === "src/remove.ts")).toBe(false);
  });

  it("treats Git-provided names as literal paths rather than pathspec patterns", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "literal[patient].ts"), "export const literalPatient = 'before';\n");
    await writeFile(join(root, "src", "literala.ts"), "export const otherPatient = 'unchanged';\n");
    await commitAll(root, "base");

    await writeFile(join(root, "src", "literal[patient].ts"), "export const literalPatient = 'after';\n");
    const targetCommit = await commitAll(root, "literal path target");
    const project = await indexProject(root);
    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: targetCommit },
      project,
      rules: [],
      memories: []
    });

    expect(report.changeCapsule!.content.entries).toEqual([
      expect.objectContaining({ path: "src/literal[patient].ts", target: expect.objectContaining({ status: "available" }) })
    ]);
    expect(report.changeCapsule!.content.slices).toEqual([
      expect.objectContaining({ path: "src/literal[patient].ts", text: expect.stringContaining("after") })
    ]);
  });

  it("refuses aggregate change slices beyond the capsule budget", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    const before = Array.from({ length: 600 }, (_, index) => `export const item${index} = ${index};`);
    await writeFile(join(root, "src", "many-hunks.ts"), before.join("\n") + "\n");
    await commitAll(root, "base");
    const after = before.map((line, index) => index % 2 === 0 ? `${line} // changed` : line);
    await writeFile(join(root, "src", "many-hunks.ts"), after.join("\n") + "\n");
    const targetCommit = await commitAll(root, "many hunks");
    const project = await indexProject(root);

    await expect(assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: targetCommit },
      project,
      rules: [],
      memories: []
    })).rejects.toThrow(/bounded capsule slice budget/i);
  });

  it("applies the existing exact-read source and slice limits to target blobs", async () => {
    const root = await makeGitRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "bounded.ts"), "export const before = true;\n");
    await commitAll(root, "base");

    await writeFile(join(root, "src", "bounded.ts"), Array.from({ length: 600 }, (_, index) => `export const item${index} = ${index};`).join("\n") + "\n");
    await writeFile(join(root, "src", "too-large.ts"), `export const tooLarge = '${"x".repeat(512 * 1024)}';\n`);
    const targetCommit = await commitAll(root, "bounded target");
    const project = await indexProject(root);

    const report = await assessChangeRisk({
      root,
      changeSource: { kind: "commit", ref: targetCommit },
      project,
      rules: [],
      memories: []
    });
    const capsule = report.changeCapsule!;
    const boundedSlices = capsule.content.slices.filter((slice) => slice.path === "src/bounded.ts");

    expect(boundedSlices).not.toEqual([]);
    expect(boundedSlices.every((slice) => slice.endLine - slice.startLine < 500 && Buffer.byteLength(slice.text, "utf8") <= 64 * 1024)).toBe(true);
    expect(boundedSlices.some((slice) => slice.truncated === true)).toBe(true);
    expect(capsule.content.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/too-large.ts", target: expect.objectContaining({ status: "too-large" }) })]));
    expect(capsule.content.slices.some((slice) => slice.path === "src/too-large.ts")).toBe(false);
    expect(capsule.content.symbols.some((symbol) => symbol.filePath === "src/too-large.ts")).toBe(false);
  });
});
