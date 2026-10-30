/** The main entry point runs in browsers: nothing in it may reach Node or the Node adapter. */

import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);
const core = readdirSync(SRC).filter((name) => name.endsWith(".ts"));

it.each(core)("%s imports neither Node nor the Node adapter", (name) => {
  const source = readFileSync(new URL(name, SRC), "utf8");
  const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  expect(imports.filter((spec) => !spec?.startsWith("./"))).toEqual([]);
  expect(source).not.toMatch(/\b(process|Buffer|require)\b[.(]/);
});
