import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalPersistenceLock } from "../src/core/lockDomain.js";
import { runWithFileLock } from "../src/core/fileLockLease.js";
import { withFileLock } from "../src/core/storage.js";
import { enforceStorageClassQuotas } from "../src/core/storagePolicy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native lock preactivation boundary", () => {
  it("refuses a branded production lock before addon loading or domain mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-"));
    roots.push(root);
    const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");

    await expect(runWithFileLock(lock, async () => undefined)).rejects.toMatchObject({
      code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED"
    });
    await expect(access(join(root, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes the public storage boundary through the same branded preactivation refusal", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-storage-"));
    roots.push(root);
    const lock = await canonicalPersistenceLock(root, "workspace-state", "config.json");

    await expect(withFileLock(lock, async () => undefined)).rejects.toMatchObject({
      code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED"
    });
    await expect(access(join(root, ".tokengraph"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses automatic quota cleanup before process activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokengraph-preactivation-quota-"));
    roots.push(root);
    await mkdir(join(root, ".tokengraph"), { recursive: true });
    const index = join(root, ".tokengraph", "index.json");
    await writeFile(index, "cache");

    await expect(enforceStorageClassQuotas(root, {
      maxBytes: 1024,
      runsMaxBytes: 1024,
      cacheMaxBytes: 1,
      vaultMaxBytes: 1024,
      durableMaxBytes: 1024
    })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED" });
    await expect(access(index)).resolves.toBeUndefined();
    await expect(access(join(root, ".tokengraph", ".tokengraph-native-anchor-v2.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
