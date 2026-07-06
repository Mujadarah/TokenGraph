import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compressOutput } from "../src/core/compressor.js";
import { scanProject } from "../src/core/fileScanner.js";
import { MemoryStore } from "../src/core/memoryStore.js";
import { buildContextPlan } from "../src/core/planner.js";
import { clearProjectIndex, indexPath, memoryPath, saveProjectIndex } from "../src/core/persistence.js";
import { indexProject } from "../src/core/projectIndexer.js";
import { getIndexStatus } from "../src/core/indexStatus.js";
import { parsePostgresMigration } from "../src/core/sqlParser.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scanProject", () => {
  it("extracts compact TypeScript graph data and excludes secrets and dependency output", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "patients", "[id]"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, ".env"), "SECRET=value");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "export const ignored = true;");
    await writeFile(
      join(root, "app", "patients", "[id]", "page.tsx"),
      [
        "import { getPatient } from '@/services/patientService';",
        "export default function PatientPage() {",
        "  return <main>Patient</main>;",
        "}"
      ].join("\n")
    );
    await writeFile(
      join(root, "app", "patients", "page.test.ts"),
      "import { describe, it } from 'vitest'; it('renders patients', () => {});"
    );

    const graph = await scanProject(root);

    expect(graph.files.map((file) => file.path)).toEqual([
      "app/patients/[id]/page.tsx",
      "app/patients/page.test.ts"
    ]);
    expect(graph.files[0]).toMatchObject({
      kind: "next-route",
      route: "/patients/[id]",
      isTest: false
    });
    expect(graph.symbols).toContainEqual(
      expect.objectContaining({ name: "PatientPage", kind: "component", filePath: "app/patients/[id]/page.tsx" })
    );
    expect(graph.imports).toContainEqual(
      expect.objectContaining({ source: "@/services/patientService", filePath: "app/patients/[id]/page.tsx" })
    );
    expect(graph.exclusions.some((entry) => entry.path === ".env" && entry.reason === "secret")).toBe(true);
  });

  it("resolves local imports and extracts React and Next.js route metadata", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "components"), { recursive: true });
    await mkdir(join(root, "lib"), { recursive: true });
    await mkdir(join(root, "pages", "patients"), { recursive: true });
    await writeFile(
      join(root, "components", "PatientCard.tsx"),
      [
        "export const PatientCard = () => {",
        "  return <article>Patient</article>;",
        "};"
      ].join("\n")
    );
    await writeFile(join(root, "lib", "patients.ts"), "export function loadPatient() { return null; }");
    await writeFile(
      join(root, "pages", "patients", "[id].tsx"),
      [
        "import { PatientCard } from '@/components/PatientCard';",
        "import { loadPatient } from '../../lib/patients';",
        "export default function PatientPage() {",
        "  return <PatientCard />;",
        "}"
      ].join("\n")
    );

    const graph = await scanProject(root);

    expect(graph.files).toContainEqual(
      expect.objectContaining({
        path: "pages/patients/[id].tsx",
        kind: "next-route",
        route: "/patients/[id]"
      })
    );
    expect(graph.symbols).toContainEqual(
      expect.objectContaining({
        name: "PatientCard",
        kind: "component",
        filePath: "components/PatientCard.tsx",
        startLine: 1,
        endLine: 3
      })
    );
    expect(graph.imports).toContainEqual(
      expect.objectContaining({
        filePath: "pages/patients/[id].tsx",
        source: "@/components/PatientCard",
        resolvedPath: "components/PatientCard.tsx"
      })
    );
    expect(graph.imports).toContainEqual(
      expect.objectContaining({
        filePath: "pages/patients/[id].tsx",
        source: "../../lib/patients",
        resolvedPath: "lib/patients.ts"
      })
    );
  });

  it("resolves TypeScript source files imported with emitted JavaScript specifiers", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "server.ts"), "export function createServer() { return null; }");
    await writeFile(
      join(root, "src", "index.ts"),
      [
        "import { createServer } from './server.js';",
        "export function start() {",
        "  return createServer();",
        "}"
      ].join("\n")
    );

    const graph = await scanProject(root);

    expect(graph.imports).toContainEqual(
      expect.objectContaining({
        filePath: "src/index.ts",
        source: "./server.js",
        resolvedPath: "src/server.ts"
      })
    );
  });

  it("does not classify TypeScript generics as React components", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "repository.ts"),
      [
        "export async function loadRows<TRecord>(): Promise<TRecord[]> {",
        "  return [];",
        "}"
      ].join("\n")
    );

    const graph = await scanProject(root);

    expect(graph.files).toContainEqual(
      expect.objectContaining({
        path: "src/repository.ts",
        kind: "module"
      })
    );
  });

  it("respects root .gitignore patterns before indexing files", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "generated"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, "generated", "client.ts"), "export const generatedClient = true;");
    await writeFile(join(root, "src", "real.ts"), "export const realModule = true;");

    const graph = await scanProject(root);

    expect(graph.files.map((file) => file.path)).toEqual(["src/real.ts"]);
    expect(graph.exclusions).toContainEqual(expect.objectContaining({ path: "generated", reason: "ignored" }));
  });
});

describe("parsePostgresMigration", () => {
  it("extracts tables, columns, relations, policies, indexes, triggers, functions, and views", () => {
    const sql = `
      create table public.patients (
        id uuid primary key,
        tenant_id uuid references public.tenants(id),
        full_name text not null
      );
      create policy "tenant can read patients" on public.patients for select using (tenant_id = auth.uid());
      create index patients_tenant_idx on public.patients(tenant_id);
      create function public.touch_patient() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger patients_touch before update on public.patients for each row execute function public.touch_patient();
      create view public.patient_summary as select id, full_name from public.patients;
    `;

    const graph = parsePostgresMigration("supabase/migrations/001_patients.sql", sql);

    expect(graph.tables).toContainEqual(
      expect.objectContaining({
        name: "public.patients",
        columns: expect.arrayContaining(["id", "tenant_id", "full_name"])
      })
    );
    expect(graph.relations).toContainEqual(
      expect.objectContaining({ fromTable: "public.patients", fromColumn: "tenant_id", toTable: "public.tenants" })
    );
    expect(graph.policies).toContainEqual(expect.objectContaining({ table: "public.patients" }));
    expect(graph.indexes).toContainEqual(expect.objectContaining({ name: "patients_tenant_idx" }));
    expect(graph.functions).toContainEqual(expect.objectContaining({ name: "public.touch_patient" }));
    expect(graph.triggers).toContainEqual(expect.objectContaining({ name: "patients_touch", table: "public.patients" }));
    expect(graph.views).toContainEqual(expect.objectContaining({ name: "public.patient_summary" }));
  });
});

describe("indexProject", () => {
  it("records a deterministic fingerprint that changes when indexed source changes", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'old';");

    const first = await indexProject(root);
    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'new';");
    const second = await indexProject(root);

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(new Date(second.scannedAt).toISOString()).toBe(second.scannedAt);
  });
});

describe("index status and reset", () => {
  it("reports missing, fresh, and stale index states", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'old';");

    await expect(getIndexStatus(root)).resolves.toMatchObject({ state: "missing", hasIndex: false });

    const project = await indexProject(root);
    await saveProjectIndex(root, project);
    await expect(getIndexStatus(root)).resolves.toMatchObject({
      state: "fresh",
      hasIndex: true,
      storedFingerprint: project.fingerprint,
      currentFingerprint: project.fingerprint
    });

    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'new';");
    await expect(getIndexStatus(root)).resolves.toMatchObject({
      state: "stale",
      hasIndex: true,
      storedFingerprint: project.fingerprint
    });
  });

  it("clears the project index without deleting stored memories", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'old';");
    await saveProjectIndex(root, await indexProject(root));
    await new MemoryStore(memoryPath(root)).add({
      type: "convention",
      title: "Keep index reset narrow",
      body: "Index resets should preserve project memories by default.",
      tags: ["reset", "memory"]
    });

    await clearProjectIndex(root);

    await expect(access(indexPath(root))).rejects.toThrow();
    await expect(access(memoryPath(root))).resolves.toBeUndefined();
  });
});

describe("buildContextPlan", () => {
  it("returns a compact patch scope that connects task terms, memories, files, tests, and SQL", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "patients", "[id]"), { recursive: true });
    await mkdir(join(root, "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "app", "patients", "[id]", "page.tsx"), "export default function PatientSummary() { return null; }");
    await writeFile(join(root, "services", "patientService.ts"), "export async function getPatientSummary() { return {}; }");
    await writeFile(join(root, "services", "patientService.test.ts"), "test('patient summary', () => {});");
    await writeFile(join(root, "supabase", "migrations", "001_patients.sql"), "create table public.patients (id uuid primary key, full_name text);");

    const project = await indexProject(root);
    const memory = new MemoryStore(join(root, ".tokengraph", "memory.json"));
    await memory.add({
      type: "architecture",
      title: "Patient summaries stay tenant scoped",
      body: "Patient summary work must check tenant scoping and related RLS policies.",
      tags: ["patients", "rls", "summary"]
    });

    const plan = await buildContextPlan({
      root,
      task: "Add the patient summary field to the patient page",
      project,
      memories: await memory.search("patient summary tenant"),
      budget: { maxFiles: 4, maxSqlObjects: 4, maxMemories: 3 }
    });

    expect(plan.taskType).toBe("feature");
    expect(plan.recommendedFirstReads.map((item) => item.path)).toContain("app/patients/[id]/page.tsx");
    expect(plan.relevantFiles.map((item) => item.path)).toContain("services/patientService.ts");
    expect(plan.relevantTests.map((item) => item.path)).toContain("services/patientService.test.ts");
    expect(plan.relevantSql.map((item) => item.name)).toContain("public.patients");
    expect(plan.relevantMemories.map((item) => item.title)).toContain("Patient summaries stay tenant scoped");
    expect(plan.estimatedTokens.avoided).toBeGreaterThan(0);
    expect(plan.rawReadPolicy).toMatch(/targeted/i);
  });

  it("ranks memories by task relevance and adds line hints to first reads", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    await writeFile(
      join(root, "services", "patientSummary.ts"),
      [
        "export function loadPatientSummary() {",
        "  return null;",
        "}"
      ].join("\n")
    );

    const project = await indexProject(root);
    const memories = [
      {
        id: "mem_old",
        createdAt: "2026-07-06T00:00:00.000Z",
        type: "convention" as const,
        title: "Billing export naming",
        body: "Billing reports use export suffixes.",
        tags: ["billing"]
      },
      {
        id: "mem_patient",
        createdAt: "2026-07-06T00:01:00.000Z",
        type: "architecture" as const,
        title: "Patient summary scope",
        body: "Patient summary loading must stay tenant scoped.",
        tags: ["patients", "summary"]
      }
    ];

    const plan = await buildContextPlan({
      root,
      task: "Fix patient summary loading",
      project,
      memories,
      budget: { maxFiles: 3, maxSqlObjects: 0, maxMemories: 1 }
    });

    expect(plan.relevantMemories).toHaveLength(1);
    expect(plan.relevantMemories[0].id).toBe("mem_patient");
    expect(plan.recommendedFirstReads).toContainEqual(
      expect.objectContaining({
        path: "services/patientSummary.ts",
        startLine: 1,
        endLine: 3
      })
    );
  });

  it("does not rank unrelated routes when task terms only match other files", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "billing"), { recursive: true });
    await mkdir(join(root, "services"), { recursive: true });
    await writeFile(join(root, "app", "billing", "page.tsx"), "export default function BillingPage() { return null; }");
    await writeFile(join(root, "services", "patientSummary.ts"), "export function loadPatientSummary() { return null; }");

    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root,
      task: "Fix patient summary loading",
      project,
      memories: [],
      budget: { maxFiles: 5, maxSqlObjects: 0, maxMemories: 0 }
    });

    expect(plan.relevantFiles.map((item) => item.path)).toContain("services/patientSummary.ts");
    expect(plan.relevantFiles.map((item) => item.path)).not.toContain("app/billing/page.tsx");
  });
});

describe("compressOutput", () => {
  it("keeps actionable test failure details and reports token savings", () => {
    const noisyLog = [
      "PASS services/account.test.ts",
      "stdout repeated setup line",
      "stdout repeated setup line",
      "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
      "AssertionError: expected 2 to be 1",
      "    at services/patientService.test.ts:42:15",
      "npm notice funding available",
      "webpack compiled with warnings"
    ].join("\n");

    const compressed = compressOutput({ kind: "test", text: noisyLog, maxLines: 5 });

    expect(compressed.summary).toContain("patientService.test.ts");
    expect(compressed.keyLines).toContain("AssertionError: expected 2 to be 1");
    expect(compressed.keyLines).toContain("at services/patientService.test.ts:42:15");
    expect(compressed.estimatedTokens.avoided).toBeGreaterThan(0);
  });
});

describe("MemoryStore", () => {
  it("persists searchable project decisions locally", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "memory.json");
    const store = new MemoryStore(storePath);

    await store.add({
      type: "convention",
      title: "Use server actions for patient mutations",
      body: "Patient writes should stay in server actions and shared services.",
      tags: ["patients", "server-actions"]
    });

    const loaded = new MemoryStore(storePath);
    const result = await loaded.search("patient server action");
    const raw = JSON.parse(await readFile(storePath, "utf8"));

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Use server actions for patient mutations");
    expect(raw[0]).toMatchObject({ type: "convention", title: "Use server actions for patient mutations" });
  });
});
