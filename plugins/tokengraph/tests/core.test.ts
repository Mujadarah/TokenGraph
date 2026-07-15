import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compressOutput } from "../src/core/compressor.js";
import { compressContext } from "../src/core/contextCompressor.js";
import { ArchitectureRuleStore, checkArchitecture } from "../src/core/architectureRules.js";
import { traceFailure } from "../src/core/failureTracer.js";
import { assessChangeRisk } from "../src/core/regressionRisk.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
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
  rulesPath,
  saveProjectIndex,
  saveProjectWiki,
  wikiDir
} from "../src/core/persistence.js";
import { CURRENT_INDEX_SCHEMA_VERSION, indexProject, updateProjectIndexIncremental } from "../src/core/projectIndexer.js";
import { getIndexStatus } from "../src/core/indexStatus.js";
import { parsePostgresMigration } from "../src/core/sqlParser.js";
import { JsonTokenGraphStore, SqliteTokenGraphStore } from "../src/core/storage.js";
import { exportProjectMap, reviewMemories } from "../src/core/review.js";
import { estimateTokens, tokenize } from "../src/core/token.js";
import { buildProjectWiki } from "../src/core/wiki.js";
import type { MemoryEntry, MemoryInput } from "../src/core/types.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-"));
  tempRoots.push(root);
  return root;
}

function testMemory(input: MemoryInput & { id: string; createdAt: string }): MemoryEntry {
  return {
    ...input,
    status: input.status ?? "active",
    updatedAt: input.createdAt,
    linkedFiles: input.linkedFiles ?? [],
    linkedSymbols: input.linkedSymbols ?? [],
    linkedSqlObjects: input.linkedSqlObjects ?? [],
    linkedRules: input.linkedRules ?? [],
    confidence: input.confidence ?? "medium",
    supersedes: input.supersedes ?? [],
    supersededBy: input.supersededBy ?? [],
    source: input.source ?? "test",
    evidence: input.evidence ?? []
  };
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
    expect(JSON.parse(await readFile(configPath(root), "utf8"))).toEqual({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      config: DEFAULT_TOKEN_GRAPH_CONFIG
    });
  });

  it("migrates legacy config files into a schema-versioned envelope", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(configPath(root), JSON.stringify({ ...DEFAULT_TOKEN_GRAPH_CONFIG, tokenSavingProfile: "aggressive" }));

    const config = await loadTokenGraphConfig(root);
    const raw = JSON.parse(await readFile(configPath(root), "utf8"));

    expect(config.tokenSavingProfile).toBe("aggressive");
    expect(raw).toEqual({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      config
    });
  });

  it("quarantines corrupt config instead of silently destroying it", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(configPath(root), "{ not json");

    const config = await loadTokenGraphConfig(root);
    const files = await readdir(join(root, ".tokengraph"));

    expect(config).toEqual(DEFAULT_TOKEN_GRAPH_CONFIG);
    expect(files.some((file) => file.startsWith("config.json.corrupt-"))).toBe(true);
    expect(JSON.parse(await readFile(configPath(root), "utf8"))).toMatchObject({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION });
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

  it("lets TOKENGRAPH_ROUTING_MODE override the persisted mode", async () => {
    const root = await makeRoot();
    const previous = process.env.TOKENGRAPH_ROUTING_MODE;
    process.env.TOKENGRAPH_ROUTING_MODE = "enforced";
    try {
      await updateTokenGraphConfig(root, { routingMode: "always-advisory" });
      expect((await loadTokenGraphConfig(root)).routingMode).toBe("enforced");
    } finally {
      if (previous === undefined) delete process.env.TOKENGRAPH_ROUTING_MODE;
      else process.env.TOKENGRAPH_ROUTING_MODE = previous;
    }
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

  it("reports unsupported-language exclusions instead of silently dropping them", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "diagram.py"), "print('not parsed by the TypeScript-first scanner')");
    const graph = await scanProject(root);
    expect(graph.exclusions).toContainEqual(expect.objectContaining({ path: "src/diagram.py", reason: "unsupported" }));
    expect(graph.exclusions.filter((exclusion) => exclusion.reason === "unsupported")).toHaveLength(1);
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

  it("ends an arrow declaration at its closing parenthesis", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "factory.ts"),
      [
        "export const makePatient = () => (",
        "  {",
        "    id: 'patient-1'",
        "  }",
        ");",
        "",
        "export const unrelated = true;"
      ].join("\n")
    );

    const graph = await scanProject(root);

    expect(graph.symbols.find((symbol) => symbol.name === "makePatient")).toMatchObject({ startLine: 1, endLine: 5 });
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

  it("does not expose App Router layouts as duplicate routes", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await writeFile(
      join(root, "app", "patients", "layout.tsx"),
      "export default function Layout({ children }: { children: unknown }) { return children; }\n"
    );
    await writeFile(join(root, "app", "patients", "page.tsx"), "export default function Page() { return null; }\n");

    const graph = await scanProject(root);
    const layout = graph.files.find((file) => file.path.endsWith("/layout.tsx"));
    const page = graph.files.find((file) => file.path.endsWith("/page.tsx"));

    expect(layout?.kind).not.toBe("next-route");
    expect(layout?.route).toBeUndefined();
    expect(page).toMatchObject({ kind: "next-route", route: "/patients" });
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

  it("honors nested gitignore files", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(join(root, "src", ".gitignore"), "generated/\n");
    await writeFile(join(root, "src", "generated", "client.ts"), "export const generated = true;\n");
    await writeFile(join(root, "src", "real.ts"), "export const real = true;\n");

    const graph = await scanProject(root);
    const project = await indexProject(root);

    expect(graph.files.map((file) => file.path)).toEqual(["src/real.ts"]);
    expect(project.files.map((file) => file.path)).toEqual(["src/real.ts"]);
    expect(graph.exclusions).toContainEqual(expect.objectContaining({ path: "src/generated", reason: "ignored" }));
  });

  it("records symlink entries as explicit exclusions", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    const target = join(root, "src", "real.ts");
    const link = join(root, "src", "linked.ts");
    await writeFile(target, "export const real = true;\n");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }

    const graph = await scanProject(root);

    expect(graph.files.map((file) => file.path)).toEqual(["src/real.ts"]);
    expect(graph.exclusions).toContainEqual(expect.objectContaining({ path: "src/linked.ts", reason: "symlink" }));
  });

  it("keeps content hashes stable across line endings", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    const file = join(root, "src", "line-endings.ts");
    await writeFile(file, "export const value = 1;\nexport const other = 2;\n");
    const lf = await scanProject(root);
    const initialIndex = await indexProject(root);

    await writeFile(file, "export const value = 1;\r\nexport const other = 2;\r\n");
    const crlf = await scanProject(root);
    const updatedIndex = await updateProjectIndexIncremental(root, initialIndex);

    expect(crlf.files.find((entry) => entry.path === "src/line-endings.ts")?.contentHash).toBe(
      lf.files.find((entry) => entry.path === "src/line-endings.ts")?.contentHash
    );
    expect(updatedIndex.changedFiles).toEqual([]);
    expect(updatedIndex.parsedFiles).toEqual([]);
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
  it("keeps columns and constraints after a quoted close-paren default", () => {
    const graph = parsePostgresMigration(
      "supabase/migrations/007_quoted_default.sql",
      "create table public.messages (id uuid primary key, marker text default ')', tenant_id uuid not null, constraint messages_tenant_fk foreign key (tenant_id) references public.tenants(id));"
    );

    expect(graph.tables).toEqual([
      expect.objectContaining({
        name: "public.messages",
        columns: ["id", "marker", "tenant_id"]
      })
    ]);
    expect(graph.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "messages_tenant_fk", kind: "foreign key" })
    ]));
  });

  it("preserves quoted column names containing spaces", () => {
    const graph = parsePostgresMigration(
      "supabase/migrations/006_columns.sql",
      "create table public.notes (\"Display Name\" text, id uuid primary key);"
    );

    expect(graph.tables).toEqual([expect.objectContaining({ name: "public.notes", columns: ["Display Name", "id"] })]);
  });

  it("reports a case-mismatched dollar quote instead of silently dropping later SQL", () => {
    const graph = parsePostgresMigration(
      "supabase/migrations/003_malformed.sql",
      [
        "create function public.bad() returns void as $FUNC$",
        "begin",
        "  perform 1;",
        "end;",
        "$func$;",
        "create table public.after_bad (id uuid primary key);"
      ].join("\n")
    );

    expect(graph.warnings).toEqual([
      expect.objectContaining({ filePath: "supabase/migrations/003_malformed.sql", message: expect.stringMatching(/dollar/i) })
    ]);
    expect(graph.tables).toEqual([]);
  });

  it("reports an unterminated SQL string", () => {
    const graph = parsePostgresMigration(
      "supabase/migrations/004_unterminated.sql",
      [
        "insert into public.seed_notes (body) values ('unfinished);",
        "create table public.after_bad (id uuid primary key);"
      ].join("\n")
    );

    expect(graph.warnings).toEqual([
      expect.objectContaining({ filePath: "supabase/migrations/004_unterminated.sql", message: expect.stringMatching(/single-quoted/i) })
    ]);
  });

  it("folds unquoted SQL identifiers but preserves quoted identifiers", () => {
    const graph = parsePostgresMigration(
      "supabase/migrations/005_case.sql",
      [
        "create table PUBLIC.Patients (ID uuid primary key);",
        "create policy read_patients on public.PATIENTS for select using (true);",
        "create table public.\"PatientNotes\" (\"DisplayName\" text);"
      ].join("\n")
    );

    expect(graph.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "public.patients", columns: ["id"] }),
        expect.objectContaining({ name: "public.PatientNotes", columns: ["DisplayName"] })
      ])
    );
    expect(graph.policies).toEqual(expect.arrayContaining([expect.objectContaining({ table: "public.patients" })]));
  });

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
  it("renders deterministic Obsidian frontmatter, backlinks, conflicts, and source freshness", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "flow.ts"), "export const flow = true;\n");
    const project = await indexProject(root);
    const sourceFingerprint = project.scanMetadata?.files["src/flow.ts"]?.contentHash;
    expect(sourceFingerprint).toBeTruthy();
    const applications = [{
      suggestionId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "reviewed-flow-v1",
      type: "wiki" as const,
      title: "Reviewed flow",
      rationale: "The source defines the flow.",
      proposedContent: "The reviewed flow is active.",
      sources: [{
        kind: "path" as const,
        sourceId: "src/flow.ts",
        fingerprint: sourceFingerprint!,
        provenance: "revalidated-current" as const
      }],
      provenanceStatus: "revalidated-current" as const,
      affectedTargets: { wikiPages: ["overview"], memories: [], skills: [] },
      conflictNotes: ["Older notes say the flow is disabled."],
      appliedAt: "2026-07-13T10:00:00.000Z"
    }];

    const first = buildProjectWiki(project, [], applications);
    const second = buildProjectWiki(project, [], applications);
    const overview = first.pages.find((page) => page.slug === "overview")!;
    const structure = first.pages.find((page) => page.slug === "structure")!;

    expect(first).toEqual(second);
    expect(overview.body).toMatch(/^---\ntitle: "Project Overview"\nslug: "overview"\nfreshness: "fresh"/);
    expect(overview.body).toContain("[[structure|Project Structure]]");
    expect(structure.body).toContain("## Backlinks\n- [[overview|Project Overview]]");
    expect(overview.body).toContain("> [!warning] Conflict: Older notes say the flow is disabled.");
    expect(overview.body).toContain("The reviewed flow is active.");
    expect(overview.freshness).toBe("fresh");

    const changed = structuredClone(project);
    changed.scanMetadata!.files["src/flow.ts"]!.contentHash = "changed";
    const staleOverview = buildProjectWiki(changed, [], applications).pages.find((page) => page.slug === "overview")!;
    expect(staleOverview.freshness).toBe("stale");
    expect(staleOverview.body).toContain('freshness: "stale"');

    delete changed.scanMetadata!.files["src/flow.ts"];
    expect(buildProjectWiki(changed, [], applications).pages.find((page) => page.slug === "overview")!.freshness).toBe("stale");

    const customTarget = structuredClone(applications);
    customTarget[0]!.affectedTargets.wikiPages = ["architecture/request-flow"];
    const customPage = buildProjectWiki(project, [], customTarget).pages.find((page) => page.slug === "architecture/request-flow");
    expect(customPage).toMatchObject({ title: "Reviewed flow", freshness: "fresh" });
    expect(customPage!.body).toContain("The reviewed flow is active.");
    expect(customPage!.body).toContain("[[../overview|Project Overview]]");
  });

  it("builds deterministic wiki pages from the indexed fixture and memories", async () => {
    const root = resolve("tests", "fixtures", "next-supabase");
    const project = await indexProject(root);
    const memories = [
      testMemory({
        id: "mem_patient_scope",
        createdAt: "2026-07-07T00:00:00.000Z",
        type: "architecture" as const,
        title: "Patient summaries stay tenant scoped",
        body: "Do not include this raw memory body in wiki pages.",
        tags: ["patients", "rls", "summary"]
      })
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

  it("refreshes only wiki pages whose deterministic content changed", async () => {
    const fixtureRoot = resolve("tests", "fixtures", "next-supabase");
    const root = await makeRoot();
    const project = await indexProject(fixtureRoot);
    const wiki = buildProjectWiki(project, []);
    await saveProjectWiki(root, wiki);
    const overviewPath = join(wikiDir(root), "overview.md");
    const structurePath = join(wikiDir(root), "structure.md");
    const beforeOverview = (await stat(overviewPath)).mtimeMs;
    const beforeStructure = (await stat(structurePath)).mtimeMs;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));

    const changed = structuredClone(wiki);
    const overview = changed.pages.find((page) => page.slug === "overview")!;
    overview.body += "\nReviewed increment.\n";
    overview.estimatedTokens = estimateTokens(overview.body);
    await saveProjectWiki(root, changed);

    expect((await stat(overviewPath)).mtimeMs).toBeGreaterThan(beforeOverview);
    expect((await stat(structurePath)).mtimeMs).toBe(beforeStructure);
  });

  it("rejects nested wiki directory symlinks that escape the workspace", async () => {
    const fixtureRoot = resolve("tests", "fixtures", "next-supabase");
    const root = await makeRoot();
    const outside = await makeRoot();
    const project = await indexProject(fixtureRoot);
    const wiki = buildProjectWiki(project, []);
    wiki.pages.push({ slug: "architecture/request-flow", title: "Flow", body: "# Flow\n", estimatedTokens: 2 });
    await mkdir(join(wikiDir(root), "architecture"), { recursive: true });
    await rm(join(wikiDir(root), "architecture"), { recursive: true, force: true });
    await symlink(outside, join(wikiDir(root), "architecture"), "junction");

    await expect(saveProjectWiki(root, wiki)).rejects.toThrow(/workspace|outside|confined/i);
    expect(await readdir(outside)).toEqual([]);
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

    await writeFile(
      join(wikiDir(root), "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        fingerprint: "unsafe",
        generatedAt: "2026-07-07T00:00:00.000Z",
        pages: [{ slug: "../../outside", title: "Unsafe slug", estimatedTokens: 1, file: "overview.md" }]
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
      testMemory({
        id: "mem_old",
        createdAt: "2026-07-06T00:00:00.000Z",
        type: "convention" as const,
        title: "Billing export naming",
        body: "Billing reports use export suffixes.",
        tags: ["billing"]
      }),
      testMemory({
        id: "mem_patient",
        createdAt: "2026-07-06T00:01:00.000Z",
        type: "architecture" as const,
        title: "Patient summary scope",
        body: "Patient summary loading must stay tenant scoped.",
        tags: ["patients", "summary"]
      })
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
  it("names the text cap according to its character semantics", async () => {
    const source = await readFile("src/core/compressor.ts", "utf8");
    expect(source).toContain("MAX_INPUT_CHARS");
    expect(source).not.toContain("MAX_INPUT_BYTES");
  });

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

describe("compressContext", () => {
  it("routes focused tests and SQL sources into first reads without requiring literal paths in raw text", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "services", "patientService.ts"), "export const getPatient = true;");
    await writeFile(join(root, "services", "patientService.test.ts"), "test('getPatient tenant behavior', () => true);");
    await writeFile(join(root, "supabase", "migrations", "001_patients.sql"), "create policy patient_rls on patients using (tenant_id = auth.uid());");
    const project = await indexProject(root);

    const report = await compressContext({
      root,
      task: "Compress the failing getPatient test and patients RLS tenant policy context",
      contentKind: "mixed",
      text: "Security warning: preserve tenant_id and auth.uid while fixing the failing getPatient test.",
      project,
      memories: []
    });

    expect(report.recommendedFirstReads).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "services/patientService.test.ts" }),
      expect.objectContaining({ path: "supabase/migrations/001_patients.sql" })
    ]));
  });

  it("keeps one SQL representative per lexically relevant migration before compact selection", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "supabase", "migrations", "001_patients.sql"), `create table public.patients (id uuid, tenant_id uuid); create index patients_tenant_id_idx on public.patients (tenant_id);`);
    await writeFile(join(root, "supabase", "migrations", "002_audit.sql"), `create table public.audit_events (id uuid, tenant_id uuid); create policy "audit tenant" on public.audit_events using (tenant_id = auth.uid());`);
    const project = await indexProject(root);
    const plan = await buildContextPlan({
      root, task: "Check authenticated RLS policies across patients and audit_events migrations", project, memories: [],
      budget: { maxFiles: 1, maxSqlObjects: 4, maxMemories: 0, maxEstimatedTokens: 250 }
    });
    expect(new Set(plan.relevantSql.map((entry) => entry.filePath))).toEqual(new Set([
      "supabase/migrations/001_patients.sql", "supabase/migrations/002_audit.sql"
    ]));
  });

  it("preserves constraints, failure details, migrations, public API names, and targeted first reads", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    await writeFile(join(root, "services", "patientService.ts"), "export function loadPatientSummary() { return []; }");
    await writeFile(
      join(root, "services", "patientService.test.ts"),
      "import { loadPatientSummary } from './patientService'; test('keeps tenant scoped rows', () => loadPatientSummary());"
    );
    const project = await indexProject(root);
    const memory = new MemoryStore(memoryPath(root));
    await memory.add({
      type: "bug",
      title: "Patient RLS failures keep exact test output",
      body: "Preserve exact failing test names and RLS migration identifiers.",
      tags: ["patient", "rls", "test"]
    });
    const text = [
      "User constraint: Do not remove public API loadPatientSummary.",
      "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
      "AssertionError: expected 2 to be 1",
      "    at loadPatientSummary (services/patientService.ts:1:17)",
      "Migration 20260708_add_patient_rls.sql must preserve RLS policy using tenant_id = auth.uid().",
      "Security warning: tenant isolation is required.",
      ...Array.from({ length: 50 }, (_, index) => `noise line ${index}`)
    ].join("\n");

    const compressed = await compressContext({
      root,
      task: "Fix patient summary tenant scoped rows",
      contentKind: "mixed",
      text,
      preserveRawReferences: true,
      project,
      memories: await memory.search("patient rls test")
    });

    expect(compressed.compressedTask).toContain("Fix patient summary tenant scoped rows");
    expect(compressed.preservedConstraints).toEqual(
      expect.arrayContaining([
        "User constraint: Do not remove public API loadPatientSummary.",
        "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
        "AssertionError: expected 2 to be 1",
        "at loadPatientSummary (services/patientService.ts:1:17)",
        "Migration 20260708_add_patient_rls.sql must preserve RLS policy using tenant_id = auth.uid().",
        "Security warning: tenant isolation is required."
      ])
    );
    expect(compressed.referencedMemories).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Patient RLS failures keep exact test output" })]));
    expect(compressed.recommendedFirstReads).toEqual(expect.arrayContaining([expect.objectContaining({ path: "services/patientService.ts", startLine: 1 })]));
    expect(compressed.omissions.join("\n")).toMatch(/omitted/i);
    expect(compressed.estimatedTokens.avoided).toBeGreaterThan(0);
    expect(compressed.confidence).toMatch(/medium|high/);
  });
});

describe("traceFailure", () => {
  it("routes a focused test named by the task even when raw failure text omits its path", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    await writeFile(join(root, "services", "patientService.ts"), "export const getPatient = true;");
    await writeFile(join(root, "services", "patientService.test.ts"), "test('getPatient', () => true);");
    const project = await indexProject(root);
    const trace = await traceFailure({
      root, kind: "test", text: "AssertionError: expected tenant row", task: "Fix failing getPatient test at services/patientService.test.ts",
      project, memories: []
    });

    expect(trace.relatedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "services/patientService.test.ts" })]));
    expect(trace.recommendedFirstReads).toEqual(expect.arrayContaining([expect.objectContaining({ path: "services/patientService.test.ts" })]));
    expect(trace.recommendedCommands).toContain("pnpm test -- services/patientService.test.ts");
  });

  it("preserves exact failure details and routes to graph-related context", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(join(root, "services", "patientService.ts"), "export function loadPatientSummary() { return []; }");
    await writeFile(
      join(root, "services", "patientService.test.ts"),
      "import { loadPatientSummary } from './patientService'; it('keeps tenant scoped rows', () => loadPatientSummary());"
    );
    await writeFile(
      join(root, "supabase", "migrations", "001_patients.sql"),
      "create table public.patients (id uuid primary key, tenant_id uuid); create policy \"tenant can read patients\" on public.patients for select using (tenant_id = auth.uid());"
    );
    const project = await indexProject(root);
    const memory = new MemoryStore(memoryPath(root));
    await memory.add({
      type: "bug",
      title: "Patient summaries must stay tenant scoped",
      body: "Past patient summary bugs leaked tenant rows when RLS context was skipped.",
      tags: ["patient", "tenant", "rls"]
    });
    const failureText = [
      "FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows",
      "AssertionError: expected 2 to be 1",
      "    at loadPatientSummary (services/patientService.ts:1:17)",
      "    at services/patientService.test.ts:1:82"
    ].join("\n");

    const trace = await traceFailure({
      root,
      kind: "test",
      text: failureText,
      task: "Fix patient summary tenant scoped rows",
      project,
      memories: await memory.search("patient tenant rls")
    });

    expect(trace.compressedOutput.keyLines).toContain("FAIL services/patientService.test.ts > patient summary > keeps tenant scoped rows");
    expect(trace.compressedOutput.keyLines).toContain("AssertionError: expected 2 to be 1");
    expect(trace.compressedOutput.keyLines).toContain("at loadPatientSummary (services/patientService.ts:1:17)");
    expect(trace.detectedPaths).toEqual(expect.arrayContaining(["services/patientService.ts", "services/patientService.test.ts"]));
    expect(trace.detectedTests).toContain("services/patientService.test.ts > patient summary > keeps tenant scoped rows");
    expect(trace.detectedSymbols).toContain("loadPatientSummary");
    expect(trace.relatedImports).toEqual(
      expect.arrayContaining([expect.objectContaining({ filePath: "services/patientService.test.ts", resolvedPath: "services/patientService.ts" })])
    );
    expect(trace.relatedSql).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "policy", name: "tenant can read patients" })]));
    expect(trace.relatedMemories).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Patient summaries must stay tenant scoped" })]));
    expect(trace.hypotheses[0]).toMatchObject({
      label: "hypothesis",
      confidence: expect.stringMatching(/medium|high/)
    });
    expect(trace.recommendedFirstReads).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "services/patientService.ts", startLine: 1 })])
    );
    expect(trace.recommendedCommands).toEqual(expect.arrayContaining(["pnpm test -- services/patientService.test.ts"]));
    expect(trace.tokenEstimate.avoided).toBeGreaterThanOrEqual(0);
  });
});

describe("JsonTokenGraphStore", () => {
  it("writes schema-versioned JSON and quarantines corrupt state", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "token-events.json");
    const store = new JsonTokenGraphStore(storePath, { schemaVersion: 1, dataKey: "events" });

    await store.write([{ id: "evt_1", estimatedTokens: 10 }]);
    expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual({
      schemaVersion: 1,
      events: [{ id: "evt_1", estimatedTokens: 10 }]
    });

    await writeFile(storePath, "{ not json");
    await expect(store.read()).resolves.toEqual([]);
    expect((await readdir(join(root, ".tokengraph"))).some((file) => file.startsWith("token-events.json.corrupt-"))).toBe(true);
  });

  it("refuses to read a store written by a different schema version", async () => {
    const root = await makeRoot();
    const storePath = join(root, ".tokengraph", "token-events.json");
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(storePath, JSON.stringify({ schemaVersion: 0, events: [] }));
    const store = new JsonTokenGraphStore(storePath, { schemaVersion: 1, dataKey: "events" });
    await expect(store.read()).rejects.toThrow(/schema version/i);
  });

  it("keeps SQLite optional and unavailable until explicitly implemented", () => {
    expect(() => new SqliteTokenGraphStore("unused.sqlite")).toThrow(/optional SQLite backend is not implemented/i);
  });
});

describe("assessChangeRisk", () => {
  it("retains project-wide marketplace findings", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(
      join(root, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "tokengraph", source: { path: "./plugins/tokengraph" } }] })
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "changed.ts"), "export const changed = true;\n");

    const report = await assessChangeRisk({
      root,
      changedFiles: ["src/changed.ts"],
      project: await indexProject(root),
      rules: [],
      memories: []
    });

    expect(report.affectedRules).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "marketplace-target", sourcePath: "./plugins/tokengraph" })])
    );
  });

  it("scores regression risk from graph, SQL, rules, tests, and memories", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "app", "patients"), { recursive: true });
    await mkdir(join(root, "src", "services"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await writeFile(
      join(root, "app", "patients", "page.tsx"),
      "import { loadPatientSummary } from '../../src/services/patientService'; export default function Page() { return loadPatientSummary(); }"
    );
    await writeFile(join(root, "src", "services", "patientService.ts"), "export function loadPatientSummary() { return []; }");
    await writeFile(
      join(root, "src", "services", "patientService.test.ts"),
      "import { loadPatientSummary } from './patientService'; it('keeps tenant scoped rows', () => loadPatientSummary());"
    );
    await writeFile(
      join(root, "supabase", "migrations", "001_patient_rls.sql"),
      [
        "create table public.patients (id uuid primary key, tenant_id uuid, auth_user_id uuid);",
        "create policy \"tenant can read patients\" on public.patients for select using (tenant_id = auth.uid());",
        "create function public.audit_patient_change() returns trigger language plpgsql as $$ begin return new; end; $$;"
      ].join("\n")
    );
    const project = await indexProject(root);
    const memory = new MemoryStore(memoryPath(root));
    await memory.add({
      type: "bug",
      title: "Patient tenant scoping is fragile",
      body: "Past patient summary bugs leaked tenant rows when auth and RLS context were skipped.",
      tags: ["patient", "tenant", "fragile", "rls"]
    });
    const rules = new ArchitectureRuleStore(rulesPath(root));
    const rule = await rules.add({
      type: "forbidden-import",
      name: "Routes cannot import services directly",
      fromPattern: "^app/",
      targetPattern: "^src/services/",
      severity: "warning"
    });

    const report = await assessChangeRisk({
      root,
      changedFiles: ["src/services/patientService.ts", "supabase/migrations/001_patient_rls.sql"],
      diffSummary: "Touches tenant_id RLS policy, auth user lookup, and audit logging for patient summaries.",
      task: "Change patient summary tenant scoping and audit logging",
      project,
      rules: await rules.list(),
      memories: await memory.search("patient tenant fragile rls")
    });

    expect(report.riskLevel).toBe("high");
    expect(report.riskScore).toBeGreaterThanOrEqual(70);
    expect(report.affectedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/services/patientService.ts" }),
        expect.objectContaining({ path: "app/patients/page.tsx" })
      ])
    );
    expect(report.affectedRoutes.some((route) => route.includes("patients"))).toBe(true);
    expect(report.affectedTests).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/services/patientService.test.ts" })]));
    expect(report.affectedSql).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "table", name: "public.patients" }),
        expect.objectContaining({ kind: "policy", name: "tenant can read patients" })
      ])
    );
    expect(report.affectedRules).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: rule.id })]));
    expect(report.affectedMemories).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Patient tenant scoping is fragile" })]));
    expect(report.recommendedTests).toEqual(expect.arrayContaining(["pnpm test -- src/services/patientService.test.ts"]));
    expect(report.manualReviewWarnings.join("\n")).toMatch(/tenant isolation|RLS|audit/i);
    expect(report.tokenEstimate.avoided).toBeGreaterThanOrEqual(0);
  });
});

describe("tokenize", () => {
  it("splits camelCase before lowercasing", () => {
    expect(tokenize("PatientCard fetchUserById")).toEqual(expect.arrayContaining(["patient", "card", "fetch", "user", "by", "id"]));
  });

  it("keeps identifiers while exposing underscore-separated relation terms", () => {
    expect(tokenize("patients_tenant_id_idx")).toEqual(expect.arrayContaining(["patients_tenant_id_idx", "patients", "tenant", "id", "idx"]));
  });

  it("estimates dense scripts and emoji closer to one token per code point", () => {
    expect(estimateTokens("\u60a8\u8005\u60a8\u8005")).toBeGreaterThanOrEqual(4);
    expect(estimateTokens("\u{1F642}\u{1F642}")).toBeGreaterThanOrEqual(2);
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
    expect(raw).toMatchObject({
      schemaVersion: 1,
      memories: [expect.objectContaining({ type: "convention", title: "Use server actions for patient mutations", status: "active" })]
    });
  });

  it("migrates legacy memory arrays to schema-versioned storage on write", async () => {
    const root = await makeRoot();
    const storePath = memoryPath(root);
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify([
        {
          id: "mem_legacy",
          createdAt: "2026-07-08T00:00:00.000Z",
          type: "bug",
          title: "Legacy memory",
          body: "Legacy body.",
          tags: ["legacy"]
        }
      ])
    );

    const store = new MemoryStore(storePath);
    expect(await store.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "mem_legacy", status: "active" })]));

    await store.update("mem_legacy", { confidence: "high" });
    expect(JSON.parse(await readFile(storePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      memories: [expect.objectContaining({ id: "mem_legacy", confidence: "high" })]
    });
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

  it("preserves concurrent memory lifecycle mutations", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(memoryPath(root));
    const memory = await store.add({
      type: "architecture",
      title: "Keep lifecycle evidence",
      body: "Concurrent lifecycle updates must all survive.",
      tags: []
    });

    await Promise.all([
      store.link(memory.id, { linkedFiles: ["src/first.ts"], evidence: ["linked-first"] }),
      store.link(memory.id, { linkedFiles: ["src/second.ts"], evidence: ["linked-second"] }),
      store.confirm(memory.id, ["confirmed-first"]),
      store.confirm(memory.id, ["confirmed-second"]),
      store.deprecate(memory.id, ["mem-replacement-a"], ["deprecated-first"]),
      store.deprecate(memory.id, ["mem-replacement-b"], ["deprecated-second"])
    ]);

    const [updated] = await store.list({ includeDeprecated: true });
    expect(updated).toMatchObject({
      id: memory.id,
      status: "deprecated",
      confidence: "high",
      linkedFiles: expect.arrayContaining(["src/first.ts", "src/second.ts"]),
      supersededBy: expect.arrayContaining(["mem-replacement-a", "mem-replacement-b"]),
      evidence: expect.arrayContaining(["linked-first", "linked-second", "confirmed-first", "confirmed-second", "deprecated-first", "deprecated-second"]),
      confirmedAt: expect.any(String)
    });
  });

  it("tracks lifecycle metadata and excludes deprecated or deleted memories from normal recall", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(memoryPath(root));

    const active = await store.add({
      type: "architecture",
      title: "Use REST patient API",
      body: "Patient reads use REST endpoints until the API migration is complete.",
      tags: ["patient", "api"],
      source: "test-plan",
      confidence: "medium"
    });
    expect(active).toMatchObject({
      status: "active",
      confidence: "medium",
      source: "test-plan",
      linkedFiles: [],
      linkedSymbols: [],
      linkedSqlObjects: [],
      linkedRules: [],
      supersedes: [],
      supersededBy: [],
      evidence: []
    });

    const confirmed = await store.confirm(active.id, ["Verified in ADR-001"]);
    expect(confirmed).toMatchObject({ status: "active", confidence: "high", evidence: ["Verified in ADR-001"] });
    expect(confirmed?.confirmedAt).toEqual(expect.any(String));

    const linked = await store.link(active.id, {
      linkedFiles: ["src/services/patientService.ts", "src/services/patientService.ts"],
      linkedSymbols: ["loadPatientSummary"],
      linkedSqlObjects: ["public.patients"],
      linkedRules: ["rule_patient_api"],
      evidence: ["Linked during Phase G test"]
    });
    expect(linked).toMatchObject({
      linkedFiles: ["src/services/patientService.ts"],
      linkedSymbols: ["loadPatientSummary"],
      linkedSqlObjects: ["public.patients"],
      linkedRules: ["rule_patient_api"],
      evidence: ["Verified in ADR-001", "Linked during Phase G test"]
    });

    const recalled = await store.recall("patient api", { limit: 5 });
    expect(recalled.memories).toEqual(expect.arrayContaining([expect.objectContaining({ id: active.id, status: "active" })]));
    expect(recalled.memories.find((memory) => memory.id === active.id)?.lastUsedAt).toEqual(expect.any(String));

    await store.deprecate(active.id, ["mem_replacement"], ["Replaced by GraphQL migration decision"]);
    expect(await store.search("patient api")).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.list({ includeDeprecated: true })).toEqual(expect.arrayContaining([expect.objectContaining({ id: active.id, status: "deprecated" })]));

    await store.delete(active.id);
    expect(await store.list({ includeDeprecated: true })).toEqual([]);
    expect(await store.list({ includeDeleted: true, includeDeprecated: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: active.id, status: "deleted" })])
    );
    expect((await store.recall("patient api")).memories).toEqual([]);
    expect((await store.recall("patient api", { auditMode: true })).memories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: active.id, status: "deleted" })])
    );
  });

  it("surfaces memory conflicts without resolving them automatically", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(memoryPath(root));
    const existing = await store.add({
      type: "architecture",
      title: "Use REST patient API",
      body: "Use REST endpoints for patient reads.",
      tags: ["patient", "api"]
    });

    const conflicts = await store.findConflicts({
      candidate: {
        type: "architecture",
        title: "Use GraphQL patient API",
        body: "Prefer GraphQL instead of REST for patient reads.",
        tags: ["patient", "api"]
      }
    });

    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memory: expect.objectContaining({ id: existing.id, status: "active" }),
          matchedTerms: expect.arrayContaining(["patient", "api"])
        })
      ])
    );
    expect(await store.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: existing.id, status: "active" })]));
  });

  it("does not flag same-type memories when only one body term overlaps", async () => {
    const root = await makeRoot();
    const store = new MemoryStore(memoryPath(root));
    await store.add({ type: "architecture", title: "Patient read", body: "Cache patient rows.", tags: [] });

    const conflicts = await store.findConflicts({
      candidate: {
        type: "architecture",
        title: "Billing write",
        body: "Cache billing invoices.",
        tags: []
      }
    });

    expect(conflicts).toEqual([]);
  });
});

describe("ArchitectureRuleStore and checkArchitecture", () => {
  it("skips a catastrophic pattern loaded directly from disk", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(
      rulesPath(root),
      JSON.stringify({
        schemaVersion: 1,
        rules: [{
          id: "rule_disk_unsafe",
          type: "forbidden-import",
          name: "Unsafe persisted rule",
          enabled: true,
          severity: "warning",
          fromPattern: "^(a+)+$",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z"
        }]
      })
    );

    const store = new ArchitectureRuleStore(rulesPath(root));
    const project = await indexProject(root);
    const report = await checkArchitecture({ root, project, rules: await store.list() });

    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/unsafe|invalid|skipped/i) })
    ]));
    expect(report.violations).toEqual([]);
  });

  it("rejects a catastrophic architecture rule before persistence", async () => {
    const root = await makeRoot();
    const store = new ArchitectureRuleStore(rulesPath(root));

    await expect(
      store.add({
        type: "forbidden-import",
        name: "Unsafe backtracking rule",
        fromPattern: "^(a+)+$"
      })
    ).rejects.toThrow(/unsafe architecture rule pattern/i);

    await expect(store.list()).resolves.toEqual([]);
  });

  it("persists a normal anchored architecture rule", async () => {
    const root = await makeRoot();
    const store = new ArchitectureRuleStore(rulesPath(root));

    const rule = await store.add({
      type: "forbidden-import",
      name: "Routes cannot import services directly",
      fromPattern: "^app/",
      targetPattern: "^src/services/"
    });

    expect(rule.fromPattern).toBe("^app/");
    expect(await store.list()).toEqual([rule]);
  });

  it("rejects an unsafe architecture pattern during update", async () => {
    const root = await makeRoot();
    const store = new ArchitectureRuleStore(rulesPath(root));
    const rule = await store.add({ type: "forbidden-import", name: "Safe rule", fromPattern: "^app/" });

    await expect(store.update(rule.id, { fromPattern: "^(a+)+$" })).rejects.toThrow(/unsafe architecture rule pattern/i);
    await expect(store.list()).resolves.toEqual([rule]);
  });

  it("persists, updates, and deletes local architecture rules", async () => {
    const root = await makeRoot();
    const store = new ArchitectureRuleStore(rulesPath(root));

    const created = await store.add({
      type: "forbidden-import",
      name: "UI must not import server internals",
      fromPattern: "^src/ui/",
      targetPattern: "^src/server/",
      severity: "error",
      message: "Route through a public service boundary."
    });
    const updated = await store.update(created.id, { enabled: false, message: "Use the API client boundary." });

    expect(created).toMatchObject({
      type: "forbidden-import",
      name: "UI must not import server internals",
      enabled: true,
      severity: "error"
    });
    expect(updated).toMatchObject({
      id: created.id,
      enabled: false,
      message: "Use the API client boundary."
    });
    expect(await store.list()).toHaveLength(1);
    expect(JSON.parse(await readFile(rulesPath(root), "utf8"))).toEqual({
      schemaVersion: 1,
      rules: [updated]
    });

    expect(await store.delete(created.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("migrates legacy rule arrays to schema-versioned storage on write", async () => {
    const root = await makeRoot();
    const store = new ArchitectureRuleStore(rulesPath(root));
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(
      rulesPath(root),
      JSON.stringify([
        {
          id: "rule_legacy",
          type: "required-test",
          name: "Legacy required test",
          enabled: true,
          severity: "warning",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z"
        }
      ])
    );

    await store.update("rule_legacy", { message: "Keep legacy rules migratable." });
    expect(JSON.parse(await readFile(rulesPath(root), "utf8"))).toMatchObject({
      schemaVersion: 1,
      rules: [expect.objectContaining({ id: "rule_legacy", message: "Keep legacy rules migratable." })]
    });
  });

  it("reports import, dependency, test, SQL, and marketplace architecture findings", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src", "ui"), { recursive: true });
    await mkdir(join(root, "src", "server"), { recursive: true });
    await mkdir(join(root, "supabase", "migrations"), { recursive: true });
    await mkdir(join(root, ".agents", "plugins"), { recursive: true });
    await writeFile(join(root, "src", "ui", "page.ts"), "import { queryDb } from '../server/db'; export const page = queryDb;");
    await writeFile(join(root, "src", "server", "db.ts"), "export const queryDb = true;");
    await writeFile(
      join(root, "supabase", "migrations", "001_accounts.sql"),
      "create table public.accounts (id uuid primary key, tenant_id uuid); grant select on public.accounts to anon;"
    );
    await writeFile(
      join(root, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        plugins: [
          {
            name: "tokengraph",
            source: { source: "local", path: "./plugins/tokengraph" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }
          }
        ]
      })
    );
    const project = await indexProject(root);
    const store = new ArchitectureRuleStore(rulesPath(root));
    await store.add({
      type: "forbidden-import",
      name: "UI cannot import server",
      fromPattern: "^src/ui/",
      targetPattern: "^src/server/",
      severity: "error"
    });
    await store.add({
      type: "dependency-direction",
      name: "UI should only import client modules",
      fromPattern: "^src/ui/",
      allowedTargetPattern: "^src/client/",
      severity: "warning"
    });
    await store.add({
      type: "required-test",
      name: "Server modules need direct tests",
      modulePattern: "^src/server/db\\.ts$",
      testPattern: "^src/server/db\\.test\\.ts$",
      severity: "warning"
    });

    const report = await checkArchitecture({
      root,
      project,
      rules: await store.list(),
      files: ["src/server/db.ts"]
    });

    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "forbidden-import",
          ruleName: "UI cannot import server",
          filePath: "src/ui/page.ts",
          targetPath: "src/server/db.ts"
        })
      ])
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dependency-direction", ruleName: "UI should only import client modules" }),
        expect.objectContaining({ type: "required-test", filePath: "src/server/db.ts" }),
        expect.objectContaining({ type: "tenant-isolation", sqlObject: "public.accounts" }),
        expect.objectContaining({ type: "grant", sqlObject: "public.accounts" }),
        expect.objectContaining({ type: "marketplace-target", sourcePath: "./plugins/tokengraph" })
      ])
    );
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
    expect(exported.resourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "TokenGraph project map",
          mimeType: "text/vnd.mermaid"
        })
      ])
    );
    expect(exported.markdownFallback).toContain("```mermaid");
    expect(exported.markdownFallback).toContain("flowchart LR");
    expect(exported).not.toHaveProperty("imageContent");
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

    expect(exported.resourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "TokenGraph project map",
          mimeType: "application/json"
        })
      ])
    );
    expect(exported.markdownFallback).toContain("```json");
    expect(exported.markdownFallback).toContain("\"nodes\"");
    expect(parsed.nodes.map((node) => node.path)).toEqual(expect.arrayContaining(["app/patients/page.tsx", "components/PatientCard.tsx"]));
    expect(parsed.nodes.map((node) => node.path)).not.toContain("aaa/unconnected.ts");
  });
});
