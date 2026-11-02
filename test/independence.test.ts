/**
 * The main entry point runs in browsers and needs no WebRTC: nothing it loads may reach Node, the
 * Node adapter, the voice or a WebRTC library. Its only dependency is Fluent, which runs anywhere.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);
const PLATFORM_FREE = ["@fluent/bundle"];

function imports(file: URL): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** Every module of `src/` the main entry point loads, by its path under `src/`. */
function loaded(): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const spec of imports(new URL(path, SRC))) {
      if (spec.startsWith("."))
        visit(new URL(spec.replace(/\.js$/, ".ts"), new URL(path, SRC)).href.slice(SRC.href.length));
    }
  };
  visit("index.ts");
  return [...seen].sort();
}

it("loads neither the voice, nor Node, nor the Node adapter, nor the QR reader", () => {
  const modules = loaded();
  expect(modules).toContain("satellite.ts");
  expect(modules.filter((path) => path.includes("/"))).toEqual([]);
});

it.each(loaded())("%s imports nothing but the SDK and Fluent, and no platform API", (path) => {
  const source = readFileSync(new URL(path, SRC), "utf8");
  expect(imports(new URL(path, SRC)).filter((spec) => !spec.startsWith("./") && !PLATFORM_FREE.includes(spec))).toEqual(
    [],
  );
  expect(source).not.toMatch(/\b(process|Buffer|require)\b[.(]/);
  expect(source).not.toMatch(/RTCPeerConnection|getUserMedia|AudioContext|speechSynthesis/);
});
