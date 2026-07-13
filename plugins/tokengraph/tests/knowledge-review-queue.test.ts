import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __getKnowledgeReviewQueueSizeForTests,
  listAppliedKnowledge,
  listKnowledgeSuggestions,
  proposeKnowledgeChange,
  reviewKnowledgeSuggestion
} from "../src/core/knowledgeReviewQueue.js";
import type { KnowledgeProposalInput, KnowledgeSuggestion } from "../src/core/knowledgeReviewQueue.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokengraph-review-queue-"));
  roots.push(root);
  return root;
}

function proposal(overrides: Partial<KnowledgeProposalInput> = {}): KnowledgeProposalInput {
  return {
    type: "wiki",
    title: "Document the request flow",
    rationale: "The indexed routes and services describe a stable request flow.",
    proposedContent: "Requests enter through the route and call the patient service.",
    sourceFingerprints: ["sha256:route", "sha256:service"],
    affectedIdentifiers: ["architecture/request-flow"],
    sources: [
      { kind: "id", sourceId: "route-source", fingerprint: "route-source-v1" },
      { kind: "id", sourceId: "service-contract", fingerprint: "service-source-v1" }
    ],
    affectedTargets: {
      wikiPages: ["architecture/request-flow"],
      memories: [],
      skills: []
    },
    conflictNotes: ["Legacy request flow documentation names a removed handler."],
    expiresAt: "2099-07-13T10:00:00.000Z",
    ...overrides
  };
}

function queuePath(root: string): string {
  return join(root, ".tokengraph", "review-queue.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("knowledge review queue", () => {
  it("persists a schema-versioned proposed suggestion with a UUID", async () => {
    const root = await makeRoot();
    const suggestion = await proposeKnowledgeChange(root, proposal());

    expect(suggestion).toMatchObject({
      type: "wiki",
      status: "proposed",
      title: "Document the request flow",
      sourceFingerprints: ["sha256:route", "sha256:service"],
      affectedIdentifiers: ["architecture/request-flow"]
    });
    expect(suggestion.sources).toEqual([
      { kind: "id", sourceId: "route-source", fingerprint: "route-source-v1" },
      { kind: "id", sourceId: "service-contract", fingerprint: "service-source-v1" }
    ]);
    expect(suggestion.affectedTargets).toEqual({
      wikiPages: ["architecture/request-flow"], memories: [], skills: []
    });
    expect(suggestion.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(Date.parse(suggestion.createdAt)).not.toBeNaN();
    expect(suggestion.updatedAt).toBe(suggestion.createdAt);
    expect(JSON.parse(await readFile(queuePath(root), "utf8"))).toEqual({ schemaVersion: 2, suggestions: [suggestion] });
  });

  it("normalizes provenance deterministically without persisting machine-local paths", async () => {
    const root = await makeRoot();
    const first = await proposeKnowledgeChange(root, proposal({
      sources: [
        { kind: "id", sourceId: "service-contract", fingerprint: "service-source-v1" },
        { kind: "path", sourceId: "src\\request-flow.ts", fingerprint: "route-source-v1" }
      ]
    }));
    const duplicate = await proposeKnowledgeChange(root, proposal({
      sources: [
        { kind: "path", sourceId: "src/request-flow.ts", fingerprint: "route-source-v1" },
        { kind: "id", sourceId: "service-contract", fingerprint: "service-source-v1" }
      ]
    }));

    expect(duplicate.id).toBe(first.id);
    expect(first.sources).toEqual([
      { kind: "id", sourceId: "service-contract", fingerprint: "service-source-v1" },
      { kind: "path", sourceId: "src/request-flow.ts", fingerprint: "route-source-v1" }
    ]);
    expect(await readFile(queuePath(root), "utf8")).not.toContain("C:\\\\Users");
  });

  it.each(["../secret.ts", "/private/secret.ts", "C:\\private\\secret.ts"])(
    "rejects forged source path %s before creating state",
    async (sourceId) => {
      const root = await makeRoot();
      await expect(proposeKnowledgeChange(root, proposal({ sources: [{ kind: "path", sourceId, fingerprint: "v1" }] }))).rejects.toThrow(/source/i);
      expect(await readdir(root)).toEqual([]);
    }
  );

  it("applies an approved payload exactly once and persists the result across restarts", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "request-flow.ts"), "export const flow = 'v1';\r\n");
    const sourceFingerprint = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("export const flow = 'v1';\n").digest("hex")
    );
    const suggested = await proposeKnowledgeChange(root, proposal({
      sources: [{ kind: "path", sourceId: "src/request-flow.ts", fingerprint: sourceFingerprint }],
      expiresAt: "2099-07-13T10:00:00.000Z"
    }));

    const first = await reviewKnowledgeSuggestion(root, suggested.id, "approve", "Reviewed locally.");
    const firstSerialized = await readFile(join(root, ".tokengraph", "knowledge-applications.json"), "utf8");
    const repeated = await reviewKnowledgeSuggestion(root, suggested.id, "approve", "Ignored repeat reason.");

    expect(first.applicationStatus).toBe("applied");
    expect(repeated).toEqual(first);
    expect(await readFile(join(root, ".tokengraph", "knowledge-applications.json"), "utf8")).toBe(firstSerialized);
    expect(await listAppliedKnowledge(root)).toHaveLength(1);
    expect((await listAppliedKnowledge(root))[0]).toMatchObject({
      suggestionId: suggested.id,
      proposedContent: "Requests enter through the route and call the patient service.",
      affectedTargets: { wikiPages: ["architecture/request-flow"] }
    });
  });

  it("repairs a partial application record before marking its proposal approved", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal());
    const application = {
      suggestionId: suggested.id,
      fingerprint: suggested.fingerprint,
      type: suggested.type,
      title: suggested.title,
      rationale: suggested.rationale,
      proposedContent: suggested.proposedContent,
      sources: suggested.sources,
      affectedTargets: suggested.affectedTargets,
      conflictNotes: suggested.conflictNotes,
      appliedAt: "2026-07-13T10:00:00.000Z"
    };
    await writeFile(
      join(root, ".tokengraph", "knowledge-applications.json"),
      `${JSON.stringify({ schemaVersion: 1, applications: [application] }, null, 2)}\n`
    );

    const result = await reviewKnowledgeSuggestion(root, suggested.id, "approve");
    expect(result).toMatchObject({ applicationStatus: "applied", application: { appliedAt: application.appliedAt } });
    await expect(readFile(join(
      root, ".tokengraph", "knowledge", "wiki", "architecture", "request-flow", `${suggested.id}.md`
    ), "utf8")).resolves.toContain(suggested.proposedContent);
  });

  it("cannot reject after an application record exists and keeps partial records inactive", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal());
    const application = {
      suggestionId: suggested.id, fingerprint: suggested.fingerprint, type: suggested.type,
      title: suggested.title, rationale: suggested.rationale, proposedContent: suggested.proposedContent,
      sources: suggested.sources, affectedTargets: suggested.affectedTargets, conflictNotes: suggested.conflictNotes,
      appliedAt: suggested.updatedAt
    };
    await writeFile(join(root, ".tokengraph", "knowledge-applications.json"), `${JSON.stringify({ schemaVersion: 1, applications: [application] }, null, 2)}\n`);

    expect(await listAppliedKnowledge(root)).toEqual([]);
    await expect(reviewKnowledgeSuggestion(root, suggested.id, "reject")).rejects.toThrow(/application.*approv|approv.*application/i);
    expect(await listKnowledgeSuggestions(root)).toMatchObject([{ id: suggested.id, status: "proposed" }]);
  });

  it("quarantines duplicate application ids instead of rendering them twice", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal());
    const application = {
      suggestionId: suggested.id, fingerprint: suggested.fingerprint, type: suggested.type,
      title: suggested.title, rationale: suggested.rationale, proposedContent: suggested.proposedContent,
      sources: suggested.sources, affectedTargets: suggested.affectedTargets, conflictNotes: suggested.conflictNotes,
      appliedAt: suggested.updatedAt
    };
    await writeFile(join(root, ".tokengraph", "knowledge-applications.json"), `${JSON.stringify({ schemaVersion: 1, applications: [application, application] })}\n`);
    expect(await listAppliedKnowledge(root)).toEqual([]);
    expect((await readdir(join(root, ".tokengraph"))).some((file) => file.startsWith("knowledge-applications.json.corrupt-"))).toBe(true);
  });

  it("recovers target files written before the application store using a deterministic timestamp", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal());
    const target = join(root, ".tokengraph", "knowledge", "wiki", "architecture", "request-flow", `${suggested.id}.md`);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, [
      "---", `suggestion_id: "${suggested.id}"`, `title: ${JSON.stringify(suggested.title)}`,
      `applied_at: "${suggested.updatedAt}"`, "---", "", suggested.proposedContent, ""
    ].join("\n"));

    const result = await reviewKnowledgeSuggestion(root, suggested.id, "approve");
    expect(result).toMatchObject({ applicationStatus: "applied", application: { appliedAt: suggested.updatedAt } });
  });

  it("rejects a forged partial application whose payload differs from the reviewed proposal", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal());
    await writeFile(
      join(root, ".tokengraph", "knowledge-applications.json"),
      `${JSON.stringify({ schemaVersion: 1, applications: [{
        suggestionId: suggested.id,
        fingerprint: suggested.fingerprint,
        type: suggested.type,
        title: suggested.title,
        rationale: suggested.rationale,
        proposedContent: "forged content",
        sources: suggested.sources,
        affectedTargets: suggested.affectedTargets,
        conflictNotes: suggested.conflictNotes,
        appliedAt: "2026-07-13T10:00:00.000Z"
      }] }, null, 2)}\n`
    );

    expect(await listAppliedKnowledge(root)).toEqual([]);
    await expect(reviewKnowledgeSuggestion(root, suggested.id, "approve")).rejects.toThrow(/application.*match|match.*proposal/i);
    expect(await listKnowledgeSuggestions(root)).toMatchObject([{ id: suggested.id, status: "proposed" }]);
  });

  it("rejects a derived target directory that resolves outside the workspace", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await mkdir(join(root, ".tokengraph", "knowledge", "wiki"), { recursive: true });
    await symlink(outside, join(root, ".tokengraph", "knowledge", "wiki", "architecture"), "junction");
    const suggested = await proposeKnowledgeChange(root, proposal());

    await expect(reviewKnowledgeSuggestion(root, suggested.id, "approve")).rejects.toThrow(/workspace|outside|confined/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it("migrates an approved schema-v1 proposal into one durable application", async () => {
    const root = await makeRoot();
    const legacyInput = proposal();
    const createdAt = "2026-07-01T10:00:00.000Z";
    const fingerprint = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(JSON.stringify({
      type: legacyInput.type, title: legacyInput.title, proposedContent: legacyInput.proposedContent,
      sourceFingerprints: legacyInput.sourceFingerprints.slice().sort(), affectedIdentifiers: legacyInput.affectedIdentifiers
    })).digest("hex"));
    const id = crypto.randomUUID();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(queuePath(root), JSON.stringify({ schemaVersion: 1, suggestions: [{
      id, fingerprint, type: legacyInput.type, status: "approved", title: legacyInput.title,
      rationale: legacyInput.rationale, proposedContent: legacyInput.proposedContent,
      sourceFingerprints: legacyInput.sourceFingerprints, affectedIdentifiers: legacyInput.affectedIdentifiers,
      createdAt, updatedAt: createdAt, reviewedAt: createdAt
    }] }));

    await expect(reviewKnowledgeSuggestion(root, id, "approve")).resolves.toMatchObject({ applicationStatus: "applied" });
    expect(await listAppliedKnowledge(root)).toHaveLength(1);
  });

  it("does not recover approved schema-v1 or schema-v2 records after expiry", async () => {
    const legacyRoot = await makeRoot();
    const input = proposal();
    const old = "2020-01-01T00:00:00.000Z";
    const legacyFingerprint = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(JSON.stringify({
      type: input.type, title: input.title, proposedContent: input.proposedContent,
      sourceFingerprints: input.sourceFingerprints.slice().sort(), affectedIdentifiers: input.affectedIdentifiers
    })).digest("hex"));
    const legacyId = crypto.randomUUID();
    await mkdir(join(legacyRoot, ".tokengraph"), { recursive: true });
    await writeFile(queuePath(legacyRoot), JSON.stringify({ schemaVersion: 1, suggestions: [{
      id: legacyId, fingerprint: legacyFingerprint, type: input.type, status: "approved", title: input.title,
      rationale: input.rationale, proposedContent: input.proposedContent, sourceFingerprints: input.sourceFingerprints,
      affectedIdentifiers: input.affectedIdentifiers, createdAt: old, updatedAt: old, reviewedAt: old
    }] }));
    await expect(reviewKnowledgeSuggestion(legacyRoot, legacyId, "approve")).rejects.toThrow(/expired/i);

    const currentRoot = await makeRoot();
    const current = await proposeKnowledgeChange(currentRoot, proposal());
    await writeFile(queuePath(currentRoot), `${JSON.stringify({ schemaVersion: 2, suggestions: [{
      ...current, status: "approved", expiresAt: old, reviewedAt: current.updatedAt
    }] }, null, 2)}\n`);
    await expect(reviewKnowledgeSuggestion(currentRoot, current.id, "approve")).rejects.toThrow(/expired/i);
    expect(await listAppliedKnowledge(currentRoot)).toEqual([]);
  });

  it("does not mistake a stable source id containing path characters for a workspace file", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal({
      sources: [{ kind: "id", sourceId: "design/contracts/request-flow.v1", fingerprint: "stable-v1" }]
    }));
    await expect(reviewKnowledgeSuggestion(root, suggested.id, "approve")).resolves.toMatchObject({ applicationStatus: "applied" });
  });

  it("rejects a relative source path whose symlink escapes the workspace", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(join(root, "src"), { recursive: true });
    const secret = join(outside, "secret.ts");
    await writeFile(secret, "private source\n");
    await symlink(secret, join(root, "src", "linked.ts"), "file");
    const fingerprint = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("private source\n").digest("hex")
    );
    const suggested = await proposeKnowledgeChange(root, proposal({
      sources: [{ kind: "path", sourceId: "src/linked.ts", fingerprint }]
    }));

    await expect(reviewKnowledgeSuggestion(root, suggested.id, "approve")).rejects.toThrow(/workspace|outside|confined/i);
    expect(await listAppliedKnowledge(root)).toEqual([]);
  });

  it("rejects approval after expiry or source drift without applying the payload", async () => {
    const expiredRoot = await makeRoot();
    const expired = await proposeKnowledgeChange(expiredRoot, proposal({ expiresAt: "2000-01-01T00:00:00.000Z" }));
    await expect(reviewKnowledgeSuggestion(expiredRoot, expired.id, "approve")).rejects.toThrow(/expired/i);
    expect(await listKnowledgeSuggestions(expiredRoot)).toMatchObject([{ id: expired.id, status: "expired" }]);
    expect(await listAppliedKnowledge(expiredRoot)).toEqual([]);

    const staleRoot = await makeRoot();
    await mkdir(join(staleRoot, "src"), { recursive: true });
    await writeFile(join(staleRoot, "src", "request-flow.ts"), "changed\n");
    const stale = await proposeKnowledgeChange(staleRoot, proposal({
      sources: [{ kind: "path", sourceId: "src/request-flow.ts", fingerprint: "old-fingerprint" }]
    }));
    await expect(reviewKnowledgeSuggestion(staleRoot, stale.id, "approve")).rejects.toThrow(/stale|fingerprint/i);
    expect(await listAppliedKnowledge(staleRoot)).toEqual([]);
  });

  it("reject applies no derived knowledge", async () => {
    const root = await makeRoot();
    const suggested = await proposeKnowledgeChange(root, proposal());
    const result = await reviewKnowledgeSuggestion(root, suggested.id, "reject", "Conflicts with current architecture.");
    expect(result.applicationStatus).toBe("not-applied");
    expect(await listAppliedKnowledge(root)).toEqual([]);
  });

  it.each([
    ["absolute wiki path", proposal({ affectedIdentifiers: ["C:\\private\\overview"] })],
    ["absolute posix path", proposal({ affectedIdentifiers: ["/private/overview"] })],
    ["parent traversal", proposal({ affectedIdentifiers: ["../overview"] })],
    ["empty fingerprint list", proposal({ sourceFingerprints: [] })],
    ["blank fingerprint", proposal({ sourceFingerprints: [" "] })],
    ["invalid memory id", proposal({ type: "memory", affectedIdentifiers: ["../../memory.json"] })],
    ["skill path instead of name", proposal({ type: "skill", affectedIdentifiers: ["skills/reviewer"] })]
  ])("rejects %s before creating local state", async (_name, input) => {
    const root = await makeRoot();
    await expect(proposeKnowledgeChange(root, input)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects unknown runtime suggestion types", async () => {
    const root = await makeRoot();
    await expect(proposeKnowledgeChange(root, proposal({ type: "prompt" as "wiki" }))).rejects.toThrow(/type/i);
  });

  it("serializes proposal fields through a strict privacy allowlist", async () => {
    const root = await makeRoot();
    const unsafe = {
      ...proposal(),
      prompt: "private prompt",
      rawToolPayload: { apiKey: "secret" },
      absolutePath: "C:\\Users\\private\\secret.md"
    } as KnowledgeProposalInput;

    await proposeKnowledgeChange(root, unsafe);
    const serialized = await readFile(queuePath(root), "utf8");
    const stored = JSON.parse(serialized) as { suggestions: Array<Record<string, unknown>> };

    expect(Object.keys(stored.suggestions[0] ?? {}).sort()).toEqual([
      "affectedIdentifiers",
      "affectedTargets",
      "conflictNotes",
      "createdAt",
      "expiresAt",
      "fingerprint",
      "id",
      "proposedContent",
      "rationale",
      "sourceFingerprints",
      "sources",
      "status",
      "title",
      "type",
      "updatedAt"
    ]);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("C:\\\\Users");
  });

  it("returns the same active suggestion for an order-independent duplicate proposal", async () => {
    const root = await makeRoot();
    const first = await proposeKnowledgeChange(root, proposal());
    const duplicate = await proposeKnowledgeChange(
      root,
      proposal({
        sourceFingerprints: ["sha256:service", "sha256:route", "sha256:route"],
        affectedIdentifiers: ["architecture/request-flow", "architecture/request-flow"]
      })
    );

    expect(duplicate).toEqual(first);
    expect(await listKnowledgeSuggestions(root)).toEqual([first]);
  });

  it("reviews durably, is idempotent for the same decision, and rejects conflicts", async () => {
    const root = await makeRoot();
    const proposed = await proposeKnowledgeChange(root, proposal());
    const first = await reviewKnowledgeSuggestion(root, proposed.id, "approve", "Reviewed against the index.");
    const duplicate = await reviewKnowledgeSuggestion(root, proposed.id, "approve", "A different repeated reason is ignored.");

    expect(first).toMatchObject({
      applicationStatus: "applied",
      suggestion: { id: proposed.id, status: "approved", reviewReason: "Reviewed against the index." }
    });
    expect(first.suggestion.reviewedAt).toEqual(expect.any(String));
    expect(duplicate).toEqual(first);
    await expect(reviewKnowledgeSuggestion(root, proposed.id, "reject")).rejects.toThrow(/conflict/i);
  });

  it("rejects invalid ids, decisions, and expired suggestion reviews", async () => {
    const root = await makeRoot();
    await expect(reviewKnowledgeSuggestion(root, "../escape", "approve")).rejects.toThrow(/uuid/i);
    const suggestion = await proposeKnowledgeChange(root, proposal());
    await expect(reviewKnowledgeSuggestion(root, suggestion.id, "later" as "approve")).rejects.toThrow(/decision/i);

    const expired: KnowledgeSuggestion = { ...suggestion, status: "expired", updatedAt: "2026-07-13T10:00:00.000Z" };
    await writeFile(queuePath(root), `${JSON.stringify({ schemaVersion: 2, suggestions: [expired] }, null, 2)}\n`);
    await expect(reviewKnowledgeSuggestion(root, suggestion.id, "approve")).rejects.toThrow(/expired/i);
  });

  it("serializes concurrent proposals and reviews without losing updates, then cleans its queue", async () => {
    const root = await makeRoot();
    const proposals = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        proposeKnowledgeChange(
          root,
          proposal({ title: `Suggestion ${index}`, proposedContent: `Content ${index}`, sourceFingerprints: [`sha256:${index}`] })
        )
      )
    );
    await Promise.all(proposals.map((suggestion) => reviewKnowledgeSuggestion(root, suggestion.id, "reject", "Batch review")));

    const suggestions = await listKnowledgeSuggestions(root);
    expect(suggestions).toHaveLength(24);
    expect(suggestions.every((suggestion) => suggestion.status === "rejected")).toBe(true);
    expect(new Set(suggestions.map((suggestion) => suggestion.id))).toHaveLength(24);
    expect(__getKnowledgeReviewQueueSizeForTests()).toBe(0);
  });

  it.runIf(process.platform === "win32")("serializes concurrent proposals across Windows case-alias roots", async () => {
    const root = await makeRoot();
    const aliasRoot = root.toUpperCase();
    const settled = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        proposeKnowledgeChange(
          index % 2 === 0 ? root : aliasRoot,
          proposal({ title: `Alias suggestion ${index}`, proposedContent: `Alias content ${index}`, sourceFingerprints: [`alias:${index}`] })
        )
      )
    );

    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    expect(await listKnowledgeSuggestions(root)).toHaveLength(32);
    expect(__getKnowledgeReviewQueueSizeForTests()).toBe(0);
  });

  it("cleans the keyed write chain after a failed operation", async () => {
    const root = await makeRoot();
    await expect(reviewKnowledgeSuggestion(root, crypto.randomUUID(), "approve")).rejects.toThrow(/not found/i);
    expect(__getKnowledgeReviewQueueSizeForTests()).toBe(0);
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["unknown status", JSON.stringify({ schemaVersion: 1, suggestions: [{ status: "pending" }] })],
    [
      "extra persisted fields",
      JSON.stringify({
        schemaVersion: 1,
        suggestions: [
          {
            id: crypto.randomUUID(),
            fingerprint: "a".repeat(64),
            type: "wiki",
            status: "proposed",
            title: "Unsafe",
            rationale: "Unsafe persisted payload",
            proposedContent: "Content",
            sourceFingerprints: ["sha256:source"],
            affectedIdentifiers: ["overview"],
            createdAt: "2026-07-13T10:00:00.000Z",
            updatedAt: "2026-07-13T10:00:00.000Z",
            rawPrompt: "secret"
          }
        ]
      })
    ]
  ])("quarantines %s and returns an empty usable queue", async (_name, contents) => {
    const root = await makeRoot();
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    await writeFile(queuePath(root), contents);

    expect(await listKnowledgeSuggestions(root)).toEqual([]);
    const files = await readdir(join(root, ".tokengraph"));
    expect(files.some((file) => file.startsWith("review-queue.json.corrupt-"))).toBe(true);
    const suggestion = await proposeKnowledgeChange(root, proposal());
    expect(await listKnowledgeSuggestions(root)).toEqual([suggestion]);
  });

  it("quarantines invalid UUIDs and timestamps in otherwise shaped persisted entries", async () => {
    const root = await makeRoot();
    const suggestion = await proposeKnowledgeChange(root, proposal());
    await writeFile(
      queuePath(root),
      JSON.stringify({ schemaVersion: 1, suggestions: [{ ...suggestion, id: "not-a-uuid", updatedAt: "not-a-date" }] })
    );
    expect(await listKnowledgeSuggestions(root)).toEqual([]);
    expect((await readdir(join(root, ".tokengraph"))).some((file) => file.startsWith("review-queue.json.corrupt-"))).toBe(true);
  });

  it("lists suggestions in stable creation order with type and status filters", async () => {
    const root = await makeRoot();
    const wiki = await proposeKnowledgeChange(root, proposal());
    const memory = await proposeKnowledgeChange(
      root,
      proposal({
        type: "memory",
        title: "Remember tenant isolation",
        proposedContent: "Tenant-scoped reads require tenant_id.",
        sourceFingerprints: ["sha256:policy"],
        affectedIdentifiers: ["mem_tenant_isolation"]
      })
    );
    const skill = await proposeKnowledgeChange(
      root,
      proposal({
        type: "skill",
        title: "Update security reviewer",
        proposedContent: "Check tenant predicates.",
        sourceFingerprints: ["sha256:skill"],
        affectedIdentifiers: ["security-reviewer"]
      })
    );
    await reviewKnowledgeSuggestion(root, memory.id, "reject");

    expect((await listKnowledgeSuggestions(root, { type: "wiki" })).map(({ id }) => id)).toEqual([wiki.id]);
    expect((await listKnowledgeSuggestions(root, { status: "rejected" })).map(({ id }) => id)).toEqual([memory.id]);
    expect((await listKnowledgeSuggestions(root, { type: ["wiki", "skill"], status: ["proposed"] })).map(({ id }) => id)).toEqual([
      wiki.id,
      skill.id
    ]);
  });
});
