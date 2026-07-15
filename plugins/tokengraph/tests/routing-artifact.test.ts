import { describe, expect, it } from "vitest";
import { artifactKey, createStableArtifact, shouldSuppressArtifact } from "../src/core/artifact.js";
import { canonicalHash, canonicalJson } from "../src/core/canonical.js";
import { adviseRouting } from "../src/core/routingAdvisor.js";
import { queryContextInputSchema, taskReportInputSchema } from "../src/core/toolContracts.js";

describe("canonical artifacts", () => {
  it("normalizes line endings and object key order", () => {
    expect(canonicalHash({ text: "a\r\nb", z: 1, a: 2 })).toBe(canonicalHash({ a: 2, z: 1, text: "a\nb" }));
    expect(canonicalJson({ z: 1, a: undefined, b: "x\r\ny" })).toBe('{"b":"x\\ny","z":1}');
  });

  it("creates stable ids and suppresses only exact known artifacts", () => {
    const first = createStableArtifact("brief/project", { z: 1, a: "x" });
    const reordered = createStableArtifact("brief/project", { a: "x", z: 1 });
    expect(first.hash).toBe(reordered.hash);
    expect(artifactKey(first)).toBe(`brief/project@${first.hash}`);
    expect(shouldSuppressArtifact(first, [artifactKey(first)])).toBe(true);
    expect(shouldSuppressArtifact(first, [`brief/other@${first.hash}`])).toBe(false);
    expect(shouldSuppressArtifact(first, [`brief/project@${"0".repeat(64)}`])).toBe(false);
    expect(shouldSuppressArtifact(first)).toBe(false);
  });
});

describe("routing advisor", () => {
  it("accepts routing inputs and bounded artifact/run query contracts", () => {
    expect(queryContextInputSchema.parse({ mode: "artifact", artifactHash: "a".repeat(64), knownArtifacts: ["id@hash"], routingOverride: "force-on" })).toMatchObject({ mode: "artifact" });
    expect(queryContextInputSchema.parse({ mode: "run", runId: "run-1", file: "src/a.ts" })).toMatchObject({ mode: "run", file: "src/a.ts" });
    expect(() => queryContextInputSchema.parse({ mode: "run", runId: "run-1", file: "a", test: "b" })).toThrow();
    expect(taskReportInputSchema.parse({ taskId: "task-1", routingOverride: "force-bypass" }).routingOverride).toBe("force-bypass");
  });

  it("keeps bounded lookup work in advisory Stage 0 by default", () => {
    const decision = adviseRouting({ task: "Where is the login handler?" });
    expect(decision.useTokenGraph).toBe(false);
    expect(decision.stage).toBe(0);
    expect(decision.enforced).toBe(false);
    expect(decision.reason).toBe("bounded-task");
  });

  it("activates discovery work and escalates to Stage 1 with a fresh index", () => {
    const discovery = adviseRouting({ task: "Trace the architecture and dependencies for this change" });
    expect(discovery.useTokenGraph).toBe(true);
    expect(discovery.stage).toBe(0);
    const indexed = adviseRouting({ task: "Trace the architecture and dependencies for this change", indexAvailable: true });
    expect(indexed.stage).toBe(1);
    expect(indexed.expectedBenefit).toBeGreaterThan(discovery.expectedBenefit);
  });

  it("honors force overrides and configured routing modes", () => {
    expect(adviseRouting({ task: "Where is x?", routingOverride: "force-on" }).useTokenGraph).toBe(true);
    expect(adviseRouting({ task: "Trace architecture", routingOverride: "force-bypass" }).useTokenGraph).toBe(false);
    expect(adviseRouting({ task: "Where is x?", routingMode: "always-activate" }).enforced).toBe(false);
    expect(adviseRouting({ task: "Where is x?", routingMode: "always-activate", promotion: { enforcementEnabled: true } }).enforced).toBe(true);
    expect(adviseRouting({ task: "Trace architecture", routingMode: "always-advisory" }).enforced).toBe(false);
    expect(adviseRouting({ task: "Trace architecture", killSwitch: true }).useTokenGraph).toBe(false);
    expect(adviseRouting({ task: "Trace architecture", killSwitch: true }).reason).toBe("routing kill switch");
  });
});
