import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { parseProjectFileText } from "./fileScanner.js";
import { EXACT_SLICE_MAX_BYTES, EXACT_SLICE_MAX_LINES, EXACT_SLICE_MAX_SOURCE_BYTES } from "./retrieval.js";
import { resolveConfinedPath } from "./storage.js";
import type { ChangeEntry, ChangeProvenance, ChangeSlice, ChangeSource, ChangeStatus, ChangeSymbol, LocalChangeSnapshot } from "./types.js";

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CHANGE_ENTRIES = 1_024;
const MAX_CHANGE_SYMBOLS = 4_096;
const MAX_CHANGE_SLICES = 256;
const MAX_CHANGE_SLICE_BYTES = 512 * 1024;

interface GitResult {
  exitCode: number | null;
  stdout: Buffer;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnFailed: boolean;
}

interface TargetContent {
  entryTarget: ChangeEntry["target"];
  text?: string;
}

interface ChangeBudget {
  entries: number;
  symbols: number;
  slices: number;
  sliceBytes: number;
}

function normalizedText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRepositoryPath(value: string): string {
  const path = value;
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Local Git returned an unsafe repository path.");
  }
  return path;
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function createChangeBudget(): ChangeBudget {
  return { entries: 0, symbols: 0, slices: 0, sliceBytes: 0 };
}

function runGit(root: string, args: string[], maxOutputBytes = MAX_GIT_OUTPUT_BYTES): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdoutBytes = 0;
    const chunks: Buffer[] = [];
    const settle = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn("git", args, { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolvePromise({ exitCode: null, stdout: Buffer.alloc(0), timedOut: false, outputLimitExceeded: false, spawnFailed: true });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => settle({ exitCode: null, stdout: Buffer.concat(chunks), timedOut, outputLimitExceeded, spawnFailed: true }));
    child.once("close", (exitCode) => settle({ exitCode, stdout: Buffer.concat(chunks), timedOut, outputLimitExceeded, spawnFailed: false }));
  });
}

async function requiredGit(root: string, args: string[], operation: string, maxOutputBytes = MAX_GIT_OUTPUT_BYTES): Promise<Buffer> {
  const result = await runGit(root, args, maxOutputBytes);
  if (result.spawnFailed) throw new Error(`Local Git is unavailable while ${operation}.`);
  if (result.timedOut) throw new Error(`Local Git timed out while ${operation}.`);
  if (result.outputLimitExceeded) throw new Error(`Local Git output exceeded the bounded limit while ${operation}.`);
  if (result.exitCode !== 0) throw new Error(`Local Git failed while ${operation}.`);
  return result.stdout;
}

async function assertRepository(root: string): Promise<void> {
  const output = await requiredGit(root, ["rev-parse", "--is-inside-work-tree"], "checking the repository", 1024);
  if (output.toString("utf8").trim() !== "true") throw new Error("Local Git repository is unavailable.");
}

async function resolveCommit(root: string, ref: string, role: string): Promise<string> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], 1024);
  const commit = result.stdout.toString("utf8").trim();
  if (result.spawnFailed || result.timedOut || result.outputLimitExceeded || result.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new Error(`Local Git ${role} ref is unavailable: ${JSON.stringify(ref)}.`);
  }
  return commit.toLowerCase();
}

async function commitParent(root: string, commit: string): Promise<string | undefined> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^`], 1024);
  const parent = result.stdout.toString("utf8").trim();
  if (result.spawnFailed || result.timedOut || result.outputLimitExceeded) throw new Error("Local Git could not read the commit parent.");
  if (result.exitCode !== 0) return undefined;
  if (!/^[a-f0-9]{40,64}$/i.test(parent)) throw new Error("Local Git returned invalid commit-parent data.");
  return parent.toLowerCase();
}

async function optionalHeadCommit(root: string): Promise<string | undefined> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 1024);
  const commit = result.stdout.toString("utf8").trim();
  return result.exitCode === 0 && /^[a-f0-9]{40,64}$/i.test(commit) ? commit.toLowerCase() : undefined;
}

async function uniqueMergeBase(root: string, base: string, head: string, kind: "range" | "pull-request"): Promise<string> {
  const result = await runGit(root, ["merge-base", "--all", base, head], 4 * 1024);
  if (result.spawnFailed || result.timedOut || result.outputLimitExceeded || result.exitCode !== 0) {
    throw new Error(`Local Git cannot identify the merge base for ${kind}.`);
  }
  const candidates = result.stdout.toString("utf8").split(/\r?\n/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (candidates.length !== 1 || !/^[a-f0-9]{40,64}$/.test(candidates[0]!)) {
    throw new Error(`Local Git cannot identify a unique merge base for ${kind}.`);
  }
  return candidates[0]!;
}

function statusFor(code: string): ChangeStatus {
  switch (code) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

function parseNameStatus(output: Buffer, provenance: ChangeProvenance): ChangeEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: ChangeEntry[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const rawStatus = fields[index++];
    if (!rawStatus) continue;
    const code = rawStatus[0] ?? "";
    const renamedOrCopied = code === "R" || code === "C";
    const previousPath = renamedOrCopied ? fields[index++] : undefined;
    const nextPath = fields[index++];
    if (nextPath === undefined || (renamedOrCopied && previousPath === undefined)) throw new Error("Local Git returned malformed NUL-delimited change data.");
    entries.push({
      path: safeRepositoryPath(nextPath),
      status: statusFor(code),
      provenance,
      ...(previousPath === undefined ? {} : { previousPath: safeRepositoryPath(previousPath) }),
      target: { status: code === "D" ? "missing" : code === "U" ? "unmerged" : "missing" }
    });
  }
  return entries;
}

async function comparedEntries(root: string, base: string, target: string, provenance: ChangeProvenance): Promise<ChangeEntry[]> {
  const output = await requiredGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--name-status", "-z", base, target, "--"],
    "reading NUL-delimited commit changes"
  );
  return parseNameStatus(output, provenance);
}

async function rootCommitEntries(root: string, target: string): Promise<ChangeEntry[]> {
  const output = await requiredGit(
    root,
    ["diff-tree", "--root", "--no-commit-id", "-r", "--no-ext-diff", "--no-textconv", "--name-status", "-z", target],
    "reading NUL-delimited root-commit changes"
  );
  return parseNameStatus(output, "commit");
}

async function stagedEntries(root: string): Promise<ChangeEntry[]> {
  const output = await requiredGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--cached", "--name-status", "-z", "--"],
    "reading NUL-delimited staged changes"
  );
  return parseNameStatus(output, "staged");
}

async function unstagedEntries(root: string): Promise<ChangeEntry[]> {
  const output = await requiredGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--name-status", "-z", "--"],
    "reading NUL-delimited unstaged changes"
  );
  return parseNameStatus(output, "unstaged");
}

async function untrackedEntries(root: string): Promise<ChangeEntry[]> {
  const output = await requiredGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], "reading NUL-delimited untracked changes");
  return output.toString("utf8").split("\0").filter(Boolean).map((path) => ({
    path: safeRepositoryPath(path),
    status: "added" as const,
    provenance: "untracked" as const,
    target: { status: "missing" as const }
  }));
}

async function targetBlob(root: string, commit: string, path: string): Promise<{ blob: string; bytes: number } | undefined> {
  const output = await requiredGit(root, ["ls-tree", "-z", commit, "--", literalPathspec(path)], "reading the target tree", 16 * 1024);
  const record = output.toString("utf8").split("\0").find(Boolean);
  if (!record) return undefined;
  const tab = record.indexOf("\t");
  if (tab < 0) throw new Error("Local Git returned malformed target-tree data.");
  const [mode, type, blob] = record.slice(0, tab).split(" ");
  if (!mode || type !== "blob" || !/^[a-f0-9]{40,64}$/i.test(blob ?? "")) return undefined;
  return { blob: blob!.toLowerCase(), bytes: await blobSize(root, blob!) };
}

async function blobSize(root: string, blob: string): Promise<number> {
  const sizeOutput = await requiredGit(root, ["cat-file", "-s", blob!], "reading target blob metadata", 1024);
  const bytes = Number.parseInt(sizeOutput.toString("utf8").trim(), 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Local Git returned invalid target blob metadata.");
  return bytes;
}

async function blobContent(root: string, blob: string, bytes: number): Promise<TargetContent> {
  if (bytes > EXACT_SLICE_MAX_SOURCE_BYTES) return { entryTarget: { status: "too-large", blob, bytes } };
  const content = await requiredGit(root, ["cat-file", "blob", blob], "reading the target blob", EXACT_SLICE_MAX_SOURCE_BYTES);
  if (content.includes(0)) return { entryTarget: { status: "binary", blob, bytes: content.byteLength } };
  const text = content.toString("utf8");
  return {
    entryTarget: { status: "available", blob, bytes: content.byteLength, contentHash: sha256(normalizedText(text)) },
    text
  };
}

async function commitTargetContent(root: string, commit: string, path: string): Promise<TargetContent> {
  const blob = await targetBlob(root, commit, path);
  if (!blob) return { entryTarget: { status: "missing" } };
  return blobContent(root, blob.blob, blob.bytes);
}

async function stagedTargetContent(root: string, path: string): Promise<TargetContent> {
  const output = await requiredGit(root, ["ls-files", "--stage", "-z", "--", literalPathspec(path)], "reading staged target metadata", 16 * 1024);
  const record = output.toString("utf8").split("\0").find((value) => /\s0\t/.test(value));
  if (!record) return { entryTarget: { status: "missing" } };
  const tab = record.indexOf("\t");
  const [mode, blob, stage] = record.slice(0, tab).split(" ");
  if (!mode || stage !== "0" || !/^[a-f0-9]{40,64}$/i.test(blob ?? "")) return { entryTarget: { status: "unmerged" } };
  return blobContent(root, blob!.toLowerCase(), await blobSize(root, blob!));
}

async function workingTreeTargetContent(root: string, path: string): Promise<TargetContent> {
  let handle;
  try {
    handle = await open(await resolveConfinedPath(root, path), "r");
    const buffer = Buffer.alloc(EXACT_SLICE_MAX_SOURCE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > EXACT_SLICE_MAX_SOURCE_BYTES) return { entryTarget: { status: "too-large", bytes: bytesRead } };
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) return { entryTarget: { status: "binary", bytes: content.byteLength } };
    const text = content.toString("utf8");
    return { entryTarget: { status: "available", bytes: content.byteLength, contentHash: sha256(normalizedText(text)) }, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entryTarget: { status: "missing" } };
    throw error;
  } finally {
    await handle?.close();
  }
}

function hunkRanges(patch: string): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  const expression = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of patch.matchAll(expression)) {
    const startLine = Number.parseInt(match[1]!, 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(count) || startLine < 1 || count < 1) continue;
    ranges.push({ startLine, endLine: startLine + count - 1 });
  }
  return ranges;
}

async function comparedPatchRanges(root: string, base: string, target: string, path: string): Promise<Array<{ startLine: number; endLine: number }>> {
  const output = await requiredGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--unified=0", base, target, "--", literalPathspec(path)],
    "reading target patch data"
  );
  return hunkRanges(output.toString("utf8"));
}

async function rootCommitPatchRanges(root: string, target: string, path: string): Promise<Array<{ startLine: number; endLine: number }>> {
  const output = await requiredGit(
    root,
    ["show", "--format=", "--root", "--no-ext-diff", "--no-textconv", "--unified=0", target, "--", literalPathspec(path)],
    "reading root-commit target patch data"
  );
  return hunkRanges(output.toString("utf8"));
}

async function stagedPatchRanges(root: string, path: string): Promise<Array<{ startLine: number; endLine: number }>> {
  const output = await requiredGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--cached", "--unified=0", "--", literalPathspec(path)],
    "reading staged target patch data"
  );
  return hunkRanges(output.toString("utf8"));
}

async function workingTreePatchRanges(root: string, path: string): Promise<Array<{ startLine: number; endLine: number }>> {
  const output = await requiredGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--unified=0", "--", literalPathspec(path)],
    "reading unstaged target patch data"
  );
  return hunkRanges(output.toString("utf8"));
}

function boundedSlices(path: string, provenance: ChangeProvenance, text: string, ranges: Array<{ startLine: number; endLine: number }>): ChangeSlice[] {
  const normalized = normalizedText(text);
  const lines = normalized.split("\n");
  const contentHash = sha256(normalized);
  const slices: ChangeSlice[] = [];
  for (const range of ranges) {
    const startLine = Math.min(range.startLine, lines.length);
    const requestedEnd = Math.min(range.endLine, startLine + EXACT_SLICE_MAX_LINES - 1, lines.length);
    const selected: string[] = [];
    let bytes = 0;
    for (let line = startLine; line <= requestedEnd; line += 1) {
      const next = lines[line - 1] ?? "";
      const addition = Buffer.byteLength(selected.length ? `\n${next}` : next, "utf8");
      if (bytes + addition > EXACT_SLICE_MAX_BYTES) break;
      selected.push(next);
      bytes += addition;
    }
    if (!selected.length) continue;
    const endLine = startLine + selected.length - 1;
    const sliceText = selected.join("\n");
    slices.push({
      path,
      provenance,
      startLine,
      endLine,
      text: sliceText,
      hash: sha256(JSON.stringify({ path, startLine, endLine, text: sliceText })),
      contentHash,
      ...(endLine < range.endLine ? { truncated: true as const } : {})
    });
  }
  return slices;
}

async function enrichEntries(
  initialEntries: ChangeEntry[],
  loadTarget: (path: string) => Promise<TargetContent>,
  loadRanges: (path: string, text: string) => Promise<Array<{ startLine: number; endLine: number }>>,
  budget: ChangeBudget
): Promise<{ entries: ChangeEntry[]; symbols: ChangeSymbol[]; slices: ChangeSlice[] }> {
  if (budget.entries + initialEntries.length > MAX_CHANGE_ENTRIES) {
    throw new Error(`Local change source exceeds the ${MAX_CHANGE_ENTRIES}-entry capsule limit.`);
  }
  budget.entries += initialEntries.length;
  const entries: ChangeEntry[] = [];
  const symbols: ChangeSymbol[] = [];
  const slices: ChangeSlice[] = [];
  for (const initial of initialEntries) {
    const target = initial.status === "deleted" || initial.status === "unmerged"
      ? { entryTarget: initial.target }
      : await loadTarget(initial.path);
    const entry = { ...initial, target: target.entryTarget };
    entries.push(entry);
    if (!target.text || !entry.target.contentHash) continue;
    const parsed = await parseProjectFileText(entry.path, target.text);
    const parsedSymbols = (parsed?.symbols ?? []).map((symbol) => ({ ...symbol, changeProvenance: entry.provenance, contentHash: entry.target.contentHash! }));
    if (budget.symbols + parsedSymbols.length > MAX_CHANGE_SYMBOLS) {
      throw new Error(`Local change source exceeds the ${MAX_CHANGE_SYMBOLS}-symbol capsule limit.`);
    }
    budget.symbols += parsedSymbols.length;
    symbols.push(...parsedSymbols);
    const ranges = await loadRanges(entry.path, target.text);
    const entrySlices = boundedSlices(entry.path, entry.provenance, target.text, ranges);
    const entrySliceBytes = entrySlices.reduce((total, slice) => total + Buffer.byteLength(slice.text, "utf8"), 0);
    if (budget.slices + entrySlices.length > MAX_CHANGE_SLICES || budget.sliceBytes + entrySliceBytes > MAX_CHANGE_SLICE_BYTES) {
      throw new Error(`Local change source exceeds the bounded capsule slice budget (${MAX_CHANGE_SLICES} slices or ${MAX_CHANGE_SLICE_BYTES} bytes).`);
    }
    budget.slices += entrySlices.length;
    budget.sliceBytes += entrySliceBytes;
    slices.push(...entrySlices);
  }
  return { entries, symbols, slices };
}

function finalizeSnapshot(source: LocalChangeSnapshot["source"], parts: Array<{ entries: ChangeEntry[]; symbols: ChangeSymbol[]; slices: ChangeSlice[] }>): LocalChangeSnapshot {
  const entries = parts.flatMap((part) => part.entries);
  const symbols = parts.flatMap((part) => part.symbols);
  const slices = parts.flatMap((part) => part.slices);
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.provenance.localeCompare(right.provenance));
  symbols.sort((left, right) => left.filePath.localeCompare(right.filePath) || (left.startLine ?? 0) - (right.startLine ?? 0) || left.name.localeCompare(right.name) || left.changeProvenance.localeCompare(right.changeProvenance));
  slices.sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.provenance.localeCompare(right.provenance));
  return {
    source,
    entries,
    changedFiles: Array.from(new Set(entries.map((entry) => entry.path))).sort((left, right) => left.localeCompare(right)),
    symbols,
    slices
  };
}

export async function resolveLocalChangeSnapshot(root: string, source: ChangeSource): Promise<LocalChangeSnapshot> {
  await assertRepository(root);
  const budget = createChangeBudget();
  if (source.kind === "commit") {
    const targetCommit = await resolveCommit(root, source.ref, "commit");
    const baseCommit = await commitParent(root, targetCommit);
    const entries = baseCommit === undefined
      ? await rootCommitEntries(root, targetCommit)
      : await comparedEntries(root, baseCommit, targetCommit, "commit");
    const part = await enrichEntries(
      entries,
      (path) => commitTargetContent(root, targetCommit, path),
      (path) => baseCommit === undefined
        ? rootCommitPatchRanges(root, targetCommit, path)
        : comparedPatchRanges(root, baseCommit, targetCommit, path),
      budget
    );
    return finalizeSnapshot({ kind: "commit", ref: source.ref, ...(baseCommit ? { baseCommit } : {}), targetCommit }, [part]);
  }

  if (source.kind === "staged") {
    const headCommit = await optionalHeadCommit(root);
    const part = await enrichEntries(
      await stagedEntries(root),
      (path) => stagedTargetContent(root, path),
      (path) => stagedPatchRanges(root, path),
      budget
    );
    return finalizeSnapshot({ kind: "staged", ...(headCommit ? { headCommit } : {}) }, [part]);
  }

  if (source.kind === "working-tree") {
    const headCommit = await optionalHeadCommit(root);
    const staged = await enrichEntries(
      await stagedEntries(root),
      (path) => stagedTargetContent(root, path),
      (path) => stagedPatchRanges(root, path),
      budget
    );
    const unstaged = await enrichEntries(
      await unstagedEntries(root),
      (path) => workingTreeTargetContent(root, path),
      (path) => workingTreePatchRanges(root, path),
      budget
    );
    const untracked = await enrichEntries(
      await untrackedEntries(root),
      (path) => workingTreeTargetContent(root, path),
      async (_path, text) => [{ startLine: 1, endLine: normalizedText(text).split("\n").length }],
      budget
    );
    return finalizeSnapshot({ kind: "working-tree", ...(headCommit ? { headCommit } : {}) }, [staged, unstaged, untracked]);
  }

  if (source.kind === "range" || source.kind === "pull-request") {
    const baseRef = source.kind === "range" ? source.base : source.baseRef;
    const headRef = source.kind === "range" ? source.head : source.headRef;
    const baseCommit = await resolveCommit(root, baseRef, "base");
    const targetCommit = await resolveCommit(root, headRef, "head");
    const mergeBase = await uniqueMergeBase(root, baseCommit, targetCommit, source.kind);
    const provenance: ChangeProvenance = source.kind;
    const part = await enrichEntries(
      await comparedEntries(root, mergeBase, targetCommit, provenance),
      (path) => commitTargetContent(root, targetCommit, path),
      (path) => comparedPatchRanges(root, mergeBase, targetCommit, path),
      budget
    );
    const identity = source.kind === "range"
      ? { kind: "range" as const, base: source.base, head: source.head, baseCommit, targetCommit, mergeBase }
      : { kind: "pull-request" as const, baseRef: source.baseRef, headRef: source.headRef, baseCommit, targetCommit, mergeBase };
    return finalizeSnapshot(identity, [part]);
  }

  throw new Error("Local change source is unsupported.");
}
