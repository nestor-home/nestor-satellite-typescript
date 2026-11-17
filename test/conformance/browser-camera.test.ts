import { join } from "node:path";
import { expect, it } from "vitest";
import { conformance, noChromium, ROOT } from "./run.js";

it.skipIf(noChromium)("a headless Chromium tab that films and can be called is conformant", async () => {
  const { code, output } = await conformance([
    "node",
    join(ROOT, "scripts/browser-satellite.mjs"),
    "--core",
    "{url}",
    "--camera",
  ]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  opens no media connection unless asked (M1)");
  expect(output).toContain("PASS  opens a media connection when asked, with what was asked (M1)");
  expect(output).toContain("PASS  sends its camera's video in the session (M1)");
  expect(output).toContain("PASS  sends its microphone in a call (M1)");
  expect(output).toContain("PASS  ends the session when told (M2)");
  expect(output).toContain("PASS  ends the session by itself after 3 s (M2)");
  expect(output).toContain("PASS  sends a still picture when asked");
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});
