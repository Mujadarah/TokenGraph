import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RepositoryIdentity } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = result.stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function remoteIdentity(root: string): Promise<string | undefined> {
  const remotes = await git(root, "remote", "get-url", "--all", "origin");
  return remotes?.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort().join("\n");
}

export async function getRepositoryIdentity(root: string): Promise<RepositoryIdentity> {
  const workspaceRoot = resolve(root);
  const [topLevel, commonDir, gitDir, branch, headCommit, remote] = await Promise.all([
    git(workspaceRoot, "rev-parse", "--show-toplevel"),
    git(workspaceRoot, "rev-parse", "--git-common-dir"),
    git(workspaceRoot, "rev-parse", "--git-dir"),
    git(workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"),
    git(workspaceRoot, "rev-parse", "HEAD"),
    remoteIdentity(workspaceRoot)
  ]);
  const normalizedRoot = resolve(topLevel ?? workspaceRoot);
  const normalizedCommon = commonDir ? resolve(workspaceRoot, commonDir) : undefined;
  const normalizedGitDir = gitDir ? resolve(workspaceRoot, gitDir) : undefined;
  const repositoryKey = remote ?? normalizedCommon ?? normalizedRoot;
  const repositoryFingerprint = digest(`${repositoryKey}\n${headCommit ?? "unborn"}`);
  return {
    repositoryId: digest(repositoryKey),
    repositoryFingerprint,
    workspaceId: digest(normalizedRoot),
    worktreeId: digest(normalizedGitDir ?? normalizedRoot),
    branch: branch ?? "detached",
    headCommit: headCommit ?? "unborn",
    ...(remote ? { remoteIdentity: remote } : {})
  };
}

export async function gitCommonDirectory(root: string): Promise<string | undefined> {
  const commonDir = await git(resolve(root), "rev-parse", "--git-common-dir");
  if (!commonDir) return undefined;
  return resolve(root, commonDir);
}

export function repositoryStateDirectory(root: string, commonDirectory?: string): string {
  return commonDirectory ? join(commonDirectory, "tokengraph") : join(resolve(root), ".tokengraph", "repository");
}

export async function isGitWorkspace(root: string): Promise<boolean> {
  try {
    await access(join(resolve(root), ".git"));
    return Boolean(await git(resolve(root), "rev-parse", "--show-toplevel"));
  } catch {
    return false;
  }
}

export async function resolveRepositoryStateDirectory(root: string): Promise<string> {
  return repositoryStateDirectory(root, await gitCommonDirectory(root));
}
