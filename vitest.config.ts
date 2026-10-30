import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/conformance.test.ts"],
    testTimeout: 10_000,
  },
});
