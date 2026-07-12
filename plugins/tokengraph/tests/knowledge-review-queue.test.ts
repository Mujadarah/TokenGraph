import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __getKnowledgeReviewQueueSizeForTests,
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
    expect(suggestion.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(Date.parse(suggestion.createdAt)).not.toBeNaN();
    expect(suggestion.updatedAt).toBe(suggestion.createdAt);
    expect(JSON.parse(await readFile(queuePath(root), "utf8"))).toEqual({ schemaVersion: 1, suggestions: [suggestion] });
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
      "createdAt",
      "fingerprint",
      "id",
      "proposedContent",
      "rationale",
      "sourceFingerprints",
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
      applicationStatus: "pending",
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
    await writeFile(queuePath(root), `${JSON.stringify({ schemaVersion: 1, suggestions: [expired] }, null, 2)}\n`);
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
