import { loadNativeLockAddon, type NativeLockAddon } from "./nativeLockAddon.js";

export function getNativeLockAddon(): Promise<NativeLockAddon> {
  return loadNativeLockAddon();
}
