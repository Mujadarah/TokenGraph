import { describe, expect, it } from "vitest";
import { evaluateFormatExperiment, serializeResponseFormat } from "../src/core/formatExperiment.js";

describe("response format experiment", () => {
  it("keeps JSON as default when tabular loses quality", () => {
    const observations = [
      { id: "one", fields: { path: "src/a.ts", reason: "read\nfirst", optional: "" }, requiredFields: ["path", "reason"] },
      { id: "two", fields: { path: "src/b.ts", reason: "test", optional: "" }, requiredFields: ["path", "reason"] }
    ];
    const result = evaluateFormatExperiment(observations);
    expect(result.defaultFormat).toBe("json");
    expect(result.tabularQuality).toBeLessThanOrEqual(result.jsonQuality);
    expect(serializeResponseFormat(observations, "tabular")).toContain("path\treason");
  });
});
