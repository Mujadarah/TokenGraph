import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const RESULT_PATH = "artifacts/plugin-eval/scenario-result.json";
const TELEMETRY_PATH = ".tokengraph/telemetry/write-aggregates.json";
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_TELEMETRY_BYTES = 256 * 1024;
const MAX_TASK_LEDGER_BYTES = 8 * 1024 * 1024;
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const scenarios = Object.freeze({
  "trusted-setup-graph": {
    requiredFiles: [
      "plugins/tokengraph/src/server.ts",
      "plugins/tokengraph/src/core/toolContracts.ts",
      "plugins/tokengraph/tests/mcp-smoke.test.ts"
    ]
  },
  "indexing-race-recovery": {
    requiredFiles: [
      "plugins/tokengraph/src/core/projectIndexer.ts",
      "plugins/tokengraph/src/core/persistence.ts",
      "plugins/tokengraph/tests/index-generations-phase5.test.ts",
      "plugins/tokengraph/tests/indexing-foundations.test.ts"
    ],
    testArgs: ["test:activated", "--", "tests/index-generations-phase5.test.ts", "tests/indexing-foundations.test.ts", "--reporter=dot"]
  },
  "runner-failure-diagnosis": {
    requiredFiles: [
      "plugins/tokengraph/src/core/runner.ts",
      "plugins/tokengraph/src/core/taskLedger.ts",
      "plugins/tokengraph/tests/runner.test.ts"
    ],
    testArgs: ["test:activated", "--", "tests/runner.test.ts", "--reporter=dot"]
  },
  "local-change-capsule": {
    requiredFiles: [
      "plugins/tokengraph/src/core/changeSource.ts",
      "plugins/tokengraph/src/core/regressionRisk.ts",
      "plugins/tokengraph/tests/change-capsule.test.ts",
      "plugins/tokengraph/tests/fixtures/plugin-eval/change-capsule-input.ts"
    ],
    testArgs: ["test:activated", "--", "tests/change-capsule.test.ts", "--reporter=dot"],
    patchPath: "plugins/tokengraph/tests/fixtures/plugin-eval/change-capsule-input.ts",
    patchText: "export function benchmarkChangeCapsule(): string {\n  return \"after\";\n}\n"
  },
  "memory-knowledge-review": {
    requiredFiles: [
      "plugins/tokengraph/src/core/memoryStore.ts",
      "plugins/tokengraph/src/core/knowledgeReviewQueue.ts",
      "plugins/tokengraph/tests/knowledge-review-queue.test.ts",
      "plugins/tokengraph/tests/memory-store-phase4.test.ts"
    ],
    testArgs: ["test:activated", "--", "tests/knowledge-review-queue.test.ts", "tests/memory-store-phase4.test.ts", "--reporter=dot"]
  },
  "doctor-release-audit": {
    requiredFiles: [
      "plugins/tokengraph/src/core/doctor.ts",
      ".github/workflows/release.yml",
      "plugins/tokengraph/tests/release-workflow.test.ts",
      "plugins/tokengraph/scripts/validate-plugin.mjs"
    ],
    testArgs: ["test", "--", "--reporter=dot"]
  }
});

function fail(message) {
  throw new Error(`TokenGraph Plugin Eval verifier: ${message}`);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedSearchFingerprint(taskId, path) {
  return sha256(JSON.stringify({
    taskId,
    toolName: "tokengraph_query_context",
    category: "query-search",
    operation: { mode: "search", queryHash: sha256(path), limit: null }
  }));
}

function exactStringSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) fail(`${label} must be a string array.`);
  const normalized = [...new Set(actual)].sort();
  if (normalized.length !== actual.length) fail(`${label} must not contain duplicates.`);
  const required = [...expected].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(required)) fail(`${label} does not match the scenario contract.`);
}

function confinedPath(root, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) fail("a path is not a safe repository-relative path.");
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) fail("a path escaped the benchmark workspace.");
  return target;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-2_000);
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return (result.stdout ?? "").trim();
}

async function readBoundedJson(root, path, maxBytes, label) {
  const target = confinedPath(root, path);
  const stats = await lstat(target).catch(() => fail(`${label} is missing.`));
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) fail(`${label} is not a bounded regular file.`);
  const physicalRoot = await realpath(root);
  const physicalTarget = await realpath(target);
  const rel = relative(physicalRoot, physicalTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) fail(`${label} resolves outside the workspace.`);
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

async function verifyRequiredFiles(root, requiredFiles) {
  for (const path of requiredFiles) {
    const stats = await lstat(confinedPath(root, path)).catch(() => fail(`required file is missing: ${path}.`));
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`required file is not a regular file: ${path}.`);
  }
}

async function verifyCurrentTask(root, manifest, contract) {
  if (typeof manifest.taskId !== "string" || !TASK_ID_PATTERN.test(manifest.taskId)) fail("scenario result taskId is invalid.");
  const ledger = await readBoundedJson(
    root,
    `.tokengraph/tasks/${manifest.taskId}.json`,
    MAX_TASK_LEDGER_BYTES,
    "scenario task ledger"
  );
  if (ledger?.schemaId !== "tokengraph-task-ledger" || ledger.schemaVersion !== 3 || ledger.taskId !== manifest.taskId ||
      ledger.status !== "completed" || ledger.lastDisposition !== "complete" || !ledger.completedReport ||
      !Array.isArray(ledger.events) || !Array.isArray(ledger.deliveredArtifacts)) {
    fail("scenario task ledger is not a completed current TokenGraph task.");
  }
  const prepareEvents = ledger.events.filter((event) => event?.toolName === "tokengraph_prepare_context" && event.category === "context-routing");
  if (prepareEvents.length !== 1) fail("scenario task ledger must contain exactly one context preparation event.");
  const recalledFiles = contract.requiredFiles.filter((path) => ledger.events.some((event) =>
    event?.toolName === "tokengraph_query_context" && event.category === "query-search" &&
    event.fingerprint === expectedSearchFingerprint(manifest.taskId, path) &&
    Array.isArray(event.qualityChecks) && event.qualityChecks.some((check) =>
      check?.name === `search-result-file:${sha256(path)}` && check.passed === true
    )
  ));
  if (recalledFiles.length !== contract.requiredFiles.length) {
    fail("scenario task ledger lacks result-backed exact TokenGraph search evidence for a required file.");
  }
  return recalledFiles.length;
}

async function readTelemetry(root) {
  const telemetry = await readBoundedJson(root, TELEMETRY_PATH, MAX_TELEMETRY_BYTES, "write telemetry");
  if (telemetry?.schemaVersion !== 1 || !Array.isArray(telemetry.days)) fail("write telemetry has an unsupported schema.");
  let operationCount = 0;
  let logicalBytes = 0;
  let sampledPeakRssBytes = 0;
  for (const day of telemetry.days) {
    if (!day || !safeInteger(day.sampledPeakRssBytes) || !day.classes || typeof day.classes !== "object") fail("write telemetry contains an invalid day.");
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, day.sampledPeakRssBytes);
    for (const aggregate of Object.values(day.classes)) {
      if (!aggregate || !safeInteger(aggregate.operationCount) || !safeInteger(aggregate.logicalBytes)) fail("write telemetry contains an invalid class aggregate.");
      operationCount += aggregate.operationCount;
      logicalBytes += aggregate.logicalBytes;
      if (!safeInteger(operationCount) || !safeInteger(logicalBytes)) fail("write telemetry aggregate exceeds safe integer bounds.");
    }
  }
  if (operationCount < 1 || sampledPeakRssBytes < 1) fail("write telemetry does not contain bounded workspace aggregate evidence.");
  return { operationCount, logicalBytes, sampledPeakRssBytes };
}

async function main() {
  const root = resolve(process.cwd());
  const manifest = await readBoundedJson(root, RESULT_PATH, MAX_RESULT_BYTES, "scenario result");
  const contract = scenarios[manifest?.scenario];
  if (!contract || manifest.schemaVersion !== 2) fail("scenario result does not identify a configured scenario.");
  exactStringSet(manifest.requiredFiles, contract.requiredFiles, "requiredFiles");
  await verifyRequiredFiles(root, contract.requiredFiles);
  const recalledFileCount = await verifyCurrentTask(root, manifest, contract);

  run("git", ["diff", "--check"], root);
  const trackedStatus = run("git", ["status", "--porcelain=v1", "--untracked-files=no"], root);
  let patchCorrect = null;
  if (contract.patchPath) {
    if (manifest.patchCorrect !== true) fail("the patch scenario did not claim patch correctness.");
    const changed = run("git", ["diff", "--name-only", "--"], root).split(/\r?\n/).filter(Boolean);
    exactStringSet(changed, [contract.patchPath], "changed tracked paths");
    const text = (await readFile(confinedPath(root, contract.patchPath), "utf8")).replace(/\r\n/g, "\n");
    if (text !== contract.patchText) fail("the patch scenario did not produce the exact expected fixture content.");
    patchCorrect = true;
  } else if (trackedStatus) {
    fail("a read-only scenario modified tracked files.");
  }

  let passedTestCommands = 0;
  if (contract.testArgs) {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    run(command, contract.testArgs, resolve(root, "plugins", "tokengraph"));
    passedTestCommands = 1;
  }
  const telemetry = await readTelemetry(root);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    scenario: manifest.scenario,
    taskSuccess: true,
    requiredFileCount: contract.requiredFiles.length,
    recalledFileCount,
    patchCorrect,
    passedTestCommands,
    workspaceWriteOperationCount: telemetry.operationCount,
    workspaceWriteLogicalBytes: telemetry.logicalBytes,
    workspaceSampledPeakRssBytes: telemetry.sampledPeakRssBytes
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
