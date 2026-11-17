import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/conformance/**"],
    testTimeout: 10_000,
  },
});
