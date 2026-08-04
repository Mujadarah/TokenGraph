import { describe, expect, it } from "vitest";

import { assertSafeArchitectureRulePatterns } from "../src/core/patternSafety.js";

describe("architecture pattern safety", () => {
  it("does not count caller event-loop delay as regex evaluation time", async () => {
    const validations = Array.from({ length: 24 }, () =>
      assertSafeArchitectureRulePatterns({ fromPattern: "^src/ui/" })
    );
    const blockedUntil = Date.now() + 400;
    while (Date.now() < blockedUntil) {
      // Simulate a loaded test or server process while the worker starts.
    }

    await expect(Promise.all(validations)).resolves.toEqual(Array(24).fill(undefined));
  });

  it("still rejects catastrophic regex evaluation", async () => {
    await expect(
      assertSafeArchitectureRulePatterns({ fromPattern: "^(a+)+$" })
    ).rejects.toThrow(/pattern evaluation exceeded the safety time limit/i);
  });
});
