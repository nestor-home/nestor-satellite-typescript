/**
 * The Nestor server's black-box conformance suite (`nestor.satellite/1`) against this SDK, through
 * the published server's `nestor satellites conformance` command: the built CLI as a speaker that
 * also writes (no body), and the browser example in a headless Chromium, talking aloud, filming with
 * Chromium's fake camera, and in writing only. One test file per satellite, so CI runs them side by
 * side. The suite launches each once per scenario, with a fresh `{state}` folder and, for the
 * enrollment scenarios, `NESTOR_PAIRING_URI` in their environment. Run with `pnpm conformance`; needs
 * `uvx` and, for the browser, Playwright's Chromium. The server's version is pinned in
 * `.nestor-version`; `NESTOR_CONFORMANCE_FROM='../nestor[voice,media]'` runs a local checkout instead.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER =
  process.env.NESTOR_CONFORMANCE_FROM ??
  `nestor-home[voice,media]==${readFileSync(join(ROOT, ".nestor-version"), "utf8").trim()}`;

export function conformance(command: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "uvx",
      ["--from", SERVER, "nestor", "satellites", "conformance", "--deadline", "20", "--", ...command],
      { cwd: ROOT, env: { ...process.env, LC_ALL: "en_US.UTF-8" } },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

/** Without Playwright's Chromium, the browser satellites are skipped. */
export const noChromium = !existsSync(chromium.executablePath());
