import { chmod, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { resolveRepositoryStateDirectory } from "./repositoryIdentity.js";
import { runsDir, stateDir, vaultDir, wikiDir } from "./persistence.js";

export interface StorageQuota {
  maxBytes: number;
  maxFiles?: number;
}

export interface StorageUsage {
  bytes: number;
  files: number;
}

export type StorageClass = "runs" | "cache" | "vault" | "durable";
export type PurgeStorageClass = "runs" | "cache" | "outcomes" | "derived";

export interface StorageClassQuotas {
  maxBytes: number;
  runsMaxBytes: number;
  cacheMaxBytes: number;
  vaultMaxBytes: number;
  durableMaxBytes: number;
}

export interface StorageClassUsage {
  total: StorageUsage;
  runs: StorageUsage;
  cache: StorageUsage;
  vault: StorageUsage;
  durable: StorageUsage;
}

export interface StorageQuotaReport {
  usage: StorageClassUsage;
  cleaned: StorageClass[];
}

export interface PurgeStorageResult {
  class: PurgeStorageClass;
  removed: string[];
}

async function usage(path: string): Promise<StorageUsage> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`TokenGraph storage accounting refuses symbolic-link paths: ${path}`);
    if (info.isFile()) return { bytes: info.size, files: 1 };
    if (!info.isDirectory()) return { bytes: 0, files: 0 };
    const entries = await readdir(path);
    const children = await Promise.all(entries.map((entry) => usage(join(path, entry))));
    return children.reduce((total, child) => ({ bytes: total.bytes + child.bytes, files: total.files + child.files }), { bytes: 0, files: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, files: 0 };
    throw error;
  }
}

function containsPath(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

async function usageMany(paths: string[]): Promise<StorageUsage> {
  const unique = paths.map((path) => resolve(path)).filter((path, index, all) => all.indexOf(path) === index);
  const roots = unique.filter((path, index, all) => !all.some((candidate, candidateIndex) => candidateIndex !== index && containsPath(candidate, path)));
  const values = await Promise.all(roots.map((path) => usage(path)));
  return values.reduce((total, current) => ({ bytes: total.bytes + current.bytes, files: total.files + current.files }), { bytes: 0, files: 0 });
}

export async function storageUsage(root: string): Promise<StorageUsage> {
  return usageMany([stateDir(root), await resolveRepositoryStateDirectory(root)]);
}

export async function storageClassUsage(root: string): Promise<StorageClassUsage> {
  const repository = await resolveRepositoryStateDirectory(root);
  const [total, runs, cache, vault] = await Promise.all([
    storageUsage(root),
    usage(runsDir(root)),
    usageMany([join(stateDir(root), "index.json"), wikiDir(root), join(repository, "index.json"), join(repository, "artifacts")]),
    usage(vaultDir(root))
  ]);
  return {
    total,
    runs,
    cache,
    vault,
    durable: {
      bytes: Math.max(0, total.bytes - runs.bytes - cache.bytes - vault.bytes),
      files: Math.max(0, total.files - runs.files - cache.files - vault.files)
    }
  };
}

export async function enforceStorageQuota(root: string, quota: StorageQuota): Promise<StorageUsage> {
  if (!Number.isInteger(quota.maxBytes) || quota.maxBytes < 0) throw new Error("Storage maxBytes must be a non-negative integer.");
  const current = await storageUsage(root);
  if (current.bytes > quota.maxBytes || (quota.maxFiles !== undefined && current.files > quota.maxFiles)) {
    throw new Error(`TokenGraph storage quota exceeded (${current.bytes} bytes, ${current.files} files).`);
  }
  return current;
}

function assertClassQuotas(quotas: StorageClassQuotas): void {
  for (const [name, value] of Object.entries(quotas)) {
    if (!Number.isInteger(value) || value < (name === "maxBytes" ? 1 : 0)) throw new Error(`Storage ${name} must be a non-negative integer${name === "maxBytes" ? " greater than zero" : ""}.`);
  }
}

function classQuota(quotas: StorageClassQuotas, storageClass: StorageClass): number {
  return quotas[`${storageClass}MaxBytes` as keyof StorageClassQuotas];
}

function quotaExceededError(storageClass: StorageClass, current: number, maximum: number): Error {
  if (storageClass === "runs") return new Error(`TokenGraph runs storage quota exceeded (${current}/${maximum} bytes); run \`tokengraph purge --class runs\` or raise storage.runsMaxBytes.`);
  if (storageClass === "vault") return new Error(`TokenGraph vault storage quota exceeded (${current}/${maximum} bytes); explicitly purge derived projections with \`tokengraph purge --class derived\` or raise storage.vaultMaxBytes.`);
  if (storageClass === "durable") return new Error(`TokenGraph durable storage quota exceeded (${current}/${maximum} bytes); refusing the write. Review durable state or raise storage.durableMaxBytes; reviewed decisions and preferences are never purged implicitly.`);
  return new Error(`TokenGraph cache item exceeds its storage quota (${current}/${maximum} bytes); raise storage.cacheMaxBytes.`);
}

async function safeRemoveUnderBase(base: string, relativeTarget: string, recursive: boolean): Promise<boolean> {
  if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget.replaceAll("\\", "/").split("/").includes("..")) throw new Error("Storage purge target must be a safe relative path.");
  let canonicalBase: string;
  try {
    if ((await lstat(base)).isSymbolicLink()) throw new Error(`Storage purge refuses symbolic-link base paths: ${base}`);
    canonicalBase = await realpath(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const target = join(canonicalBase, relativeTarget);
  if (!containsPath(canonicalBase, target) || target === canonicalBase) throw new Error("Storage purge target escapes its approved base directory.");
  let current = canonicalBase;
  for (const segment of relativeTarget.replaceAll("\\", "/").split("/").filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Storage purge refuses symbolic-link or junction paths: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  await rm(target, { recursive, force: true });
  return true;
}

async function removeWorktreeState(root: string, relativeTarget: string, recursive: boolean, label: string): Promise<string[]> {
  const workspace = await realpath(resolve(root));
  return await safeRemoveUnderBase(workspace, join(".tokengraph", relativeTarget), recursive) ? [label] : [];
}

async function purgeCache(root: string): Promise<string[]> {
  const repository = await resolveRepositoryStateDirectory(root);
  const removed = [
    ...await removeWorktreeState(root, "index.json", false, ".tokengraph/index.json"),
    ...await removeWorktreeState(root, "wiki", true, ".tokengraph/wiki")
  ];
  if (await safeRemoveUnderBase(repository, "index.json", false)) removed.push("repository/index.json");
  if (await safeRemoveUnderBase(repository, "artifacts", true)) removed.push("repository/artifacts");
  return removed;
}

async function purgeOutcomes(root: string): Promise<string[]> {
  const directory = join(await realpath(resolve(root)), ".tokengraph", "tasks");
  const entries = await readdir(directory).catch((error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error));
  const removed: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, entry), "utf8")) as { status?: unknown };
      if (parsed.status !== "completed" && parsed.status !== "quarantined") continue;
    } catch {
      continue;
    }
    removed.push(...await removeWorktreeState(root, join("tasks", entry), false, `.tokengraph/tasks/${entry}`));
  }
  removed.push(...await removeWorktreeState(root, join("tasks", "completed-outcomes.json"), false, ".tokengraph/tasks/completed-outcomes.json"));
  return removed;
}

export async function purgeStorageClass(root: string, storageClass: PurgeStorageClass): Promise<PurgeStorageResult> {
  let removed: string[] = [];
  if (storageClass === "runs" || storageClass === "derived") removed.push(...await removeWorktreeState(root, "runs", true, ".tokengraph/runs"));
  if (storageClass === "cache" || storageClass === "derived") removed.push(...await purgeCache(root));
  if (storageClass === "outcomes" || storageClass === "derived") removed.push(...await purgeOutcomes(root));
  if (storageClass === "derived") removed.push(...await removeWorktreeState(root, "vault", true, ".tokengraph/vault"));
  return { class: storageClass, removed: [...new Set(removed)] };
}

export async function enforceStorageClassQuotas(root: string, quotas: StorageClassQuotas): Promise<StorageQuotaReport> {
  assertClassQuotas(quotas);
  let current = await storageClassUsage(root);
  const cleaned: StorageClass[] = [];
  if (current.cache.bytes > quotas.cacheMaxBytes || current.total.bytes > quotas.maxBytes) {
    if (current.cache.bytes > 0) {
      await purgeStorageClass(root, "cache");
      cleaned.push("cache");
      current = await storageClassUsage(root);
    }
  }
  for (const storageClass of ["runs", "vault", "durable"] as const) {
    const maximum = classQuota(quotas, storageClass);
    if (current[storageClass].bytes > maximum) throw quotaExceededError(storageClass, current[storageClass].bytes, maximum);
  }
  if (current.cache.bytes > quotas.cacheMaxBytes) throw quotaExceededError("cache", current.cache.bytes, quotas.cacheMaxBytes);
  if (current.total.bytes > quotas.maxBytes) throw new Error(`TokenGraph total storage quota exceeded (${current.total.bytes}/${quotas.maxBytes} bytes) after cache cleanup; explicitly purge runs, outcomes, or derived state, or raise storage.maxBytes.`);
  return { usage: current, cleaned };
}

export async function assertStorageWriteAllowed(root: string, storageClass: StorageClass, incomingBytes: number, quotas: StorageClassQuotas): Promise<StorageQuotaReport> {
  if (!Number.isInteger(incomingBytes) || incomingBytes < 0) throw new Error("Incoming storage bytes must be a non-negative integer.");
  let report = await enforceStorageClassQuotas(root, quotas);
  let projectedClassBytes = report.usage[storageClass].bytes + incomingBytes;
  if (storageClass === "cache" && projectedClassBytes > quotas.cacheMaxBytes && report.usage.cache.bytes > 0) {
    await purgeStorageClass(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [...new Set([...report.cleaned, "cache" as const])] };
    projectedClassBytes = incomingBytes;
  }
  const maximum = classQuota(quotas, storageClass);
  if (projectedClassBytes > maximum) throw quotaExceededError(storageClass, projectedClassBytes, maximum);
  let projectedTotal = report.usage.total.bytes + incomingBytes;
  if (projectedTotal > quotas.maxBytes && report.usage.cache.bytes > 0 && storageClass !== "cache") {
    await purgeStorageClass(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [...new Set([...report.cleaned, "cache" as const])] };
    projectedTotal = report.usage.total.bytes + incomingBytes;
  }
  if (projectedTotal > quotas.maxBytes) throw new Error(`TokenGraph total storage quota would be exceeded (${projectedTotal}/${quotas.maxBytes} bytes); explicitly purge storage or raise storage.maxBytes.`);
  return report;
}

export async function assertStorageReplacementAllowed(root: string, storageClass: StorageClass, replacementBytes: number, quotas: StorageClassQuotas): Promise<StorageQuotaReport> {
  if (!Number.isInteger(replacementBytes) || replacementBytes < 0) throw new Error("Replacement storage bytes must be a non-negative integer.");
  let report = await enforceStorageClassQuotas(root, quotas);
  const maximum = classQuota(quotas, storageClass);
  if (replacementBytes > maximum) throw quotaExceededError(storageClass, replacementBytes, maximum);
  let projectedTotal = report.usage.total.bytes - report.usage[storageClass].bytes + replacementBytes;
  if (projectedTotal > quotas.maxBytes && storageClass !== "cache" && report.usage.cache.bytes > 0) {
    await purgeStorageClass(root, "cache");
    report = { usage: await storageClassUsage(root), cleaned: [...new Set([...report.cleaned, "cache" as const])] };
    projectedTotal = report.usage.total.bytes - report.usage[storageClass].bytes + replacementBytes;
  }
  if (projectedTotal > quotas.maxBytes) throw new Error(`TokenGraph total storage quota would be exceeded by the replacement (${projectedTotal}/${quotas.maxBytes} bytes); explicitly purge storage or raise storage.maxBytes.`);
  return report;
}

export async function hardenStoragePermissions(root: string): Promise<void> {
  if (process.platform === "win32") return;
  for (const directory of [stateDir(root), await resolveRepositoryStateDirectory(root)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function purgeTokenGraphStorage(root: string, options: { repository?: boolean } = {}): Promise<void> {
  const repository = options.repository ? await resolveRepositoryStateDirectory(root) : undefined;
  const workspace = await realpath(resolve(root));
  await safeRemoveUnderBase(workspace, ".tokengraph", true);
  if (repository) await safeRemoveUnderBase(dirname(repository), basename(repository), true);
}

export function isConfinedStoragePath(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const relativePath = relative(base, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":") && !target.startsWith(`${base}:`));
}

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]+/gi,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/g
];

export function isInstructionLikeSourceLine(line: string): boolean {
  return /^\s*(?:ignore previous|you must\b|system message|developer message|assistant message|instructions?:|(?:agent|model|assistant)\s*:|(?:call|invoke|use|run|execute)\s+(?:the\s+)?(?:tool|function|command)\b)/i.test(line);
}

export function filterUntrustedSourceText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !isInstructionLikeSourceLine(line))
    .map((line) => SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), line))
    .join("\n");
}
