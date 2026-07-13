import { describe, expect, it } from "vitest";

import {
  compactCompressionResponse,
  compactFailureResponse,
  compactPlanResponse,
  compactRecallResponse,
  compactRiskResponse,
  compactWikiResponse
} from "../src/core/compactResponses.js";
import { estimateTokens } from "../src/core/token.js";

const constraints = ["Must preserve this exact user constraint."];

describe("compact MCP response projections", () => {
  it("projects plans into an actionable compact response with verbatim constraints", () => {
    const verbose = {
      task: "Change patient service migration",
      taskType: "feature",
      profile: "balanced",
      budget: { allowRawReads: true },
      relevantFiles: [
        { path: "services/patientService.ts", reason: "Matches task terms in module graph data.", score: 20 },
        { path: "src/unrelated.ts", reason: "Weak match.", score: 1 }
      ],
      relevantTests: [{ path: "services/patientService.test.ts", reason: "Matches focused test terms.", score: 10 }],
      relevantSql: [{ filePath: "supabase/migrations/001_patients.sql", kind: "policy", name: "tenant", reason: "Matched tenant policy.", score: 8 }],
      relevantMemories: [{ id: "mem", title: "Tenant warning", confidence: "high", body: "bulky private body" }],
      recommendedFirstReads: [{ path: "services/patientService.ts", reason: "Matches task terms in module graph data.", score: 20 }],
      filesToAvoid: Array.from({ length: 20 }, (_, index) => ({ path: `avoid-${index}.ts`, reason: "No overlap", score: 0 })),
      budgetExclusions: ["One lower-ranked file was excluded."],
      rawReadPolicy: "Read only targeted files after checking the compact scope.",
      estimatedTokens: { original: 500, compressed: 400, avoided: 100 }
    } as never;

    const compact = compactPlanResponse(verbose, { constraints });
    expect(compact).toEqual({
      constraints,
      files: [
        { path: "services/patientService.ts", reason: "Task match." },
        { path: "services/patientService.test.ts", reason: "Matches focused test terms." },
        { path: "supabase/migrations/001_patients.sql", reason: "Matched tenant policy." }
      ],
      firstReads: [0],
      tests: ["services/patientService.test.ts"],
      commands: ["pnpm test services/patientService.test.ts"],
      confidence: "high",
      warnings: ["One lower-ranked file was excluded."],
      rawReadGuidance: "Use targeted reads only when confidence or warnings require verification."
    });
    expect(estimateTokens(JSON.stringify(compact))).toBeLessThan(estimateTokens(JSON.stringify(verbose)) / 2);
    expect(JSON.stringify(compact)).not.toContain("bulky private body");
    expect(JSON.stringify(compact)).not.toContain("src/unrelated.ts");
    const verbatim = ["  Preserve indentation exactly.  "];
    expect(compactPlanResponse(verbose, { constraints: verbatim }).constraints).toEqual(verbatim);
  });

  it("does not project SQL into a non-database plan and keeps only the strongest SQL file for focused database work", () => {
    const basePlan = {
      task: "Update auditEvent usage in patientService", budget: { allowRawReads: true }, relevantFiles: [], relevantTests: [], recommendedFirstReads: [],
      relevantSql: [
        { filePath: "supabase/migrations/002_audit.sql", kind: "table", name: "audit_events", reason: "Audit match.", score: 12 },
        { filePath: "supabase/migrations/001_patients.sql", kind: "table", name: "patients", reason: "Weak tenant match.", score: 2 },
        { filePath: "supabase/migrations/003_inpatient.sql", kind: "table", name: "inpatient_archive", reason: "Similarly named but unrelated.", score: 20 }
      ], budgetExclusions: [], rawReadPolicy: "Targeted reads."
    } as never;
    expect(compactPlanResponse(basePlan).files).toEqual([]);
    const sqlPlan = { ...(basePlan as object), task: "Review audit_events SQL policy" } as never;
    expect(compactPlanResponse(sqlPlan).files.map((file) => file.path)).toEqual(["supabase/migrations/002_audit.sql"]);
    const patientPlan = { ...(basePlan as object), task: "Review patients SQL policy" } as never;
    expect(compactPlanResponse(patientPlan).files.map((file) => file.path)).toEqual(["supabase/migrations/001_patients.sql"]);
  });

  it("keeps correctness signals in failure, risk, and compression projections", () => {
    const failure = compactFailureResponse({
      recommendedFirstReads: [{ path: "src/auth.ts", reason: "Detected stack path.", score: 20 }],
      relatedFiles: [{ path: "src/unrelated.ts", reason: "Weak term overlap.", score: 1 }],
      detectedTests: ["src/auth.test.ts"],
      recommendedCommands: ["pnpm test src/auth.test.ts"], confidence: "low",
      hypotheses: [{ statement: "Authorization failed.", confidence: "low", evidence: ["src/auth.ts"] }]
    } as never, { constraints, allowRawReads: true });
    expect(failure).toMatchObject({ constraints, tests: ["src/auth.test.ts"], commands: ["pnpm test src/auth.test.ts"], confidence: "low" });
    expect(failure.warnings?.join(" ")).toMatch(/low confidence/i);
    expect(failure.rawReadGuidance).toMatch(/low confidence.*verify/i);
    expect(JSON.stringify(failure)).not.toContain("src/unrelated.ts");

    const risk = compactRiskResponse({
      riskLevel: "high", affectedFiles: [{ path: "src/auth.ts", reason: "Changed file.", score: 20 }],
      affectedTests: [{ path: "src/auth.test.ts", reason: "Affected test.", score: 10 }], affectedSql: [],
      recommendedTests: ["pnpm test src/auth.test.ts"], manualReviewWarnings: ["Review tenant isolation."], affectedRules: []
    } as never, { constraints });
    expect(risk).toMatchObject({ constraints, confidence: "high", warnings: ["Review tenant isolation."], tests: ["src/auth.test.ts"] });

    const compression = compactCompressionResponse({
      compressedTask: "Short task", preservedConstraints: ["Detected raw constraint"],
      recommendedFirstReads: [
        { path: "src/auth.ts", reason: "Matched context.", score: 10 },
        { path: "supabase/migrations/unrelated.sql", reason: "Weak context.", score: 2 }
      ],
      referencedMemories: [{ id: "mem", title: "Auth", confidence: "high", body: "omit" }], referencedWikiPages: [],
      omissions: ["3 lines omitted.", "Use a targeted raw read if needed."], confidence: "medium"
    } as never, { constraints });
    expect(compression.constraints).toEqual(constraints);
    expect(JSON.stringify(compression)).not.toContain("Detected raw constraint");
    expect(JSON.stringify(compression)).not.toContain("unrelated.sql");
    expect(compression).toMatchObject({ files: [{ path: "src/auth.ts", reason: "Matched context." }], firstReads: [0], confidence: "medium" });
  });

  it("keeps only equally best memory matches in the compact recall payload", () => {
    const recall = compactRecallResponse({
      query: "tenant policy", totalMemories: 3, policy: "Read only.",
      matches: [
        { id: "best-1", title: "Tenant policy", confidence: "high", action: "keep", reason: "Two terms.", score: 2 },
        { id: "best-2", title: "Tenant SQL", confidence: "high", action: "keep", reason: "Two terms.", score: 2 },
        { id: "weak", title: "Unrelated", confidence: "medium", action: "keep", reason: "One generic term.", score: 1 }
      ]
    } as never, { constraints }, [
      { id: "best-1", title: "Tenant policy", linkedFiles: ["src/auth.ts"] },
      { id: "best-2", title: "Tenant SQL", linkedFiles: ["src/auth.ts", "supabase/migrations/001.sql"] },
      { id: "weak", title: "Unrelated", linkedFiles: ["README.md"] }
    ] as never);
    expect(recall.memories.map((memory) => memory.id)).toEqual(["best-1", "best-2"]);
    expect(recall.files.map((file) => file.path)).toEqual(["src/auth.ts", "supabase/migrations/001.sql"]);
  });

  it("keeps compact recall/wiki evidence, conflicts, and fallback guidance", () => {
    const recall = compactRecallResponse({
      query: "tenant", totalMemories: 2, policy: "Review stale entries before reuse.",
      matches: [{ id: "mem-1", title: "Tenant policy", confidence: "low", action: "review", reason: "Stale evidence.", matchedTerms: ["tenant"], tags: [], createdAt: "x", type: "security", status: "active", score: 2 }]
    } as never, { constraints });
    expect(recall).toMatchObject({ constraints, confidence: "low", warnings: ["Review stale entries before reuse."], conflicts: ["Tenant policy: Stale evidence."] });

    const wiki = compactWikiResponse({
      fingerprint: "index", schemaVersion: 1,
      pages: [{ slug: "overview", title: "Overview", body: "very long body", estimatedTokens: 100, freshness: "stale", backlinks: ["structure"], contradictions: ["Old claim"] }]
    }, { constraints, allowRawReads: false });
    expect(wiki).toMatchObject({ constraints, confidence: "low", warnings: ["Wiki page overview is stale."], conflicts: ["overview: Old claim"] });
    expect(JSON.stringify(wiki)).not.toContain("very long body");
    expect(wiki.rawReadGuidance).toBe("Do not perform raw file reads; rely only on returned/indexed context and ask for an explicit policy change if evidence is insufficient.");
  });
});
