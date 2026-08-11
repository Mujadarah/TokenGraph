import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const leaseImporter = realpathSync(resolve("src/core/fileLockLease.ts"));
const testProvider = resolve("tests/support/nativeLockProvider.ts");

function nativeProviderForFileLockLease(): Plugin {
  return {
    name: "tokengraph-native-provider-for-file-lock-lease",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "./nativeLockProvider.js" || !importer) return null;
      const queryFreeImporter = importer.replace(/[?#].*$/u, "");
      let canonical: string;
      try {
        canonical = realpathSync(queryFreeImporter);
      } catch {
        return null;
      }
      return canonical === leaseImporter ? testProvider : null;
    }
  };
}

export default defineConfig({
  plugins: [nativeProviderForFileLockLease()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/support/activateNativeLockRuntime.ts"],
    fileParallelism: process.platform !== "win32",
    testTimeout: process.platform === "win32" ? 30_000 : 15_000,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/native-lock-preactivation.test.ts", "tests/fixtures/**", "node_modules/**", "dist/**"]
  }
});
