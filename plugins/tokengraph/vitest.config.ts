import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: process.platform !== "win32",
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/fixtures/**", "node_modules/**", "dist/**"]
  }
});
