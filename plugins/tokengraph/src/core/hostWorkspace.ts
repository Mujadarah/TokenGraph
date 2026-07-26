import { createHash } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { assertNoSymbolicLinkComponents, writeJsonAtomic } from "./storage.js";

const HOST_WORKSPACE_SCHEMA_ID = "tokengraph-host-workspace" as const;
const HOST_WORKSPACE_SCHEMA_VERSION = 1 as const;
const HOST_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const HOST_WORKSPACE_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface HostWorkspaceAttestation {
  schemaId: typeof HOST_WORKSPACE_SCHEMA_ID;
  schemaVersion: typeof HOST_WORKSPACE_SCHEMA_VERSION;
  pluginRootHash: string;
  sessionHash: string;
  root: string;
  updatedAt: string;
}

export type HostWorkspaceAttestationLoad =
  | { status: "missing" | "corrupt" | "expired" }
  | { status: "valid"; root: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function attestationIdentity(pluginRoot: string, sessionId: string): Promise<{
  path: string;
  pluginRootHash: string;
  sessionHash: string;
}> {
  if (!isIdentifier(sessionId)) throw new Error("Host session id must be non-empty.");
  if (!isAbsolute(pluginRoot)) throw new Error("Plugin root must be absolute.");
  const pluginRootHash = hash(await realpath(pluginRoot));
  const sessionHash = hash(sessionId);
  return {
    path: join(tmpdir(), "tokengraph-host-workspaces", pluginRootHash, `${sessionHash}.json`),
    pluginRootHash,
    sessionHash
  };
}

function reconstructAttestation(
  value: unknown,
  expectedPluginRootHash: string,
  expectedSessionHash: string
): HostWorkspaceAttestation | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = ["pluginRootHash", "root", "schemaId", "schemaVersion", "sessionHash", "updatedAt"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined;
  if (
    value.schemaId !== HOST_WORKSPACE_SCHEMA_ID ||
    value.schemaVersion !== HOST_WORKSPACE_SCHEMA_VERSION ||
    value.pluginRootHash !== expectedPluginRootHash ||
    value.sessionHash !== expectedSessionHash ||
    !HASH_PATTERN.test(value.pluginRootHash) ||
    !HASH_PATTERN.test(value.sessionHash) ||
    typeof value.root !== "string" ||
    !isAbsolute(value.root) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) {
    return undefined;
  }
  return {
    schemaId: HOST_WORKSPACE_SCHEMA_ID,
    schemaVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    pluginRootHash: expectedPluginRootHash,
    sessionHash: expectedSessionHash,
    root: value.root,
    updatedAt: value.updatedAt
  };
}

export async function attestHostWorkspace(
  pluginRoot: string,
  sessionId: string,
  workspaceRoot: string,
  now = new Date()
): Promise<void> {
  if (!isAbsolute(workspaceRoot)) throw new Error("Host workspace root must be absolute.");
  const [identity, root] = await Promise.all([
    attestationIdentity(pluginRoot, sessionId),
    realpath(workspaceRoot)
  ]);
  const attestation: HostWorkspaceAttestation = {
    schemaId: HOST_WORKSPACE_SCHEMA_ID,
    schemaVersion: HOST_WORKSPACE_SCHEMA_VERSION,
    pluginRootHash: identity.pluginRootHash,
    sessionHash: identity.sessionHash,
    root,
    updatedAt: now.toISOString()
  };
  await writeJsonAtomic(identity.path, attestation);
}

export async function loadHostWorkspaceAttestation(
  pluginRoot: string,
  sessionId: string,
  now = new Date()
): Promise<HostWorkspaceAttestationLoad> {
  try {
    const identity = await attestationIdentity(pluginRoot, sessionId);
    await assertNoSymbolicLinkComponents(identity.path);
    const parsed = JSON.parse(await readFile(identity.path, "utf8")) as unknown;
    const attestation = reconstructAttestation(parsed, identity.pluginRootHash, identity.sessionHash);
    if (!attestation) return { status: "corrupt" };
    const updatedAt = Date.parse(attestation.updatedAt);
    if (
      updatedAt < now.getTime() - HOST_WORKSPACE_MAX_AGE_MS ||
      updatedAt > now.getTime() + HOST_WORKSPACE_FUTURE_TOLERANCE_MS
    ) {
      return { status: "expired" };
    }
    return { status: "valid", root: attestation.root };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "corrupt" };
  }
}

export async function removeHostWorkspaceAttestation(pluginRoot: string, sessionId: string): Promise<void> {
  const identity = await attestationIdentity(pluginRoot, sessionId);
  await assertNoSymbolicLinkComponents(identity.path);
  await rm(identity.path, { force: true });
}
