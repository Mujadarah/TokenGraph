import { createHash } from "node:crypto";
import { access, copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  executeRun,
  loadRun,
  purgeRuns,
  querySavedRuns,
  saveRun,
  summarizeRun,
  taskOutcomeFromRun
} from "../src/core/runner.js";

async function withProcessPath<T>(value: string, action: () => Promise<T>): Promise<T> {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const original = process.env[key];
  process.env[key] = value;
  try {
    return await action();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

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

  it("redacts paired arguments and bounded credential forms from runs, persistence, and task summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-redaction-"));
    const secrets = {
      paired: "paired-password-value",
      environment: "sk-proj-environment-token-1234567890",
      inline: "inline-api-key-value",
      header: "header-bearer-value",
      cookie: "cookie-session-value",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJydW5uZXIifQ.signature0123456789",
      url: "url-password-value",
      privateKey: "private-key-body-value",
      npm: "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      slack: ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
      github: ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"),
      openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      aws: "AKIAIOSFODNN7EXAMPLE",
      opaque: "opaque-credential-material",
      metadata: "metadata-bearer-value"
    };
    const ordinaryHash = "a".repeat(64);
    const output = [
      `FAIL Authorization: Bearer ${secrets.header}`,
      `Cookie: session=${secrets.cookie}`,
      secrets.jwt,
      `https://runner:${secrets.url}@example.test/private`,
      `-----BEGIN PRIVATE KEY-----\n${secrets.privateKey}\n-----END PRIVATE KEY-----`,
      secrets.npm,
      secrets.slack,
      secrets.github,
      secrets.openai,
      secrets.aws,
      `credential material follows ${secrets.opaque}`,
      ordinaryHash
    ].join("\n");

    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.RUNNER_TEST_OUTPUT ?? '')",
          "--",
          "--password",
          secrets.paired,
          "OPENAI_API_KEY",
          secrets.environment,
          `--api-key=${secrets.inline}`,
          "--header",
          `Authorization: Bearer ${secrets.header}`
        ],
        env: { RUNNER_TEST_OUTPUT: output },
        metadata: { test: `Authorization: Bearer ${secrets.metadata}` }
      });
      await saveRun(root, run);

      const persisted = JSON.parse(await readFile(join(root, ".tokengraph", "runs", `${run.runId}.json`), "utf8"));
      const summary = summarizeRun(run);
      const outcome = taskOutcomeFromRun(run, "task-redaction", {
        repositoryId: "repo",
        repositoryFingerprint: "fingerprint",
        workspaceId: "workspace",
        worktreeId: "worktree",
        branch: "branch",
        headCommit: "commit"
      });
      const surfaces = JSON.stringify({ run, persisted, summary, outcome });

      for (const secret of Object.values(secrets)) expect(surfaces).not.toContain(secret);
      expect(run.args).toEqual(expect.arrayContaining([
        "--password",
        "[REDACTED]",
        "OPENAI_API_KEY",
        "--api-key=[REDACTED]",
        "--header",
        "Authorization: [REDACTED]"
      ]));
      expect(run.stdout).toContain(ordinaryHash);
      expect(run.stdout).not.toContain("credential material follows");
      expect(run.redaction).toMatchObject({
        categories: expect.arrayContaining([
          "sensitive-argument",
          "authorization-header",
          "cookie-header",
          "jwt",
          "url-credentials",
          "private-key",
          "service-token",
          "aws-access-key",
          "credential-line"
        ]),
        withheldLineCount: expect.any(Number)
      });
      expect(run.redaction?.withheldLineCount).toBeGreaterThan(0);
      expect(persisted.redaction).toEqual(run.redaction);
      expect(summary.redaction).toEqual(run.redaction);
      expect((await loadRun(root, run.runId))?.redaction).toEqual(run.redaction);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts every field of non-Basic/Bearer authorization headers before any surface can retain it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-digest-auth-"));
    const digestSecret = "digest-response-secret-value";
    try {
      const output = `Authorization: Digest username="runner", realm="private", nonce="nonce-value", response="${digestSecret}"`;
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.RUNNER_DIGEST_HEADER ?? '')"],
        env: { RUNNER_DIGEST_HEADER: output }
      });
      await saveRun(root, run);
      const persisted = await readFile(join(root, ".tokengraph", "runs", `${run.runId}.json`), "utf8");
      const surfaces = JSON.stringify({ run, persisted, summary: summarizeRun(run) });

      expect(surfaces).not.toContain(digestSecret);
      expect(run.stdout).toBe("Authorization: [REDACTED]");
      expect(run.redaction?.categories).toContain("authorization-header");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("withholds a private-key body when bounded capture truncates before its END marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-truncated-key-"));
    const privateKeyBody = "b3BhcXVlS2V5Qm9keVZhbHVlMTIzNDU2Nzg5";
    const output = `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n${"A".repeat(400)}\n-----END PRIVATE KEY-----`;
    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.RUNNER_PRIVATE_KEY ?? '')"],
        env: { RUNNER_PRIVATE_KEY: output },
        maxBytes: 256
      });
      await saveRun(root, run);
      const persisted = await readFile(join(root, ".tokengraph", "runs", `${run.runId}.json`), "utf8");
      const surfaces = JSON.stringify({ run, persisted, summary: summarizeRun(run) });

      expect(surfaces).not.toContain(privateKeyBody);
      expect(run.stdout).toContain("[REDACTED PRIVATE KEY]");
      expect(run.stdoutTruncated).toBe(true);
      expect(run.redaction?.categories).toContain("private-key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts opaque values for sensitive custom header names in paired and inline arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-custom-header-"));
    const githubSecret = "opaque-github-header-secret";
    const privateSecret = "opaque-private-header-secret";
    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: [
          "-e",
          "process.exit(0)",
          "--",
          "--header",
          `X-GitHub-Token: ${githubSecret}`,
          `--header=Private-Token: ${privateSecret}`
        ]
      });
      await saveRun(root, run);
      const persisted = await readFile(join(root, ".tokengraph", "runs", `${run.runId}.json`), "utf8");
      const outcome = taskOutcomeFromRun(run, "task-custom-header", {
        repositoryId: "repo",
        repositoryFingerprint: "fingerprint",
        workspaceId: "workspace",
        worktreeId: "worktree",
        branch: "branch",
        headCommit: "commit"
      });
      const surfaces = JSON.stringify({ run, persisted, outcome });

      expect(surfaces).not.toContain(githubSecret);
      expect(surfaces).not.toContain(privateSecret);
      expect(run.args).toEqual(expect.arrayContaining([
        "--header",
        "X-GitHub-Token: [REDACTED]",
        "--header=Private-Token: [REDACTED]"
      ]));
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

  it.skipIf(process.platform === "win32")("kills a SIGTERM-resistant grandchild process group before it can write after timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-process-group-"));
    const sentinel = join(root, "grandchild-survived.txt");
    const grandchild = [
      "const { writeFileSync } = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      `setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'survived'), 600)`,
      "setTimeout(() => {}, 5000)"
    ].join(";");
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      "setTimeout(() => {}, 5000)"
    ].join(";");
    try {
      const startedAt = Date.now();
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", parent],
        timeoutMs: 250,
        terminateGraceMs: 100
      });
      expect(run.status).toBe("timed-out");
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await delay(750);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("kills descendants after the direct child exits but inherited streams remain open", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-exited-parent-"));
    const sentinel = join(root, "exited-parent-grandchild-survived.txt");
    const grandchild = [
      "const { writeFileSync } = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      `setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'survived'), 450)`,
      "setTimeout(() => process.exit(0), 700)"
    ].join(";");
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', process.stdout, process.stderr] })`,
      "process.exit(0)"
    ].join(";");
    try {
      const startedAt = Date.now();
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", parent],
        timeoutMs: 150,
        terminateGraceMs: 100
      });
      expect(run.status).toBe("timed-out");
      expect(Date.now() - startedAt).toBeLessThan(600);
      await delay(500);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("cancels descendants after the direct child exits but inherited streams remain open", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-exited-parent-cancel-"));
    const sentinel = join(root, "cancelled-grandchild-survived.txt");
    const grandchild = [
      "const { writeFileSync } = require('node:fs')",
      "process.on('SIGTERM', () => {})",
      `setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'survived'), 450)`,
      "setTimeout(() => process.exit(0), 700)"
    ].join(";");
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', process.stdout, process.stderr] })`,
      "process.exit(0)"
    ].join(";");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 150);
    try {
      const startedAt = Date.now();
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", parent],
        terminateGraceMs: 100
      }, controller.signal);
      expect(run.status).toBe("cancelled");
      expect(Date.now() - startedAt).toBeLessThan(600);
      await delay(500);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      clearTimeout(abortTimer);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("rejects when Windows taskkill cannot be spawned", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-taskkill-spawn-"));
    try {
      await withProcessPath(root, async () => {
        const startedAt = Date.now();
        await expect(executeRun({
          root,
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
          timeoutMs: 20,
          terminateGraceMs: 100
        })).rejects.toThrow(/taskkill|ENOENT/i);
        expect(Date.now() - startedAt).toBeLessThan(2_500);
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.runIf(process.platform === "win32")("rejects a nonzero Windows taskkill escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-taskkill-exit-"));
    try {
      await copyFile(process.execPath, join(root, "taskkill.exe"));
      await withProcessPath(root, async () => {
        const startedAt = Date.now();
        await expect(executeRun({
          root,
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
          timeoutMs: 20,
          terminateGraceMs: 100
        })).rejects.toThrow(/taskkill.*exit code/i);
        expect(Date.now() - startedAt).toBeLessThan(2_500);
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("withholds binary stdout while preserving its byte count, hash, truncation, and safe stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-binary-stdout-"));
    const bytes = Buffer.concat([Buffer.from([65, 0, 66]), Buffer.alloc(400, 120)]);
    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])})); process.stderr.write('safe sibling')`],
        maxBytes: 256
      });
      expect(run).toMatchObject({
        status: "failed",
        stdout: "",
        stderr: "safe sibling",
        stdoutBytes: bytes.length,
        stdoutSha256: createHash("sha256").update(bytes).digest("hex"),
        stdoutBinary: true,
        stderrBinary: false,
        stdoutTruncated: true
      });

      await saveRun(root, run);
      const savedText = await readFile(join(root, ".tokengraph", "runs", `${run.runId}.json`), "utf8");
      expect(savedText).not.toContain("\\u0000");
      expect(JSON.parse(savedText)).toMatchObject({ stdout: "", stdoutBytes: bytes.length, stdoutBinary: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("withholds only binary stderr and preserves a safe textual stdout sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-binary-stderr-"));
    const bytes = Buffer.from([101, 114, 114, 0, 111, 114]);
    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", `process.stdout.write('safe stdout'); process.stderr.write(Buffer.from(${JSON.stringify([...bytes])}))`]
      });
      expect(run).toMatchObject({
        status: "failed",
        stdout: "safe stdout",
        stderr: "",
        stderrBytes: bytes.length,
        stderrSha256: createHash("sha256").update(bytes).digest("hex"),
        stdoutBinary: false,
        stderrBinary: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes and counts every observed text byte before bounded truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-truncation-"));
    const output = "x".repeat(600);
    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        maxBytes: 256
      });
      expect(run).toMatchObject({
        status: "completed",
        stdoutBytes: Buffer.byteLength(output),
        stdoutSha256: createHash("sha256").update(output).digest("hex"),
        stdoutBinary: false,
        stdoutTruncated: true
      });
      expect(run.stdout).toContain("[truncated]");
      expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("infers exact selectors for failed CLI-style captures", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-runner-"));
    try {
      const run = await executeRun({
        root,
        command: process.execPath,
        args: ["-e", "console.error('TypeError: boom at src/example.ts:7:3'); process.exit(1)"]
      });
      expect(run.metadata).toEqual({ file: "src/example.ts", errorClass: "TypeError" });
      await saveRun(root, run);
      expect(await querySavedRuns(root, { file: "src/example.ts" })).toHaveLength(1);
      expect(await querySavedRuns(root, { errorClass: "TypeError" })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
