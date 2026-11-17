import { defineConfig } from "vitest/config";

// The server's black-box suite against the built CLI and the browser example (`pnpm conformance`),
// one file per satellite, one after the other (CI runs each file in its own job).
export default defineConfig({
  test: {
    include: ["test/conformance/*.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
