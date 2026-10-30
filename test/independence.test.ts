/**
 * The main entry point runs in browsers: nothing in it may reach Node or the Node adapter. Its only
 * dependency is Fluent, which runs anywhere.
 */

import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);
const core = readdirSync(SRC).filter((name) => name.endsWith(".ts"));
const PLATFORM_FREE = ["@fluent/bundle"];

it.each(core)("%s imports neither Node nor the Node adapter", (name) => {
  const source = readFileSync(new URL(name, SRC), "utf8");
  const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  expect(imports.filter((spec) => !spec?.startsWith("./") && !PLATFORM_FREE.includes(spec ?? ""))).toEqual([]);
  expect(source).not.toMatch(/\b(process|Buffer|require)\b[.(]/);
});
