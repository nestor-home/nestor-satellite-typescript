import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/conformance/**"],
    testTimeout: 10_000,
    // files in a random order, to catch a test that leans on another; the seed is printed
    sequence: { shuffle: { files: true, tests: false } },
  },
});
