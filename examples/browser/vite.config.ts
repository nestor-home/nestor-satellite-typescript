import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The core does not answer cross-origin requests: the dev server forwards `/satellites` to it, so
// the page talks to its own origin. `NESTOR_CORE=http://nestor.local:7860 pnpm example`.
const core = process.env.NESTOR_CORE ?? "http://localhost:7860";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@nestor-home/satellite/qr": fileURLToPath(new URL("../../src/qr/index.ts", import.meta.url)),
      "@nestor-home/satellite": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  server: { proxy: { "/satellites": { target: core, changeOrigin: true } } },
  // Bundled when the server starts rather than discovered on the first page load (which reloads it).
  // zxing-wasm stays out: it finds its WebAssembly next to itself.
  optimizeDeps: { include: ["@fluent/bundle"], exclude: ["zxing-wasm"] },
});
