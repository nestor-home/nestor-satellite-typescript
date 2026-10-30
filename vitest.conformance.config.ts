import { defineConfig } from "vitest/config";

// The server's black-box suite against the built CLI and the browser example (`pnpm conformance`).
export default defineConfig({
  test: { include: ["test/conformance.test.ts"], testTimeout: 180_000, hookTimeout: 60_000 },
});
