import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun, loadRun, purgeRuns, querySavedRuns, saveRun } from "../src/core/runner.js";

describe("bounded runner", () => {
  it("separates streams, removes ANSI, redacts before persistence, and compresses noisy logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-"));
    try {
      const run = await executeRun({ root, command: process.execPath, args: ["-e", "for(let i=0;i<20;i++) console.log('\\x1b[31msecret=bad\\x1b[0m'); console.error('api_key=hidden')"], maxBytes: 1024, metadata: { test: "runner-test" } });
      expect(run.status).toBe("completed");
      expect(run.stdout).not.toContain("\\u001b");
      expect(run.stdout).not.toContain("secret=bad");
      expect(run.stdout).toContain("repeated line");
      expect(run.stderr).toContain("[REDACTED]");
      await saveRun(root, run);
      expect(JSON.parse(await readFile(join(root, ".tokengraph", "runs", `${run.runId}.json`), "utf8"))).not.toMatchObject({ stdout: expect.stringContaining("secret=bad") });
      expect(await querySavedRuns(root, { test: "runner-test" })).toHaveLength(1);
      expect(await loadRun(root, run.runId)).toMatchObject({ runId: run.runId });
      expect(await purgeRuns(root, new Date(Date.now() + 1_000))).toEqual([run.runId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles timeout and refuses interactive commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-"));
    try {
      const run = await executeRun({ root, command: process.execPath, args: ["-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 30 });
      expect(run.status).toBe("timed-out");
      await expect(executeRun({ root, command: "ssh", args: ["host"] })).rejects.toThrow(/interactive/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
