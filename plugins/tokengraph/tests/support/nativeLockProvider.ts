import { lstat } from "node:fs/promises";

import { loadNativeLockAddon, type NativeLockAddon } from "../../src/core/nativeLockAddon.js";
import { loadHarnessState } from "./externalRuntime.js";

export async function getNativeLockAddon(): Promise<NativeLockAddon> {
  if (!process.env.TOKENGRAPH_TEST_HARNESS_MANIFEST) throw new Error("Native lock test harness is unavailable.");
  const harness = await loadHarnessState();
  const assets = await lstat(harness.children.assets.path);
  const staging = await lstat(harness.children.staging.path);
  if (!assets.isDirectory() || assets.isSymbolicLink() || !staging.isDirectory() || staging.isSymbolicLink()) {
    throw new Error("Native lock test harness directories are invalid.");
  }
  return loadNativeLockAddon({
    assetsRoot: harness.children.assets.path,
    tempDirectory: harness.children.staging.path
  });
}
