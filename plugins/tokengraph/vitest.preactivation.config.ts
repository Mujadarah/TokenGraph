import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/native-lock-preactivation.test.ts"],
    exclude: ["tests/fixtures/**", "node_modules/**", "dist/**"],
    fileParallelism: false
  }
});
