#!/usr/bin/env node
import { lstat, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const FILE_LOCK_ATTEMPTS = 200;
const FILE_LOCK_WAIT_MS = 10;
const FILE_LOCK_STALE_MS = 30_000;
const INPUT_LIMIT = 8 * 1024;

async function wait(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isTransientWindowsFsError(error) {
  return process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String(error?.code));
}

async function retryTransientWindowsFs(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsFsError(error) || attempt >= 19) throw error;
      await wait(FILE_LOCK_WAIT_MS);
    }
  }
}

async function assertNoSymbolicLinkComponents(path) {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  for (const segment of remainder) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Legacy lock path contains a symbolic link.");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

// Frozen from TokenGraph v0.23.1. Do not improve this function: the upgraded
// runtime tests must keep exercising the exact historical exclusion behavior.
async function withFileLock(lockPath, operation) {
  await assertNoSymbolicLinkComponents(lockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  await assertNoSymbolicLinkComponents(lockPath);
  for (let attempt = 0; attempt < FILE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
      }
    } catch (error) {
      if (error?.code !== "EEXIST" && !isTransientWindowsFsError(error)) throw error;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > FILE_LOCK_STALE_MS) {
          await retryTransientWindowsFs(async () => rm(lockPath, { force: true }));
        }
      } catch (lockError) {
        if (lockError?.code !== "ENOENT" && !isTransientWindowsFsError(lockError)) throw lockError;
      }
      await wait(FILE_LOCK_WAIT_MS);
    }
  }
  throw new Error("Timed out waiting for a persistence file lock.");
}

async function requestFromStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new Error("Legacy fixture input is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const request = JSON.parse(text);
  if (request === null || typeof request !== "object" ||
      typeof request.lockPath !== "string" || !isAbsolute(request.lockPath) || request.lockPath.includes("\0") ||
      typeof request.markerPath !== "string" || !isAbsolute(request.markerPath) || request.markerPath.includes("\0") ||
      !Number.isSafeInteger(request.holdMs) || request.holdMs < 0 || request.holdMs > 60_000) {
    throw new Error("Legacy fixture input is invalid.");
  }
  return request;
}

const request = await requestFromStdin();
try {
  await withFileLock(request.lockPath, async () => {
    await writeFile(request.markerPath, "entered\n", { flag: "wx", mode: 0o600 });
    if (request.holdMs > 0) await wait(request.holdMs);
  });
  process.stdout.write(`${JSON.stringify({ status: "acquired" })}\n`);
} catch (error) {
  if (error instanceof Error && error.message === "Timed out waiting for a persistence file lock.") {
    process.stdout.write(`${JSON.stringify({ status: "timeout" })}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
