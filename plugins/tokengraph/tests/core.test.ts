import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compressOutput } from "../src/core/compressor.js";
import {
  DEFAULT_TOKEN_GRAPH_CONFIG,
  PROFILE_DEFAULTS,
  loadTokenGraphConfig,
  setTokenSavingProfile,
  updateTokenGraphConfig
} from "../src/core/config.js";
import { scanProject } from "../src/core/fileScanner.js";
import { MemoryStore } from "../src/core/memoryStore.js";
import { buildContextPlan } from "../src/core/planner.js";
import {
  clearProjectIndex,
  clearProjectState,
  configPath,
  getWikiStatus,
  indexPath,
  loadProjectIndex,
  loadProjectWiki,
  memoryPath,
  saveProjectIndex,
  saveProjectWiki,
  wikiDir
} from "../src/core/persistence.js";
import { CURRENT_INDEX_SCHEMA_VERSION, indexProject, updateProjectIndexIncremental } from "../src/core/projectIndexer.js";
import { getIndexStatus } from "../src/core/indexStatus.js";
import { parsePostgresMigration } from "../src/core/sqlParser.js";
import { exportProjectMap, reviewMemories } from "../src/core/review.js";
import { estimateTokens, tokenize } from "../src/core/token.js";
import { buildProjectWiki } from "../src/core/wiki.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin configuration", () => {
  it("uses Codex plugin MCP server shape", async () => {
    const mcp = JSON.parse(await readFile(".mcp.json", "utf8")) as {
      mcpServers?: {
        tokengraph?: { command?: string; args?: string[]; cwd?: string };
      };
    };

    expect(mcp.mcpServers?.tokengraph).toMatchObject({
      command: "node",
      args: ["./dist/index.js"],
      cwd: "."
    });
  });
});

describe("TokenGraph local config", () => {
  it("creates balanced defaults when no config file exists", async () => {
    const root = await makeRoot();

    const config = await loadTokenGraphConfig(root);

    expect(config).toEqual(DEFAULT_TOKEN_GRAPH_CONFIG);
    expect(config).toMatchObject({
      tokenSavingProfile: "balanced",
      maxFiles: 6,
      maxSqlObjects: 6,
      maxMemories: 4,
      maxPlannedContextTokens: 8000,
      rawReadWarningThreshold: 8000,
      sqlIndexingEnabled: true,
      memoryEnabled: true,
      wikiGenerationEnabled: false
    });
    expect(JSON.parse(await readFile(configPath(root), "utf8"))).toEqual(DEFAULT_TOKEN_GRAPH_CONFIG);
  });

  it("updates profile and explicit settings while preserving unspecified defaults", async () => {
    const root = await makeRoot();

    const profiled = await setTokenSavingProfile(root, "aggressive");
    const updated = await updateTokenGraphConfig(root, {
      maxFiles: 8,
      maxPlannedContextTokens: 6400,
      sqlIndexingEnabled: false
    });

    expect(profiled.tokenSavingProfile).toBe("aggressive");
    expect(updated).toMatchObject({
      tokenSavingProfile: "aggressive",
      maxFiles: 8,
      maxSqlObjects: DEFAULT_TOKEN_GRAPH_CONFIG.maxSqlObjects,
      maxMemories: DEFAULT_TOKEN_GRAPH_CONFIG.maxMemories,
      maxPlannedContextTokens: 6400,
      sqlIndexingEnabled: false,
      memoryEnabled: true
    });
  });
});

describe("scanProject", () => {
  it("indexes the Next.js Supabase fixture as a reusable regression project", async () => {
    const root = resolve("tests", "fixtures", "next-supabase");

    const graph = await scanProject(root);

    expect(graph.files.map((file) => file.path)).toEqual([
      "app/patients/[id]/page.tsx",
      "components/PatientCard.tsx",
      "services/patientService.test.ts",
      "services/patientService.ts",
      "supabase/migrations/001_patients.sql"
    ]);
    expect(graph.files).toContainEqual(
      expect.objectContaining({
        path: "app/patients/[id]/page.tsx",
        kind: "next-route",
        route: "/patients/[id]"
      })
    );
    expect(graph.imports).toContainEqual(
      expect.objectContaining({
        filePath: "app/patients/[id]/page.tsx",
        source: "@/components/PatientCard",
        resolvedPath: "components/PatientCard.tsx"
      })
    );
  });

  it("keeps fixture-generated output out of scanner regression projects", async () => {
    const root = await makeRoot();
    await cp(resolve("tests", "fixtures", "ignored-output"), root, { recursive: true });
    await mkdir(join(root, "coverage"), { recursive: true });
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "coverage", "report.json"), "{}");
    await writeFile(join(root, "generated", "client.ts"), "export const generated = true;");

    const graph = await scanProject(root);

    expect(graph.files.map((file) => file.path)).toEqual(["src/real.ts"]);
    expect(graph.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "coverage", reason: "ignored" }),
        expect.objectContaining({ path: "generated", reason: "ignored" })
      ])
    );
  });

  it("does not classify similarly named directories as tests", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src", "contests"), { recursive: true });
    await mkdir(join(root, "src", "latests"), { recursive: true });
    await writeFile(join(root, "src", "contests", "rules.ts"), "export const contestRules = true;");
    await writeFile(join(root, "src", "latests", "news.ts"), "export const latestNews = true;");

    const graph = await scanProject(root);

    expect(graph.files).toContainEqual(expect.objectContaining({ path: "src/contests/rules.ts", kind: "module", isTest: false }));
    expect(graph.files).toContainEqual(expect.objectContaining({ path: "src/latests/news.ts", kind: "module", isTest: false }));
  });

  it("does not classify JavaScript usage strings as React components", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "smoke.mjs"), "console.log('Usage: smoke --root <project-root>');");

    const graph = await scanProject(root);

    expect(graph.files).toContainEqual(expect.objectContaining({ path: "scripts/smoke.mjs", kind: "module" }));
  });

  it("extracts async function exports and ignores import-looking strings", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "real.ts"), "export const real = true;");
    await writeFile(
      join(root, "src", "service.ts"),
      [
        "const prompt = 'we import nothing here';",
        "const sql = `select * from users`;",
        "import { real } from './real';",
        "export async function fetchPatient() {",
        "  return real;",
        "}"
      ].join("\n")
    );

    const graph = await scanProject(root);

    expect(graph.imports).toContainEqual(expect.objectContaining({ filePath: "src/service.ts", source: "./real", resolvedPath: "src/real.ts" }));
    expect(graph.imports).not.toContainEqual(expect.objectContaining({ filePath: "src/service.ts", source: "users" }));
    expect(graph.symbols).toContainEqual(expect.objectContaining({ filePath: "src/service.ts", name: "fetchPatient", exported: true }));
  });

  it("does not truncate declarations when braces appear in strings", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "braceString.ts"),
      [
        "export function formatBrace() {",
        "  const text = '}';",
        "  return text;",
        "}"
      ].join("\n")
    );

    const graph = await scanProject(root);

    expect(graph.symbols).toContainEqual(
      expect.objectContaining({ filePath: "src/braceString.ts", name: "formatBrace", startLine: 1, endLine: 4 })
    );
  });

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

  it("stops indexing once the configured file budget is reached", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = true;");
    await writeFile(join(root, "src", "b.ts"), "export const b = true;");
    await writeFile(join(root, "src", "c.ts"), "export const c = true;");

    const graph = await scanProject(root, { maxFiles: 2 });

    expect(graph.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(graph.exclusions).toContainEqual(expect.objectContaining({ path: "src/c.ts", reason: "budget" }));
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

  it("extracts v0.5 PostgreSQL objects and constraint metadata", () => {
    const sql = `
      create extension if not exists "uuid-ossp";
      create type public.patient_status as enum ('active', 'archived');
      create table public.patients (
        id uuid constraint patients_pk primary key,
        tenant_id uuid,
        status public.patient_status not null,
        full_name text not null,
        constraint patients_tenant_name_unique unique (tenant_id, full_name),
        constraint patients_tenant_fk foreign key (tenant_id) references public.tenants(id),
        constraint patients_status_check check (status in ('active', 'archived'))
      );
      alter table public.patients add constraint patients_name_check check (length(full_name) > 0);
      create materialized view public.patient_rollups as select tenant_id, count(*) from public.patients group by tenant_id;
      grant select, insert on table public.patients to authenticated;
    `;

    const graph = parsePostgresMigration("supabase/migrations/001_patient_depth.sql", sql);

    expect((graph as any).extensions).toContainEqual(expect.objectContaining({ name: "uuid-ossp" }));
    expect((graph as any).enums).toContainEqual(
      expect.objectContaining({ name: "public.patient_status", values: ["active", "archived"] })
    );
    expect((graph as any).constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "patients_pk", table: "public.patients", kind: "primary key", columns: ["id"] }),
        expect.objectContaining({
          name: "patients_tenant_name_unique",
          table: "public.patients",
          kind: "unique",
          columns: ["tenant_id", "full_name"]
        }),
        expect.objectContaining({ name: "patients_tenant_fk", table: "public.patients", kind: "foreign key" }),
        expect.objectContaining({ name: "patients_name_check", table: "public.patients", kind: "check" })
      ])
    );
    expect((graph as any).materializedViews).toContainEqual(expect.objectContaining({ name: "public.patient_rollups" }));
    expect((graph as any).grants).toContainEqual(
      expect.objectContaining({
        privileges: ["select", "insert"],
        objectType: "table",
        objectName: "public.patients",
        grantee: "authenticated"
      })
    );
    expect(graph.relations).toContainEqual(
      expect.objectContaining({ fromTable: "public.patients", fromColumn: "tenant_id", toTable: "public.tenants", toColumn: "id" })
    );
  });

  it("extracts Supabase RLS policy roles and expressions", () => {
    const sql = `
      create policy "tenant can mutate patients"
      on public.patients
      for update
      to authenticated
      using ((tenant_id = auth.uid()) and archived_at is null)
      with check ((tenant_id = auth.uid()) and full_name <> '');
    `;

    const graph = parsePostgresMigration("supabase/migrations/002_patient_rls.sql", sql);

    expect(graph.policies).toContainEqual(
      expect.objectContaining({
        name: "tenant can mutate patients",
        table: "public.patients",
        command: "update",
        roles: ["authenticated"],
        usingExpression: "(tenant_id = auth.uid()) and archived_at is null",
        checkExpression: "(tenant_id = auth.uid()) and full_name <> ''"
      })
    );
  });

  it("resolves Next.js src-layout aliases", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src", "components"), { recursive: true });
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "src", "components", "PatientCard.tsx"), "export function PatientCard() { return <article />; }");
    await writeFile(join(root, "src", "app", "page.tsx"), "import { PatientCard } from '@/components/PatientCard'; export default PatientCard;");

    const graph = await scanProject(root);

    expect(graph.imports).toContainEqual(
      expect.objectContaining({
        filePath: "src/app/page.tsx",
        source: "@/components/PatientCard",
        resolvedPath: "src/components/PatientCard.tsx"
      })
    );
  });

  it("ignores commented SQL and function bodies while parsing top-level SQL objects", () => {
    const sql = `
      -- create table public.commented_out (id uuid);
      /*
        create policy "ghost" on public.patients for select using (true);
      */
      create function public.audit_grants() returns trigger language plpgsql as $$
      begin
        grant select on table public.hidden to hidden_role;
        return new;
      end
      $$;
      create table public.real_table (id uuid primary key);
    `;

    const graph = parsePostgresMigration("supabase/migrations/001_noise.sql", sql);

    expect(graph.tables.map((table) => table.name)).toEqual(["public.real_table"]);
    expect(graph.policies).toEqual([]);
    expect(graph.grants).toEqual([]);
  });

  it("records unnamed table-level foreign keys as relations", () => {
    const sql = `
      create table public.child (
        id uuid primary key,
        parent_id uuid,
        foreign key (parent_id) references public.parent(id)
      );
    `;

    const graph = parsePostgresMigration("supabase/migrations/001_fk.sql", sql);

    expect(graph.relations).toContainEqual(
      expect.objectContaining({ fromTable: "public.child", fromColumn: "parent_id", toTable: "public.parent", toColumn: "id" })
    );
  });

  it("parses execute procedure triggers and Supabase grant variants", () => {
    const sql = `
      create trigger patients_touch before update on public.patients for each row execute procedure public.touch_patient();
      grant select on all tables in schema public to anon, authenticated;
    `;

    const graph = parsePostgresMigration("supabase/migrations/001_grants.sql", sql);

    expect(graph.triggers).toContainEqual(
      expect.objectContaining({ name: "patients_touch", table: "public.patients", functionName: "public.touch_patient" })
    );
    expect(graph.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ privileges: ["select"], objectType: "all tables in schema", objectName: "public", grantee: "anon" }),
        expect.objectContaining({ privileges: ["select"], objectType: "all tables in schema", objectName: "public", grantee: "authenticated" })
      ])
    );
  });

  it("orders SQL history by statement position within a file", () => {
    const sql = `
      create table public.a (id uuid primary key);
      create index a_id_idx on public.a(id);
      create table public.b (id uuid primary key);
    `;

    const graph = parsePostgresMigration("supabase/migrations/001_order.sql", sql);

    expect(graph.history.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "table:public.a",
      "index:a_id_idx",
      "table:public.b"
    ]);
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

    expect(first.schemaVersion).toBe(CURRENT_INDEX_SCHEMA_VERSION);
    expect(first.scanMetadata?.files["src/patientSummary.ts"]).toMatchObject({ path: "src/patientSummary.ts" });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(new Date(second.scannedAt).toISOString()).toBe(second.scannedAt);
  });

  it("records ordered SQL object history across migration files", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase", "migrations", "002_policy.sql"),
      `create policy "tenant can read patients" on public.patients for select using (tenant_id = auth.uid());`
    );
    await writeFile(
      join(root, "supabase", "migrations", "001_patients.sql"),
      `create table public.patients (id uuid primary key, tenant_id uuid);`
    );

    const project = await indexProject(root);

    expect((project.sql as any).history).toEqual([
      expect.objectContaining({ filePath: "supabase/migrations/001_patients.sql", kind: "table", name: "public.patients", action: "create" }),
      expect.objectContaining({
        filePath: "supabase/migrations/002_policy.sql",
        kind: "policy",
        name: "tenant can read patients",
        action: "create"
      })
    ]);
  });

  it("updates only changed TypeScript files during incremental indexing", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummaryOld() { return 'old'; }");
    await writeFile(join(root, "src", "billing.ts"), "export function billingExport() { return true; }");

    const first = await indexProject(root);
    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummaryNew() { return 'new'; }");

    const result = await updateProjectIndexIncremental(root, first);

    expect(result.mode).toBe("incremental");
    expect(result.changedFiles).toEqual(["src/patientSummary.ts"]);
    expect(result.addedFiles).toEqual([]);
    expect(result.deletedFiles).toEqual([]);
    expect(result.parsedFiles).toEqual(["src/patientSummary.ts"]);
    expect(result.index.symbols).toContainEqual(expect.objectContaining({ filePath: "src/patientSummary.ts", name: "patientSummaryNew" }));
    expect(result.index.symbols).not.toContainEqual(expect.objectContaining({ filePath: "src/patientSummary.ts", name: "patientSummaryOld" }));
    expect(result.index.files.find((file) => file.path === "src/billing.ts")?.contentHash).toBe(
      first.files.find((file) => file.path === "src/billing.ts")?.contentHash
    );
  });

  it("removes deleted files and their graph data during incremental indexing", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummary() { return true; }");
    await writeFile(join(root, "src", "patientPage.ts"), "import { patientSummary } from './patientSummary'; export function patientPage() { return patientSummary(); }");

    const first = await indexProject(root);
    await rm(join(root, "src", "patientSummary.ts"));

    const result = await updateProjectIndexIncremental(root, first);

    expect(result.mode).toBe("incremental");
    expect(result.deletedFiles).toEqual(["src/patientSummary.ts"]);
    expect(result.index.files.map((file) => file.path)).not.toContain("src/patientSummary.ts");
    expect(result.index.symbols.map((symbol) => symbol.filePath)).not.toContain("src/patientSummary.ts");
    const importEdge = result.index.imports.find((edge) => edge.filePath === "src/patientPage.ts" && edge.source === "./patientSummary");
    expect(importEdge).toBeDefined();
    expect(importEdge?.resolvedPath).toBeUndefined();
  });

  it("re-parses only changed SQL migrations during incremental indexing", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "supabase", "migrations", "001_patients.sql"), "create table public.patients (id uuid primary key);");
    await writeFile(join(root, "supabase", "migrations", "002_policy.sql"), `create policy "old patient policy" on public.patients for select using (true);`);

    const first = await indexProject(root);
    await writeFile(join(root, "supabase", "migrations", "002_policy.sql"), `create policy "new patient policy" on public.patients for select using (true);`);

    const result = await updateProjectIndexIncremental(root, first);

    expect(result.mode).toBe("incremental");
    expect(result.parsedFiles).toEqual(["supabase/migrations/002_policy.sql"]);
    expect(result.index.sql.tables).toContainEqual(expect.objectContaining({ name: "public.patients" }));
    expect(result.index.sql.policies).toContainEqual(expect.objectContaining({ name: "new patient policy" }));
    expect(result.index.sql.policies).not.toContainEqual(expect.objectContaining({ name: "old patient policy" }));
  });

  it("falls back to full reindex when stored schema metadata is incompatible", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export function patientSummary() { return true; }");

    const first = await indexProject(root);
    const result = await updateProjectIndexIncremental(root, { ...first, schemaVersion: 0, scanMetadata: undefined });

    expect(result.mode).toBe("full");
    expect(result.fallbackReason).toMatch(/schema/i);
    expect(result.index.schemaVersion).toBe(CURRENT_INDEX_SCHEMA_VERSION);
    expect(result.index.files.map((file) => file.path)).toEqual(["src/patientSummary.ts"]);
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

  it("rejects persisted indexes missing newer SQL graph fields", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(
      indexPath(root),
      JSON.stringify({
        root,
        scannedAt: "2026-07-06T00:00:00.000Z",
        fingerprint: "old",
        frameworks: [],
        files: [],
        symbols: [],
        imports: [],
        exclusions: [],
        sql: { tables: [], relations: [], policies: [], indexes: [], triggers: [], functions: [], views: [] }
      })
    );

    await expect(loadProjectIndex(root)).resolves.toBeUndefined();
  });
});

describe("project wiki", () => {
  it("builds deterministic wiki pages from the indexed fixture and memories", async () => {
    const root = resolve("tests", "fixtures", "next-supabase");
    const project = await indexProject(root);
    const memories = [
      {
        id: "mem_patient_scope",
        createdAt: "2026-07-07T00:00:00.000Z",
        type: "architecture" as const,
        title: "Patient summaries stay tenant scoped",
        body: "Do not include this raw memory body in wiki pages.",
        tags: ["patients", "rls", "summary"]
      }
    ];

    const wiki = buildProjectWiki(project, memories);
    const rebuilt = buildProjectWiki(project, memories);
    const page = (slug: string) => {
      const found = wiki.pages.find((candidate) => candidate.slug === slug);
      expect(found, `expected wiki page ${slug}`).toBeDefined();
      return found!;
    };

    expect(wiki).toMatchObject({
      schemaVersion: 1,
      fingerprint: project.fingerprint
    });
    expect(wiki.pages.map((candidate) => candidate.slug)).toEqual(["overview", "structure", "routes", "database", "decisions"]);
    expect(wiki.pages.map((candidate) => candidate.body)).toEqual(rebuilt.pages.map((candidate) => candidate.body));

    expect(page("overview").body).toContain("- Frameworks: Next.js, PostgreSQL/Supabase, React, TypeScript");
    expect(page("overview").body).toContain("- next-route: 1");
    expect(page("overview").body).toContain("- react-component: 1");
    expect(page("overview").body).toContain("- Top-level directories: app, components, services, supabase");

    expect(page("structure").body).toContain("## app");
    expect(page("structure").body).toContain("- app/patients/[id]/page.tsx (next-route) exports PatientPage");
    expect(page("structure").body).toContain("- components/PatientCard.tsx (react-component) exports PatientCard");
    expect(page("structure").body).toContain("- services/patientService.ts (module) exports loadPatientSummary");

    expect(page("routes").body).toContain("- /patients/[id] -> app/patients/[id]/page.tsx");

    expect(page("database").body).toContain("- Table public.patients");
    expect(page("database").body).toContain("- Policy tenant can read active patients on public.patients");
    expect(page("database").body).toContain("- Materialized view public.patient_rollups");
    expect(page("database").body).toMatch(/1\. table public\.patients/);
    expect(page("database").body).toMatch(/2\. policy tenant can read active patients/);
    expect(page("database").body).toMatch(/3\. materializedView public\.patient_rollups/);

    expect(page("decisions").body).toContain("- Patient summaries stay tenant scoped (architecture; tags: patients, rls, summary)");
    expect(page("decisions").body).not.toContain("Do not include this raw memory body");

    for (const candidate of wiki.pages) {
      expect(candidate.slug).toMatch(/^[a-z0-9-]+$/);
      expect(candidate.title).toMatch(/\S/);
      expect(candidate.estimatedTokens).toBe(estimateTokens(candidate.body));
    }
  });

  it("omits empty database and decision pages", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "onlyCode.ts"), "export function onlyCode() { return true; }");
    const project = await indexProject(root);

    const wiki = buildProjectWiki(project, []);

    expect(wiki.pages.map((page) => page.slug)).toEqual(["overview", "structure"]);
  });

  it("persists wiki manifests and markdown pages", async () => {
    const root = resolve("tests", "fixtures", "next-supabase");
    const stateRoot = await makeRoot();
    const project = await indexProject(root);
    const wiki = buildProjectWiki(project, []);

    await saveProjectWiki(stateRoot, wiki);

    const files = (await readdir(wikiDir(stateRoot))).sort();
    expect(files).toEqual(["database.md", "manifest.json", "overview.md", "routes.md", "structure.md"]);
    expect(JSON.parse(await readFile(join(wikiDir(stateRoot), "manifest.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      fingerprint: wiki.fingerprint,
      pages: wiki.pages.map((page) => ({
        slug: page.slug,
        title: page.title,
        estimatedTokens: page.estimatedTokens,
        file: `${page.slug}.md`
      }))
    });

    await expect(loadProjectWiki(stateRoot)).resolves.toEqual(wiki);
  });

  it("returns undefined for missing or invalid wiki manifests", async () => {
    const root = await makeRoot();
    await expect(loadProjectWiki(root)).resolves.toBeUndefined();

    await mkdir(wikiDir(root), { recursive: true });
    await writeFile(join(wikiDir(root), "manifest.json"), "{ not json");

    await expect(loadProjectWiki(root)).resolves.toBeUndefined();
  });

  it("rejects wiki manifests whose page files escape the wiki directory", async () => {
    const root = await makeRoot();
    await mkdir(wikiDir(root), { recursive: true });
    await writeFile(
      join(wikiDir(root), "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        fingerprint: "unsafe",
        generatedAt: "2026-07-07T00:00:00.000Z",
        pages: [{ slug: "overview", title: "Overview", estimatedTokens: 1, file: "../overview.md" }]
      })
    );
    await writeFile(join(wikiDir(root), "overview.md"), "# Overview\n");

    await expect(loadProjectWiki(root)).resolves.toBeUndefined();

    await writeFile(
      join(wikiDir(root), "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        fingerprint: "unsafe",
        generatedAt: "2026-07-07T00:00:00.000Z",
        pages: [{ slug: "overview", title: "Overview", estimatedTokens: 1, file: join(root, "overview.md") }]
      })
    );

    await expect(loadProjectWiki(root)).resolves.toBeUndefined();
  });

  it("reports missing, fresh, and stale wiki status from the persisted index fingerprint", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'old';");

    await expect(getWikiStatus(root)).resolves.toMatchObject({ state: "missing", hasWiki: false });

    const project = await indexProject(root);
    await saveProjectIndex(root, project);
    await saveProjectWiki(root, buildProjectWiki(project, []));
    await expect(getWikiStatus(root)).resolves.toMatchObject({
      state: "fresh",
      hasWiki: true,
      wikiFingerprint: project.fingerprint,
      indexFingerprint: project.fingerprint
    });

    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = 'new';");
    const staleProject = await indexProject(root);
    await saveProjectIndex(root, staleProject);
    await expect(getWikiStatus(root)).resolves.toMatchObject({
      state: "stale",
      hasWiki: true,
      wikiFingerprint: project.fingerprint,
      indexFingerprint: staleProject.fingerprint
    });

    await clearProjectIndex(root);
    await saveProjectWiki(root, buildProjectWiki(project, []));
    await expect(getWikiStatus(root)).resolves.toMatchObject({
      state: "stale",
      hasWiki: true,
      indexFingerprint: undefined
    });
  });

  it("clears derived wiki state with index resets while preserving memories and config", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "patientSummary.ts"), "export const patientSummary = true;");
    const project = await indexProject(root);
    await saveProjectIndex(root, project);
    await saveProjectWiki(root, buildProjectWiki(project, []));
    await new MemoryStore(memoryPath(root)).add({
      type: "convention",
      title: "Keep reset narrow",
      body: "Index resets preserve memory and config.",
      tags: ["reset"]
    });
    await loadTokenGraphConfig(root);

    await clearProjectIndex(root);

    await expect(access(indexPath(root))).rejects.toThrow();
    await expect(access(wikiDir(root))).rejects.toThrow();
    await expect(access(memoryPath(root))).resolves.toBeUndefined();
    await expect(access(configPath(root))).resolves.toBeUndefined();

    await saveProjectIndex(root, project);
    await saveProjectWiki(root, buildProjectWiki(project, []));
    await clearProjectState(root);

    await expect(access(memoryPath(root))).rejects.toThrow();
    await expect(access(configPath(root))).rejects.toThrow();
    await expect(access(wikiDir(root))).rejects.toThrow();
  });
});

describe("buildContextPlan", () => {
  it("uses token-saving profiles to change context breadth and first reads", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    for (let index = 1; index <= 8; index += 1) {
      await writeFile(join(root, "services", `patientSummary${index}.ts`), `export function patientSummary${index}() { return ${index}; }`);
    }

    const project = await indexProject(root);
    const aggressive = await buildContextPlan({
      root,
      task: "Fix patient summary",
      project,
      memories: [],
      budget: { profile: "aggressive" }
    });
    const balanced = await buildContextPlan({
      root,
      task: "Fix patient summary",
      project,
      memories: [],
      budget: { profile: "balanced" }
    });
    const conservative = await buildContextPlan({
      root,
      task: "Fix patient summary",
      project,
      memories: [],
      budget: { profile: "conservative" }
    });

    expect(PROFILE_DEFAULTS.aggressive.maxFiles).toBe(3);
    expect(PROFILE_DEFAULTS.balanced.maxFiles).toBe(6);
    expect(PROFILE_DEFAULTS.conservative.maxFiles).toBe(10);
    expect(aggressive.profile).toBe("aggressive");
    expect(aggressive.relevantFiles).toHaveLength(3);
    expect(aggressive.recommendedFirstReads.length).toBeLessThanOrEqual(2);
    expect(balanced.relevantFiles).toHaveLength(6);
    expect(balanced.recommendedFirstReads.length).toBeLessThanOrEqual(3);
    expect(conservative.relevantFiles).toHaveLength(8);
    expect(conservative.recommendedFirstReads.length).toBeLessThanOrEqual(5);
    expect(aggressive.rawReadPolicy).toContain("4000");
  });

  it("lets explicit planner budgets override profile defaults", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    for (let index = 1; index <= 6; index += 1) {
      await writeFile(join(root, "services", `patientSummary${index}.ts`), `export function patientSummary${index}() { return ${index}; }`);
    }

    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root,
      task: "Fix patient summary",
      project,
      memories: [],
      budget: {
        profile: "aggressive",
        maxFiles: 5,
        maxSqlObjects: 0,
        maxMemories: 0,
        firstReads: 4,
        maxEstimatedTokens: 5000,
        allowRawReads: false
      }
    });

    expect(plan.profile).toBe("aggressive");
    expect(plan.relevantFiles).toHaveLength(5);
    expect(plan.recommendedFirstReads).toHaveLength(4);
    expect(plan.budget.maxFiles).toBe(5);
    expect(plan.budget.maxEstimatedTokens).toBe(5000);
    expect(plan.rawReadPolicy).toMatch(/Do not read broad raw files/i);
    expect(plan.budgetExclusions.length).toBeGreaterThan(0);
  });

  it("trims lower-priority context when a compact plan exceeds the estimated token budget", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    for (let index = 1; index <= 6; index += 1) {
      await writeFile(join(root, "services", `patientSummary${index}.ts`), `export function patientSummary${index}() { return ${index}; }`);
    }

    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root,
      task: "Fix patient summary",
      project,
      memories: [],
      budget: {
        profile: "conservative",
        maxFiles: 6,
        maxSqlObjects: 0,
        maxMemories: 0,
        firstReads: 5,
        maxEstimatedTokens: 120
      }
    });

    expect(plan.relevantFiles.length).toBeLessThan(6);
    expect(plan.budgetExclusions).toEqual(expect.arrayContaining([expect.stringMatching(/estimated context budget/i)]));
    expect(plan.estimatedTokens.compressed).toBeGreaterThan(0);
  });

  it("plans context from the Next.js Supabase fixture project", async () => {
    const root = resolve("tests", "fixtures", "next-supabase");

    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root,
      task: "Fix tenant active patient summary rollups on the patient page",
      project,
      memories: [],
      budget: { maxFiles: 5, maxSqlObjects: 5, maxMemories: 0 }
    });

    expect(plan.recommendedFirstReads.map((item) => item.path)).toContain("app/patients/[id]/page.tsx");
    expect(plan.relevantFiles.map((item) => item.path)).toContain("services/patientService.ts");
    expect(plan.relevantTests.map((item) => item.path)).toContain("services/patientService.test.ts");
    expect(plan.relevantSql).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "policy", name: "tenant can read active patients" }),
        expect.objectContaining({ kind: "materializedView", name: "public.patient_rollups" })
      ])
    );
  });

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
    expect(plan.estimatedTokens.avoided).toBeGreaterThanOrEqual(0);
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

  it("does not tell Codex to avoid relevant files trimmed only by budget", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    await writeFile(join(root, "services", "patientSummaryA.ts"), "export function patientSummaryAlpha() { return null; }");
    await writeFile(join(root, "services", "patientSummaryB.ts"), "export function patientSummaryBeta() { return null; }");
    await writeFile(join(root, "services", "patientSummaryC.ts"), "export function patientSummaryGamma() { return null; }");
    await writeFile(join(root, "services", "billing.ts"), "export function billingExport() { return null; }");

    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root,
      task: "Fix patient summary",
      project,
      memories: [],
      budget: { maxFiles: 2, maxSqlObjects: 0, maxMemories: 0 }
    });

    expect(plan.relevantFiles).toHaveLength(2);
    expect(plan.filesToAvoid.map((file) => file.path)).not.toContain("services/patientSummaryC.ts");
    expect(plan.filesToAvoid).toContainEqual(expect.objectContaining({ path: "services/billing.ts", score: 0 }));
  });

  it("ranks v0.5 SQL policy details and materialized views in context plans", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(
      join(root, "supabase", "migrations", "001_patient_rollups.sql"),
      `
        create table public.patients (id uuid primary key, tenant_id uuid, archived_at timestamptz);
        create policy "tenant can read active patients" on public.patients for select to authenticated using (tenant_id = auth.uid() and archived_at is null);
        create materialized view public.patient_rollups as select tenant_id, count(*) from public.patients group by tenant_id;
      `
    );

    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root,
      task: "Review tenant active patient rollups RLS policy",
      project,
      memories: [],
      budget: { maxFiles: 3, maxSqlObjects: 5, maxMemories: 0 }
    });

    expect(plan.relevantSql).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "policy", name: "tenant can read active patients" }),
        expect.objectContaining({ kind: "materializedView", name: "public.patient_rollups" })
      ])
    );
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
    expect(compressed.estimatedTokens.avoided).toBeGreaterThanOrEqual(0);
  });

  it("deduplicates actionable lines without quadratic Array index scans", () => {
    const indexOfSpy = vi.spyOn(Array.prototype, "indexOf");
    const noisyLog = Array.from({ length: 500 }, (_, index) => `Error: unique failure ${index}`).join("\n");

    const compressed = compressOutput({ kind: "test", text: noisyLog, maxLines: 5 });
    const indexOfCalls = indexOfSpy.mock.calls.length;
    indexOfSpy.mockRestore();

    expect(compressed.keyLines).toHaveLength(5);
    expect(compressed.omittedLineCount).toBeGreaterThan(0);
    expect(indexOfCalls).toBe(0);
  });

  it("keeps lowercase failed test summaries and does not floor negative savings", () => {
    const compressed = compressOutput({
      kind: "test",
      text: "setup warning\nTests  2 failed | 30 passed",
      maxLines: 5
    });

    expect(compressed.keyLines).toContain("Tests  2 failed | 30 passed");
    expect(compressed.estimatedTokens.avoided).toBeGreaterThanOrEqual(0);
  });
});

describe("tokenize", () => {
  it("splits camelCase before lowercasing", () => {
    expect(tokenize("PatientCard fetchUserById")).toEqual(expect.arrayContaining(["patient", "card", "fetch", "user", "by", "id"]));
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

  it("quarantines corrupt memory files and recovers with an empty list", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "memory.json");
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(storePath, "{ not json");

    const store = new MemoryStore(storePath);

    await expect(store.list()).resolves.toEqual([]);
    await expect(access(storePath)).rejects.toThrow();
    const files = await readdir(join(root, ".tokengraph"));
    expect(files.some((file) => file.startsWith("memory.json.corrupt-"))).toBe(true);
  });

  it("serializes concurrent memory writes without losing decisions", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "memory.json");
    const first = new MemoryStore(storePath);
    const second = new MemoryStore(storePath);

    await Promise.all([
      first.add({ type: "architecture", title: "First decision", body: "Keep the first decision.", tags: ["memory"] }),
      second.add({ type: "bug", title: "Second decision", body: "Keep the second decision.", tags: ["memory"] })
    ]);

    const titles = (await first.list()).map((memory) => memory.title).sort();
    expect(titles).toEqual(["First decision", "Second decision"]);
  });
});

describe("v0.7 review and export helpers", () => {
  it("reviews stored memories without mutating local memory state", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(memoryPath(root));
    const unrelated = await store.add({
      type: "convention",
      title: "Billing export names",
      body: "Billing exports use month suffixes.",
      tags: ["billing"]
    });
    const relevant = await store.add({
      type: "architecture",
      title: "Patient summaries stay tenant scoped",
      body: "Patient summary loading must stay tenant scoped and respect RLS policies.",
      tags: ["patients", "summary", "rls"]
    });

    const review = await reviewMemories({
      memories: await store.list(),
      query: "patient summary tenant rls",
      limit: 5
    });

    expect(review.totalMemories).toBe(2);
    expect(review.query).toBe("patient summary tenant rls");
    expect(review.matches[0]).toMatchObject({
      id: relevant.id,
      title: "Patient summaries stay tenant scoped",
      action: "keep"
    });
    expect(review.matches.map((match) => match.id)).toContain(unrelated.id);
    expect(review.policy).toMatch(/does not modify/i);
    await expect(store.list()).resolves.toHaveLength(2);
  });

  it("exports a compact Mermaid project map without raw source content", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components", "PatientCard.tsx"), "export function PatientCard() { return <article />; }");
    await writeFile(
      join(root, "app", "patients", "page.tsx"),
      [
        "import { PatientCard } from '../../components/PatientCard';",
        "export default function PatientsPage() {",
        "  return <PatientCard />;",
        "}"
      ].join("\n")
    );

    const project = await indexProject(root);
    const exported = exportProjectMap(project, { format: "mermaid", limit: 10 });

    expect(exported.format).toBe("mermaid");
    expect(exported.nodeCount).toBe(2);
    expect(exported.edgeCount).toBe(1);
    expect(exported.content).toContain("flowchart LR");
    expect(exported.content).toContain("app/patients/page.tsx");
    expect(exported.content).toContain("components/PatientCard.tsx");
    expect(exported.content).not.toContain("return <PatientCard");
  });

  it("prioritizes connected files when exporting a capped project map", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await mkdir(join(root, "components"), { recursive: true });
    await mkdir(join(root, "aaa"), { recursive: true });
    await writeFile(join(root, "aaa", "unconnected.ts"), "export const unconnected = true;");
    await writeFile(join(root, "components", "PatientCard.tsx"), "export function PatientCard() { return <article />; }");
    await writeFile(join(root, "app", "patients", "page.tsx"), "import { PatientCard } from '../../components/PatientCard'; export default PatientCard;");

    const project = await indexProject(root);
    const exported = exportProjectMap(project, { format: "json", limit: 2 });
    const parsed = JSON.parse(exported.content) as { nodes: Array<{ path: string }> };

    expect(parsed.nodes.map((node) => node.path)).toEqual(expect.arrayContaining(["app/patients/page.tsx", "components/PatientCard.tsx"]));
    expect(parsed.nodes.map((node) => node.path)).not.toContain("aaa/unconnected.ts");
  });
});
