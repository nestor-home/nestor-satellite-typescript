/**
 * The Nestor server's black-box conformance suite (`nestor.satellite/1`) against this SDK, through
 * the published server's `nestor satellites conformance` command: the built CLI as a speaker that
 * also writes (no body), and the browser example in a headless Chromium, talking aloud and in
 * writing only. The suite launches each once per scenario, with a fresh `{state}` folder and, for the
 * enrollment scenarios, `NESTOR_PAIRING_URI` in their environment. Run with `pnpm conformance`; needs
 * `uvx` and, for the browser, Playwright's Chromium. The server's version is pinned in
 * `.nestor-version`; `NESTOR_CONFORMANCE_FROM='../nestor[voice]'` runs a local checkout instead.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER =
  process.env.NESTOR_CONFORMANCE_FROM ??
  `nestor-home[voice]==${readFileSync(join(ROOT, ".nestor-version"), "utf8").trim()}`;

function conformance(command: string[]): Promise<{ code: number | null; output: string }> {
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

it("the Node CLI, a speaker that also writes, without a body, is conformant", async () => {
  const { code, output } = await conformance([
    "node",
    join(ROOT, "dist/node/bin.js"),
    "run",
    "--core",
    "{url}",
    "--room",
    "salon",
    "--input",
    "none",
    "--output",
    "none",
    "--token-file",
    "{state}/token.json",
    "--text",
  ]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  receives the core's audio (A1, A2)");
  expect(output).toContain("PASS  sends its microphone audio (A1, A2)");
  expect(output).toContain("PASS  acknowledges intent.text within 1 s");
  expect(output).toContain("PASS  reconnects with the same token after the core closes its link (L5)");
  expect(output).toContain("PASS  forgets a refused token and pairs again (L2, P8)");
  expect(output).toContain("PASS  offers no audio when audio is not allowed (A1)");
  expect(output).toContain("PASS  pairs with the enrollment code of NESTOR_PAIRING_URI, no code typed (P3, P4)");
  expect(output).toContain("PASS  presents a refused enrollment code (used) only once (P5)");
  expect(output).toContain("PASS  waits for Retry-After when rate-limited (P6)");
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});

const noChromium = !existsSync(chromium.executablePath());

it.skipIf(noChromium)("a headless Chromium tab that talks aloud is conformant", async () => {
  const { code, output } = await conformance(["node", join(ROOT, "scripts/browser-satellite.mjs"), "--core", "{url}"]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  keeps polling after a pending identify (I1)");
  expect(output).toContain("PASS  acknowledges intent.identify within 1 s");
  expect(output).toContain("PASS  receives the core's audio (A1, A2)");
  expect(output).toContain("PASS  sends its microphone audio (A1, A2)");
  expect(output).toContain("PASS  offers no audio when audio is not allowed (A1)");
  expect(output).toContain("PASS  pairs with the enrollment code of NESTOR_PAIRING_URI, no code typed (P3, P4)");
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});

it.skipIf(noChromium)("a headless Chromium tab that only writes is conformant, with no WebRTC", async () => {
  const { code, output } = await conformance([
    "node",
    join(ROOT, "scripts/browser-satellite.mjs"),
    "--core",
    "{url}",
    "--no-voice",
  ]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  acknowledges intent.text within 1 s");
  expect(output).not.toMatch(/^PASS .*audio/m); // nothing to check: it declares no audio
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});
