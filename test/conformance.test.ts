/**
 * The Nestor server's black-box conformance suite (realtime profile, `nestor.satellite/2`) against
 * this SDK, as a subprocess: the built CLI with the speaker profile (no body), and the browser
 * example in a headless Chromium. The suite launches each once per scenario, with a fresh `{state}`
 * folder and, for the enrollment scenarios, `NESTOR_PAIRING_URI` in their environment. Run with `pnpm conformance`; needs the server's Python (`NESTOR_PYTHON`, by
 * default `../nestor/.venv/bin/python`) and, for the browser, Playwright's Chromium.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PYTHON = process.env.NESTOR_PYTHON ?? join(ROOT, "../nestor/.venv/bin/python");
const hasPython = existsSync(PYTHON);

function conformance(command: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [join(ROOT, "scripts/conformance.py"), ...command], { cwd: ROOT });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.resume();
    child.on("exit", (code) => resolve({ code, output }));
  });
}

it.skipIf(!hasPython)("the Node CLI, a speaker without a body, is conformant", async () => {
  const cli = ["node", join(ROOT, "dist/node/bin.js"), "run", "--core", "{url}", "--room", "salon"];
  const { code, output } = await conformance([
    ...cli,
    "--input",
    "none",
    "--output",
    "none",
    "--token-file",
    "{state}/token.json",
  ]);
  expect(output).toContain("PASS  receives the core's audio");
  expect(output).toContain("PASS  sends its microphone audio");
  expect(output).toContain("PASS  reconnects with the same token after a hang-up");
  expect(output).toContain("PASS  pairs with the enrollment code of NESTOR_PAIRING_URI");
  expect(output).toContain("PASS  presents a refused enrollment code (used) only once");
  expect(output).toContain("PASS  waits for Retry-After when rate-limited");
  expect(output, output).toMatch(/conformant\n$/);
  expect(code).toBe(0);
});

it.skipIf(!hasPython || !existsSync(chromium.executablePath()))("a headless Chromium tab is conformant", async () => {
  const { code, output } = await conformance(["node", join(ROOT, "scripts/browser-satellite.mjs"), "--core", "{url}"]);
  expect(output).toContain("PASS  keeps polling after a pending identify (I1)");
  expect(output).toContain("PASS  acknowledges intent.identify within 1 s");
  expect(output).toContain("PASS  pairs with the enrollment code of NESTOR_PAIRING_URI");
  expect(output, output).toMatch(/conformant\n$/);
  expect(code).toBe(0);
});
